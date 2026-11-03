import type { ChatEvent, ChatRequest, Fact, Message, ModelOption } from '@si-bot/shared'

export interface Connection {
  url: string
  token: string
}

const KEY = 'si.connection'

export function loadConnection(): Connection {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (saved?.url) return saved
  } catch {}
  return { url: 'http://localhost:8787', token: '' }
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

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.base() + path, {
      ...init,
      headers: { authorization: `Bearer ${this.conn.token}`, 'content-type': 'application/json' },
    })
    if (!res.ok) throw new Error(res.status === 401 ? 'Wrong access token' : `Server error ${res.status}`)
    return res.json()
  }

  models = () => this.req<{ models: ModelOption[]; default: string | null }>('/api/models')
  messages = () => this.req<{ messages: Message[] }>('/api/messages')
  facts = () => this.req<{ facts: Fact[] }>('/api/memory')
  addFact = (text: string) => this.req<{ facts: Fact[] }>('/api/memory', { method: 'POST', body: JSON.stringify({ text }) })
  deleteFact = (id: number) => this.req<{ facts: Fact[] }>(`/api/memory/${id}`, { method: 'DELETE' })

  /** Streams a reply; calls onEvent for each server-sent event. */
  async chat(body: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) {
    const res = await fetch(this.base() + '/api/chat', {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${this.conn.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
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
