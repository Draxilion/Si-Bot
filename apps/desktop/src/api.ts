import type { Activity, AttachmentMeta, Bot, BotInput, ChatEvent, ChatRequest, Fact, LibraryItem, Message, ModelOption, Task } from '@si-bot/shared'

export interface Connection {
  url: string
  token: string
}

const KEY = 'si.connection'

// Defaults for a local install, from apps/desktop/.env.local (VITE_SIBOT_URL, VITE_SIBOT_TOKEN).
const fallback: Connection = {
  url: import.meta.env.VITE_SIBOT_URL || 'http://localhost:8787',
  token: import.meta.env.VITE_SIBOT_TOKEN || '',
}

export function loadConnection(): Connection {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    // A saved connection without a token was never set up, so the local defaults win.
    if (saved?.url && saved.token) return saved
  } catch {}
  return fallback
}

export function saveConnection(c: Connection) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {}
}

export class Api {
  private conn: Connection
  constructor(conn: Connection) {
    this.conn = conn
  }

  private base() {
    return this.conn.url.replace(/\/$/, '')
  }

  /** fetch with the token, turning network failures into errors that say what to fix. */
  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.conn.token) throw new Error('Not connected yet: add your server address and access token in Settings')
    try {
      return await fetch(this.base() + path, {
        ...init,
        headers: {
          authorization: `Bearer ${this.conn.token}`,
          ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        },
      })
    } catch (e: any) {
      // WebKit says "Load failed", Chromium "Failed to fetch": the server is down or the address is wrong.
      if (e?.name === 'AbortError') throw e
      throw new Error(`Can't reach the Si server at ${this.base()}. Check that it's running and the address in Settings.`)
    }
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(path, init)
    if (!res.ok) {
      if (res.status === 401) throw new Error('Wrong access token')
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `Server error ${res.status}`)
    }
    return res.json()
  }

  models = () => this.req<{ models: ModelOption[]; default: string | null }>('/api/models')
  messages = (botId: number, before?: number) =>
    this.req<{ messages: Message[] }>(`/api/messages?bot=${botId}${before ? `&before=${before}` : ''}`)
  newer = (botId: number, after: number) => this.req<{ messages: Message[] }>(`/api/messages?bot=${botId}&after=${after}`)
  bots = () => this.req<{ bots: Bot[] }>('/api/bots')
  createBot = (b: BotInput) => this.req<{ bot: Bot; bots: Bot[] }>('/api/bots', { method: 'POST', body: JSON.stringify(b) })
  updateBot = (id: number, b: BotInput) =>
    this.req<{ bot: Bot; bots: Bot[] }>(`/api/bots/${id}`, { method: 'PATCH', body: JSON.stringify(b) })
  deleteBot = (id: number) => this.req<{ bots: Bot[] }>(`/api/bots/${id}`, { method: 'DELETE' })
  library = (id: number) => this.req<{ items: LibraryItem[] }>(`/api/bots/${id}/library`)
  activity = (id: number) => this.req<{ items: Activity[] }>(`/api/bots/${id}/activity`)
  search = (q: string) => this.req<{ messages: (Message & { snippet: string })[] }>(`/api/search?q=${encodeURIComponent(q)}`)
  context = (botId: number) =>
    this.req<{ notes: string; digest: { text: string; upToId: number; updatedAt: string } | null }>(`/api/context?bot=${botId}`)
  saveContext = (botId: number, body: { notes?: string; digest?: string }) =>
    this.req<{ notes: string; digest: { text: string; upToId: number; updatedAt: string } | null }>(`/api/context?bot=${botId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  tasks = (botId?: number) => this.req<{ tasks: Task[] }>(`/api/tasks${botId ? `?bot=${botId}` : ''}`)
  addTask = (t: { botId?: number; title: string; prompt: string; cron?: string; runAt?: string; timezone?: string }) =>
    this.req<{ tasks: Task[] }>('/api/tasks', { method: 'POST', body: JSON.stringify(t) })
  setTaskEnabled = (id: number, enabled: boolean) =>
    this.req<{ tasks: Task[] }>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
  runTask = (id: number) => this.req<{ ok: boolean }>(`/api/tasks/${id}/run`, { method: 'POST' })
  deleteTask = (id: number) => this.req<{ tasks: Task[] }>(`/api/tasks/${id}`, { method: 'DELETE' })
  upload = (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return this.req<{ file: AttachmentMeta }>('/api/files', { method: 'POST', body: form })
  }
  fileUrl = (id: number) => `${this.base()}/api/files/${id}?token=${encodeURIComponent(this.conn.token)}`
  facts = () => this.req<{ facts: Fact[] }>('/api/memory')
  addFact = (text: string) => this.req<{ facts: Fact[] }>('/api/memory', { method: 'POST', body: JSON.stringify({ text }) })
  deleteFact = (id: number) => this.req<{ facts: Fact[] }>(`/api/memory/${id}`, { method: 'DELETE' })

  /** Streams a reply; calls onEvent for each server-sent event. */
  async chat(body: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) {
    const res = await this.send('/api/chat', { method: 'POST', signal, body: JSON.stringify(body) })
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `Server error ${res.status}`)
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'))
        if (line) onEvent(JSON.parse(line.slice(5)))
      }
    }
  }
}
