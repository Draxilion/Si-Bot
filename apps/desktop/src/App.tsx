import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentMeta, Bot, Message, ModelOption, Task } from '@si-bot/shared'
import { Api, loadConnection, saveConnection, type Connection } from './api'
import { Icon } from './icons'
import { AssistantMessage, BotsContext, UserMessage, type LiveReply } from './Message'
import { Composer } from './Composer'
import { setFileResolver } from './Markdown'
import { Avatar, randomAvatar, setAvatarFileResolver } from './Avatar'
import { Sidebar, type Page } from './Sidebar'
import { BotPanel } from './BotPanel'
import { DayDivider, MemoryView, SearchView, SettingsView, TasksView } from './Pages'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

function usePref<T>(key: string, initial: T): [T, (v: T | ((cur: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return s === null ? initial : (JSON.parse(s) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T | ((cur: T) => T)) =>
      setV((cur) => {
        const value = typeof next === 'function' ? (next as (c: T) => T)(cur) : next
        try {
          localStorage.setItem(key, JSON.stringify(value))
        } catch {}
        return value
      }),
    [key],
  )
  return [v, set]
}

const label = (b: Bot) => (b.role ? `${b.name} · ${b.role}` : b.name)

interface SendOpts {
  text?: string
  files?: AttachmentMeta[]
  replaceFrom?: number
  regenerate?: boolean
}

export default function App() {
  const [conn, setConn] = useState<Connection>(loadConnection)
  const api = useMemo(() => new Api(conn), [conn])
  setFileResolver(api.fileUrl)
  setAvatarFileResolver(api.fileUrl)

  const [bots, setBots] = useState<Bot[]>([])
  const [activeId, setActiveId] = usePref<number | null>('si.bot', null)
  const [page, setPage] = useState<Page | null>(conn.token ? null : 'settings')
  const [panelOpen, setPanelOpen] = usePref('si.panel', window.innerWidth > 1100)
  const [read, setRead] = usePref<Record<string, number>>('si.read', {})
  const [me, setMe] = usePref('si.me', '')
  const [models, setModels] = useState<ModelOption[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [timelines, setTimelines] = useState<Record<number, Message[]>>({})
  const [hasOlder, setHasOlder] = useState<Record<number, boolean>>({})
  const [think, setThink] = usePref('si.think', false)
  const [deep, setDeep] = usePref('si.deep', false)
  const [live, setLive] = useState<{ botId: number; reply: LiveReply } | null>(null)
  const [suggestions, setSuggestions] = useState<{ botId: number; list: string[] } | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState<{ botId: number; text: string } | null>(null)
  const [newBot, setNewBot] = useState(false)
  const [version, setVersion] = useState(0)
  const abort = useRef<AbortController | null>(null)

  const bot = bots.find((b) => b.id === activeId) ?? bots[0]
  const messages = (bot && timelines[bot.id]) ?? []

  const refreshBots = useCallback(async () => {
    const r = await api.bots()
    setBots(r.bots)
    return r.bots
  }, [api])

  useEffect(() => {
    if (!conn.token) return
    Promise.all([refreshBots(), api.models(), api.tasks()])
      .then(([, m, t]) => {
        setModels(m.models)
        setDefaultModel(m.default ?? '')
        setTasks(t.tasks)
        setError(null)
      })
      .catch((e) => setError({ botId: 0, text: e.message === 'Failed to fetch' ? `Can't reach ${conn.url}` : e.message }))
  }, [api, conn, refreshBots])

  // Load a bot's timeline the first time it is opened.
  useEffect(() => {
    if (!bot || timelines[bot.id]) return
    api.messages(bot.id).then(
      (r) => {
        setTimelines((t) => ({ ...t, [bot.id]: r.messages }))
        setHasOlder((h) => ({ ...h, [bot.id]: r.messages.length === 100 }))
      },
      () => {},
    )
  }, [api, bot, timelines])

  // Opening a bot marks it read.
  const lastId = messages.at(-1)?.id ?? 0
  useEffect(() => {
    if (bot && !page && lastId && (read[bot.id] ?? 0) < lastId) setRead((r) => ({ ...r, [bot.id]: lastId }))
  }, [bot, page, lastId, read, setRead])

  // Other bots keep working (tasks, messages from bots): poll the sidebar and the open timeline.
  useEffect(() => {
    if (!conn.token) return
    const timer = setInterval(async () => {
      try {
        const fresh = await refreshBots()
        if (bot && !live) {
          const newest = fresh.find((b) => b.id === bot.id)?.lastMessage?.id ?? 0
          if (newest > lastId) {
            const { messages: more } = await api.newer(bot.id, lastId)
            setTimelines((t) => ({ ...t, [bot.id]: [...(t[bot.id] ?? []), ...more.filter((m) => !(t[bot.id] ?? []).some((x) => x.id === m.id))] }))
            setVersion((v) => v + 1)
          }
        }
        // Notify about new task results in other bots while the window is hidden.
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          for (const b of fresh) {
            const lm = b.lastMessage
            if (lm && lm.role === 'assistant' && lm.id > (read[b.id] ?? 0) && lm.id > (notified.current[b.id] ?? 0)) {
              notified.current[b.id] = lm.id
              new Notification(label(b), { body: lm.preview })
            }
          }
        }
      } catch {}
    }, 12_000)
    return () => clearInterval(timer)
  }, [api, conn.token, bot, live, lastId, refreshBots, read])
  const notified = useRef<Record<number, number>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') abort.current?.abort()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setTimeline = (id: number, fn: (m: Message[]) => Message[]) => setTimelines((t) => ({ ...t, [id]: fn(t[id] ?? []) }))

  async function send(target: Bot, opts: SendOpts) {
    const id = target.id
    setError(null)
    setSuggestions(null)
    if (opts.replaceFrom) setTimeline(id, (m) => m.filter((x) => x.id < opts.replaceFrom!))
    if (opts.regenerate) {
      const lastUser = [...(timelines[id] ?? [])].reverse().find((m) => m.role === 'user' && !m.fromBotId)
      if (lastUser) setTimeline(id, (m) => m.filter((x) => x.id <= lastUser.id))
    }
    const update = (fn: (r: LiveReply) => LiveReply) => setLive((l) => (l && l.botId === id ? { botId: id, reply: fn(l.reply) } : l))
    setLive({ botId: id, reply: { text: '', reasoning: '', reasoningDone: false, steps: [], sources: [], startedAt: Date.now() } })
    const ctrl = new AbortController()
    abort.current = ctrl
    if (/remind|every (day|week|morning)|schedule/i.test(opts.text ?? '') && 'Notification' in window) {
      Notification.requestPermission().catch(() => {})
    }
    try {
      await api.chat(
        {
          botId: id,
          content: opts.text ?? '',
          think,
          deep,
          timezone: TZ,
          attachments: opts.files?.map((f) => f.id),
          replaceFrom: opts.replaceFrom,
          regenerate: opts.regenerate,
        },
        (e) => {
          if (e.type === 'user') setTimeline(id, (m) => [...m.filter((x) => x.id !== e.message.id), e.message])
          else if (e.type === 'reasoning') update((r) => ({ ...r, reasoning: r.reasoning + e.text }))
          else if (e.type === 'delta') update((r) => ({ ...r, text: r.text + e.text, reasoningDone: true }))
          else if (e.type === 'retract')
            update((r) => ({
              ...r,
              text: r.text.slice(0, e.from),
              reasoning: [r.reasoning, r.text.slice(e.from).trim()].filter(Boolean).join('\n\n'),
            }))
          else if (e.type === 'tool-call') update((r) => ({ ...r, reasoningDone: true, steps: [...r.steps, e.step] }))
          else if (e.type === 'tool-result')
            update((r) => ({ ...r, steps: r.steps.map((s) => (s.id === e.id ? { ...s, output: e.output, error: e.error } : s)) }))
          else if (e.type === 'sources') update((r) => ({ ...r, sources: e.sources }))
          else if (e.type === 'done') {
            setTimeline(id, (m) => [...m, e.message])
            setLive(null)
            setVersion((v) => v + 1)
            if (e.message.steps?.some((s) => ['create_task', 'cancel_task', 'message_bot'].includes(s.name))) {
              api.tasks().then((r) => setTasks(r.tasks), () => {})
              // Another bot's timeline changed: drop its cache so it reloads when opened.
              const others = e.message.steps.filter((s) => s.name === 'message_bot').map((s) => (s.input as any)?.bot?.toLowerCase())
              setTimelines((t) => {
                const copy = { ...t }
                for (const b of bots) if (others.includes(b.name.toLowerCase())) delete copy[b.id]
                return copy
              })
            }
            refreshBots().catch(() => {})
          } else if (e.type === 'suggestions') setSuggestions({ botId: id, list: e.suggestions })
          else if (e.type === 'error') setError({ botId: id, text: e.error })
        },
        ctrl.signal,
      )
    } catch (e: any) {
      if (e.name !== 'AbortError') setError({ botId: id, text: e.message === 'Failed to fetch' ? `Lost connection to ${conn.url}` : e.message })
      else {
        // The server keeps the partial reply; pick it up.
        setTimeout(async () => {
          const after = (timelinesRef.current[id] ?? []).at(-1)?.id ?? 0
          const r = await api.newer(id, after).catch(() => null)
          if (r) setTimeline(id, (m) => [...m, ...r.messages.filter((f) => !m.some((x) => x.id === f.id))])
        }, 800)
      }
    } finally {
      setLive((l) => (l?.botId === id ? null : l))
      abort.current = null
    }
  }
  const timelinesRef = useRef(timelines)
  timelinesRef.current = timelines

  const unread = (b: Bot) => {
    const lm = b.lastMessage
    if (!lm || lm.role !== 'assistant') return false
    if (b.id === bot?.id && !page) return false
    return lm.id > (read[b.id] ?? 0)
  }

  const working = useMemo(() => new Set(live ? [live.botId] : []), [live])
  const modelLabels = useMemo(() => new Map(models.map((m) => [m.id, m.label.replace(/\s*\(.*\)$/, '')])), [models])
  const taskTitles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks])

  return (
    <BotsContext.Provider value={bots}>
      <div className={`app ${panelOpen && bot && !page ? 'with-panel' : ''}`}>
        <Sidebar
          bots={bots}
          activeId={bot?.id ?? null}
          page={page}
          unread={unread}
          working={working}
          me={me}
          onOpen={(id) => {
            setActiveId(id)
            setPage(null)
          }}
          onPage={(p) => setPage(page === p ? null : p)}
          onNewBot={() => setNewBot(true)}
        />
        <main className="main">
          {page === 'search' && (
            <SearchView
              api={api}
              bots={bots}
              onOpen={(id) => {
                setActiveId(id)
                setPage(null)
              }}
            />
          )}
          {page === 'tasks' && <TasksView api={api} bots={bots} tasks={tasks} setTasks={setTasks} />}
          {page === 'memory' && <MemoryView api={api} />}
          {page === 'settings' && (
            <SettingsView
              conn={conn}
              me={me}
              onSave={(c, name) => {
                saveConnection(c)
                setConn(c)
                setMe(name)
                setPage(null)
              }}
            />
          )}
          {!page && bot && (
            <ChatView
              key={bot.id}
              api={api}
              bot={bot}
              messages={messages}
              hasOlder={!!hasOlder[bot.id]}
              onLoadOlder={async () => {
                const first = messages[0]?.id
                if (!first) return
                const r = await api.messages(bot.id, first)
                setTimeline(bot.id, (m) => [...r.messages, ...m])
                setHasOlder((h) => ({ ...h, [bot.id]: r.messages.length === 100 }))
              }}
              live={live?.botId === bot.id ? live.reply : null}
              otherBusy={!!live && live.botId !== bot.id}
              error={error?.botId === bot.id || error?.botId === 0 ? error.text : null}
              suggestions={suggestions?.botId === bot.id ? suggestions.list : []}
              modelLabels={modelLabels}
              taskTitles={taskTitles}
              onSend={(o) => send(bot, o)}
              onTogglePanel={() => setPanelOpen(!panelOpen)}
              composer={{
                placeholder: `Message ${bot.name}`,
                think,
                setThink,
                deep,
                setDeep,
                onSend: (text, files) => send(bot, { text, files }),
                onStop: () => abort.current?.abort(),
                upload: async (f) => (await api.upload(f)).file,
                busy: !!live,
              }}
            />
          )}
          {!page && !bot && conn.token && <div className="hero muted">Loading your bots…</div>}
        </main>
        {panelOpen && bot && !page && (
          <BotPanel
            api={api}
            bot={bot}
            bots={bots}
            models={models}
            defaultModel={defaultModel}
            version={version}
            onSaved={setBots}
            onDeleted={(list) => {
              setBots(list)
              setActiveId(list[0]?.id ?? null)
            }}
            onClose={() => setPanelOpen(false)}
          />
        )}
        {newBot && (
          <NewBotDialog
            api={api}
            bots={bots}
            onClose={() => setNewBot(false)}
            onCreated={(b, list) => {
              setBots(list)
              setActiveId(b.id)
              setPage(null)
              setNewBot(false)
            }}
          />
        )}
      </div>
    </BotsContext.Provider>
  )
}

const STARTERS: Record<string, string[]> = {
  default: ["What's happening in the world today?", 'Plot compound growth of €10,000 at 7% for 20 years', 'Every weekday at 8:00, send me a short news brief'],
}

function ChatView(props: {
  api: Api
  bot: Bot
  messages: Message[]
  hasOlder: boolean
  onLoadOlder: () => Promise<void>
  live: LiveReply | null
  otherBusy: boolean
  error: string | null
  suggestions: string[]
  modelLabels: Map<string, string>
  taskTitles: Map<number, string>
  onSend: (opts: SendOpts) => void
  onTogglePanel: () => void
  composer: React.ComponentProps<typeof Composer>
}) {
  const { messages, live, bot } = props
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !m.fromBotId)
  const lastAssistant = messages.at(-1)?.role === 'assistant' ? messages.at(-1) : undefined
  const busy = !!live

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, live, props.suggestions])

  return (
    <div className="chat">
      <button className="bot-pill" onClick={props.onTogglePanel} title="Show details">
        <Avatar avatar={bot.avatar} name={bot.name} size={26} />
        {label(bot)}
      </button>
      <div
        className="scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          pinned.current = atBottom
          setShowJump(!atBottom)
        }}
      >
        <div className="thread">
          {messages.length === 0 && !live && (
            <div className="bot-intro">
              <Avatar avatar={bot.avatar} name={bot.name} size={88} />
              <h2>{label(bot)}</h2>
              <p className="muted">{bot.instructions ? bot.instructions.split(/(?<=\.)\s/)[0] : 'Your general assistant. One timeline, always remembering.'}</p>
              <div className="starters">
                {STARTERS.default.map((s) => (
                  <button key={s} className="starter" onClick={() => props.onSend({ text: s })}>
                    {Icon.spark}
                    <span>{s}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {props.hasOlder && (
            <button className="link-btn older" onClick={props.onLoadOlder}>
              Load earlier messages
            </button>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1]
            const gap = !prev || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 3 * 3600_000
            return (
              <div key={m.id} className="entry">
                {gap && <DayDivider iso={m.createdAt} />}
                {m.role === 'user' ? (
                  <UserMessage
                    message={m}
                    fileUrl={props.api.fileUrl}
                    onEdit={!busy && m.id === lastUser?.id ? (text) => props.onSend({ text, files: m.attachments, replaceFrom: m.id }) : undefined}
                  />
                ) : (
                  <AssistantMessage
                    message={m}
                    modelLabel={m.model ? (props.modelLabels.get(m.model) ?? m.model.split(':')[1]) : undefined}
                    taskTitle={m.taskId ? (props.taskTitles.get(m.taskId) ?? 'task') : undefined}
                    onRegenerate={!busy && m.id === lastAssistant?.id && !m.taskId ? () => props.onSend({ regenerate: true }) : undefined}
                  />
                )}
              </div>
            )
          })}
          {live && <AssistantMessage live={live} />}
          {!live && props.suggestions.length > 0 && (
            <div className="suggestions">
              {props.suggestions.map((s) => (
                <button key={s} className="suggestion" onClick={() => props.onSend({ text: s })}>
                  <span>{s}</span>
                  {Icon.send}
                </button>
              ))}
            </div>
          )}
          {props.error && (
            <div className="error">
              {props.error}
              {!live && lastUser && (
                <button className="link-btn" onClick={() => props.onSend({ regenerate: true })}>
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="dock">
        {showJump && (
          <button
            className="jump"
            title="Jump to latest"
            onClick={() => {
              pinned.current = true
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
            }}
          >
            {Icon.down}
          </button>
        )}
        {props.otherBusy && <div className="dock-note">Another bot is answering; you can send once it's done.</div>}
        <Composer {...props.composer} />
      </div>
    </div>
  )
}

const TEMPLATES = [
  { name: 'Researcher', role: 'Deep research', instructions: 'Research thoroughly with many sources, cross-check, and cite every key claim.' },
  { name: 'Coach', role: 'Fitness coach', instructions: 'Plan workouts and habits, track progress in your notebook, and check in kindly.' },
  { name: 'Ledger', role: 'Finance helper', instructions: 'Help with budgets, invoices and numbers. Always compute with run_code; never estimate.' },
  { name: 'Scout', role: 'Load finder', instructions: 'Find freight opportunities, rates and brokers for European road transport. Be specific and numeric.' },
]

function NewBotDialog(props: { api: Api; bots: Bot[]; onClose: () => void; onCreated: (b: Bot, list: Bot[]) => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [team, setTeam] = useState('')
  const [instructions, setInstructions] = useState('')
  const [avatar, setAvatar] = useState(() => randomAvatar('new'))
  const [error, setError] = useState<string | null>(null)
  const teams = [...new Set(props.bots.map((b) => b.team).filter(Boolean))] as string[]

  return (
    <div className="modal-back" onClick={props.onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            const r = await props.api.createBot({ name, role, team: team || null, instructions, avatar })
            props.onCreated(r.bot, r.bots)
          } catch (err: any) {
            setError(err.message)
          }
        }}
      >
        <div className="modal-head">
          <h3>New bot</h3>
          <button type="button" className="round-btn" onClick={props.onClose}>
            {Icon.close}
          </button>
        </div>
        <div className="avatar-edit">
          <Avatar avatar={avatar} name={name || 'bot'} size={64} />
          <button type="button" className="ghost small" onClick={() => setAvatar(randomAvatar(name || 'bot'))}>
            New look
          </button>
        </div>
        <div className="templates">
          {TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.name}
              className="chip"
              onClick={() => {
                setName(t.name)
                setRole(t.role)
                setInstructions(t.instructions)
                setAvatar(randomAvatar(t.name))
              }}
            >
              {t.role}
            </button>
          ))}
        </div>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Raider" required autoFocus />
        </label>
        <label>
          Role
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Live X hunt" />
        </label>
        <label>
          Team
          <input list="new-teams" value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Unassigned" />
          <datalist id="new-teams">
            {teams.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label>
          Instructions
          <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What it does, how it talks, what to focus on" />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary">Create bot</button>
      </form>
    </div>
  )
}
