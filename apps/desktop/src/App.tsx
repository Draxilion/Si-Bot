import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentMeta, Fact, Message, ModelOption, Task } from '@si-bot/shared'
import { Api, loadConnection, saveConnection, type Connection } from './api'
import { Icon } from './icons'
import { AssistantMessage, UserMessage, type LiveReply } from './Message'
import { Composer } from './Composer'
import { setFileResolver } from './Markdown'

type View = 'chat' | 'tasks' | 'memory' | 'settings'
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return s === null ? initial : (JSON.parse(s) as T)
    } catch {
      return initial
    }
  })
  return [
    v,
    (next: T) => {
      setV(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {}
    },
  ]
}

const STARTERS = [
  { icon: 'web_search', text: "What's happening in the world today?" },
  { icon: 'deep', text: 'Research the best budget laptops for programming right now', deep: true },
  { icon: 'run_code', text: 'Plot compound growth of €10,000 at 7% for 20 years' },
  { icon: 'create_task', text: 'Every weekday at 8:00, send me a short news brief' },
] as const

export default function App() {
  const [conn, setConn] = useState<Connection>(loadConnection)
  const api = useMemo(() => new Api(conn), [conn])
  setFileResolver(api.fileUrl)
  const [view, setView] = useState<View>(conn.token ? 'chat' : 'settings')
  const [messages, setMessages] = useState<Message[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = usePref<string>('si.model', '')
  const [think, setThink] = usePref('si.think', false)
  const [deep, setDeep] = usePref('si.deep', false)
  const [live, setLive] = useState<LiveReply | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState<string | null>(null)
  const [prefill, setPrefill] = useState<{ text: string; n: number }>()
  const abort = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!conn.token) return
    try {
      const [m, ms, ts] = await Promise.all([api.models(), api.messages(), api.tasks()])
      setModels(m.models)
      if (!model || !m.models.some((x) => x.id === model)) setModel(m.default ?? m.models[0]?.id ?? '')
      setMessages(ms.messages)
      setHasOlder(ms.messages.length === 100)
      setTasks(ts.tasks)
      setError(null)
    } catch (e: any) {
      setError(e.message === 'Failed to fetch' ? `Can't reach ${conn.url}` : e.message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, conn])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Scheduled tasks post into the timeline while the app is idle: poll for new messages.
  const lastId = messages.at(-1)?.id ?? 0
  useEffect(() => {
    if (!conn.token || live) return
    const timer = setInterval(async () => {
      try {
        const { messages: fresh } = await api.newer(lastId)
        if (!fresh.length) return
        setMessages((m) => [...m, ...fresh.filter((f) => !m.some((x) => x.id === f.id))])
        const fromTask = fresh.find((f) => f.taskId)
        if (fromTask && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('Si', { body: fromTask.content.replace(/[*#_`]/g, '').slice(0, 140) })
        }
        api.tasks().then((r) => setTasks(r.tasks), () => {})
      } catch {}
    }, 15_000)
    return () => clearInterval(timer)
  }, [api, conn.token, live, lastId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') abort.current?.abort()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function loadOlder() {
    const first = messages[0]?.id
    if (!first) return
    const { messages: older } = await api.messages(first)
    setMessages((m) => [...older, ...m])
    setHasOlder(older.length === 100)
  }

  async function send(opts: { text?: string; files?: AttachmentMeta[]; replaceFrom?: number; regenerate?: boolean; deepOverride?: boolean }) {
    setError(null)
    setSuggestions([])
    if (opts.replaceFrom) setMessages((m) => m.filter((x) => x.id < opts.replaceFrom!))
    if (opts.regenerate) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      if (lastUser) setMessages((m) => m.filter((x) => x.id <= lastUser.id))
    }
    setLive({ text: '', reasoning: '', reasoningDone: false, steps: [], sources: [], startedAt: Date.now() })
    const ctrl = new AbortController()
    abort.current = ctrl
    if (tasks.length === 0 && /remind|every (day|week|morning)|schedule/i.test(opts.text ?? '') && 'Notification' in window) {
      Notification.requestPermission().catch(() => {})
    }
    try {
      await api.chat(
        {
          content: opts.text ?? '',
          model: model || undefined,
          think,
          deep: opts.deepOverride ?? deep,
          timezone: TZ,
          attachments: opts.files?.map((f) => f.id),
          replaceFrom: opts.replaceFrom,
          regenerate: opts.regenerate,
        },
        (e) => {
          if (e.type === 'user') setMessages((m) => [...m.filter((x) => x.id !== e.message.id), e.message])
          else if (e.type === 'reasoning') setLive((s) => s && { ...s, reasoning: s.reasoning + e.text })
          else if (e.type === 'delta') setLive((s) => s && { ...s, text: s.text + e.text, reasoningDone: true })
          else if (e.type === 'tool-call') setLive((s) => s && { ...s, reasoningDone: true, steps: [...s.steps, e.step] })
          else if (e.type === 'tool-result')
            setLive(
              (s) => s && { ...s, steps: s.steps.map((st) => (st.id === e.id ? { ...st, output: e.output, error: e.error } : st)) },
            )
          else if (e.type === 'sources') setLive((s) => s && { ...s, sources: e.sources })
          else if (e.type === 'done') {
            setMessages((m) => [...m, e.message])
            setLive(null)
            if (e.message.steps?.some((s) => s.name === 'create_task' || s.name === 'cancel_task'))
              api.tasks().then((r) => setTasks(r.tasks), () => {})
          } else if (e.type === 'suggestions') setSuggestions(e.suggestions)
          else if (e.type === 'error') setError(e.error)
        },
        ctrl.signal,
      )
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message === 'Failed to fetch' ? `Lost connection to ${conn.url}` : e.message)
      else {
        // The server saves what it had; pick it up.
        setTimeout(() => api.newer(lastIdRef.current).then((r) => setMessages((m) => [...m, ...r.messages.filter((f) => !m.some((x) => x.id === f.id))]), () => {}), 800)
      }
    } finally {
      setLive(null)
      abort.current = null
    }
  }
  const lastIdRef = useRef(0)
  lastIdRef.current = lastId

  const taskTitles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks])
  const modelLabels = useMemo(() => new Map(models.map((m) => [m.id, m.label.replace(/\s*\(.*\)$/, '')])), [models])

  return (
    <div className="app">
      <nav className="rail">
        <div className="logo" title="Si">
          <img src="/si.svg" alt="Si" />
        </div>
        {(['chat', 'tasks', 'memory', 'settings'] as View[]).map((v) => (
          <button key={v} className={`rail-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)} title={v}>
            {Icon[v]}
            <span>{v[0].toUpperCase() + v.slice(1)}</span>
            {v === 'tasks' && tasks.filter((t) => t.enabled).length > 0 && <i className="badge">{tasks.filter((t) => t.enabled).length}</i>}
          </button>
        ))}
      </nav>
      <main className="main">
        {view === 'chat' && (
          <ChatView
            api={api}
            messages={messages}
            hasOlder={hasOlder}
            onLoadOlder={loadOlder}
            live={live}
            error={error}
            suggestions={suggestions}
            taskTitles={taskTitles}
            modelLabels={modelLabels}
            onSend={send}
            prefill={prefill}
            setPrefill={setPrefill}
            composer={{
              models,
              model,
              setModel,
              think,
              setThink,
              deep,
              setDeep,
              onSend: (text, files) => send({ text, files }),
              onStop: () => abort.current?.abort(),
              upload: async (f) => (await api.upload(f)).file,
              busy: live !== null,
              prefill,
            }}
          />
        )}
        {view === 'tasks' && <TasksView api={api} tasks={tasks} setTasks={setTasks} />}
        {view === 'memory' && <MemoryView api={api} />}
        {view === 'settings' && (
          <SettingsView
            conn={conn}
            onSave={(c) => {
              saveConnection(c)
              setConn(c)
              setView('chat')
            }}
          />
        )}
      </main>
    </div>
  )
}

function ChatView(props: {
  api: Api
  messages: Message[]
  hasOlder: boolean
  onLoadOlder: () => Promise<void>
  live: LiveReply | null
  error: string | null
  suggestions: string[]
  taskTitles: Map<number, string>
  modelLabels: Map<string, string>
  onSend: (opts: { text?: string; files?: AttachmentMeta[]; replaceFrom?: number; regenerate?: boolean; deepOverride?: boolean }) => void
  prefill?: { text: string; n: number }
  setPrefill: (p: { text: string; n: number }) => void
  composer: React.ComponentProps<typeof Composer>
}) {
  const { messages, live } = props
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const empty = messages.length === 0 && live === null
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const lastAssistant = messages.at(-1)?.role === 'assistant' ? messages.at(-1) : undefined
  const fileUrl = props.api.fileUrl

  // Follow the reply as it streams, unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, live, props.suggestions])

  useEffect(() => {
    pinned.current = true
  }, [messages.length === 0])

  const composer = <Composer {...props.composer} />

  if (empty) {
    return (
      <div className="hero">
        <img className="hero-logo" src="/si.svg" alt="" />
        <h1 className="wordmark">Si</h1>
        <p className="tagline">Your assistant. One mind, always on.</p>
        {composer}
        <div className="starters">
          {STARTERS.map((s) => (
            <button key={s.text} className="starter" onClick={() => props.onSend({ text: s.text, deepOverride: 'deep' in s ? s.deep : undefined })}>
              {Icon[s.icon]}
              <span>{s.text}</span>
            </button>
          ))}
        </div>
        {props.error && <div className="error">{props.error}</div>}
      </div>
    )
  }

  return (
    <div className="chat">
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
          {props.hasOlder && (
            <button className="link-btn older" onClick={props.onLoadOlder}>
              Load earlier messages
            </button>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1]
            const day = new Date(m.createdAt).toDateString()
            const divider = !prev || new Date(prev.createdAt).toDateString() !== day
            return (
              <div key={m.id} className="entry">
                {divider && <DayDivider iso={m.createdAt} />}
                {m.role === 'user' ? (
                  <UserMessage
                    message={m}
                    fileUrl={fileUrl}
                    onEdit={
                      !live && m.id === lastUser?.id
                        ? (text) => props.onSend({ text, files: m.attachments, replaceFrom: m.id })
                        : undefined
                    }
                  />
                ) : (
                  <AssistantMessage
                    message={m}
                    modelLabel={m.model ? (props.modelLabels.get(m.model) ?? m.model.split(':')[1]) : undefined}
                    taskTitle={m.taskId ? (props.taskTitles.get(m.taskId) ?? 'task') : undefined}
                    onRegenerate={!live && m.id === lastAssistant?.id && !m.taskId ? () => props.onSend({ regenerate: true }) : undefined}
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
        {composer}
      </div>
    </div>
  )
}

function DayDivider({ iso }: { iso: string }) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  const label =
    d.toDateString() === today.toDateString()
      ? 'Today'
      : d.toDateString() === yesterday.toDateString()
        ? 'Yesterday'
        : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  return <div className="day">{label}</div>
}

type Repeat = 'once' | 'daily' | 'weekdays' | 'weekly' | 'cron'

function describeSchedule(t: Task) {
  if (!t.cron) return t.runAt ? `Once · ${new Date(t.runAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Once'
  const m = t.cron.match(/^(\d+) (\d+) \* \* (\*|1-5|\d)$/)
  if (m) {
    const at = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`
    if (m[3] === '*') return `Every day at ${at}`
    if (m[3] === '1-5') return `Weekdays at ${at}`
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(m[3]) % 7]
    return `Every ${day} at ${at}`
  }
  return `Cron ${t.cron}`
}

function TasksView({ api, tasks, setTasks }: { api: Api; tasks: Task[]; setTasks: (t: Task[]) => void }) {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [repeat, setRepeat] = useState<Repeat>('daily')
  const [time, setTime] = useState('08:00')
  const [date, setDate] = useState(() => new Date(Date.now() + 3600_000).toISOString().slice(0, 10))
  const [weekday, setWeekday] = useState('1')
  const [cron, setCron] = useState('0 8 * * *')
  const [error, setError] = useState<string | null>(null)
  const [ran, setRan] = useState<number | null>(null)

  useEffect(() => {
    api.tasks().then((r) => setTasks(r.tasks), (e) => setError(e.message))
  }, [api, setTasks])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const [hh, mm] = time.split(':').map(Number)
    const schedule =
      repeat === 'once'
        ? { runAt: new Date(`${date}T${time}`).toISOString() }
        : { cron: repeat === 'cron' ? cron : `${mm} ${hh} * * ${repeat === 'daily' ? '*' : repeat === 'weekdays' ? '1-5' : weekday}` }
    try {
      setTasks((await api.addTask({ title: title.trim(), prompt: prompt.trim(), timezone: TZ, ...schedule })).tasks)
      setTitle('')
      setPrompt('')
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className="page">
      <h2>Tasks</h2>
      <p className="muted">
        Things Si does on its own: reminders, daily briefs, keeping an eye on news or prices. Results land in your chat.
        You can also just ask in chat, like "every morning at 8, summarise the news".
      </p>
      <ul className="task-list">
        {tasks.map((t) => (
          <li key={t.id} className={t.enabled ? '' : 'off'}>
            <div className="task-main">
              <div className="task-title">{t.title}</div>
              <div className="task-meta">
                {describeSchedule(t)}
                {t.cron && t.enabled && t.nextRunAt && ` · next ${new Date(t.nextRunAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
                {!t.enabled && ' · paused'}
              </div>
              <div className="task-prompt">{t.prompt}</div>
            </div>
            <div className="task-actions">
              <button
                className="icon-btn"
                title="Run now"
                onClick={async () => {
                  await api.runTask(t.id)
                  setRan(t.id)
                  setTimeout(() => setRan(null), 3000)
                }}
              >
                {ran === t.id ? Icon.check : Icon.play}
              </button>
              {(t.cron || t.enabled) && (
                <button
                  className={`toggle ${t.enabled ? 'on' : ''}`}
                  title={t.enabled ? 'Pause' : 'Resume'}
                  onClick={async () => setTasks((await api.setTaskEnabled(t.id, !t.enabled)).tasks)}
                >
                  <span />
                </button>
              )}
              <button className="icon-btn danger" title="Delete" onClick={async () => setTasks((await api.deleteTask(t.id)).tasks)}>
                {Icon.trash}
              </button>
            </div>
          </li>
        ))}
        {tasks.length === 0 && <li className="muted empty">No tasks yet.</li>}
      </ul>

      <h3>New task</h3>
      <form className="task-form" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name, e.g. Morning brief" required />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should Si do? e.g. Search today's top AI and tech news and give me the 5 biggest stories with links."
          rows={3}
          required
        />
        <div className="task-when">
          <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
            <option value="once">Once</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Every week</option>
            <option value="cron">Custom (cron)</option>
          </select>
          {repeat === 'once' && <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          {repeat === 'weekly' && (
            <select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          )}
          {repeat === 'cron' ? (
            <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 8 * * 1-5" />
          ) : (
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          )}
          <button className="primary">Schedule</button>
        </div>
      </form>
      {error && <div className="error">{error}</div>}
    </div>
  )
}

function MemoryView({ api }: { api: Api }) {
  const [facts, setFacts] = useState<Fact[]>([])
  const [text, setText] = useState('')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.facts().then((r) => setFacts(r.facts), (e) => setError(e.message))
  }, [api])

  const shown = facts.filter((f) => f.text.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="page">
      <h2>Memory</h2>
      <p className="muted">What Si remembers about you. It learns these from conversations; you can add or remove anything.</p>
      <form
        className="add-fact"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!text.trim()) return
          setFacts((await api.addFact(text)).facts)
          setText('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Teach Si something about you…" />
        <button className="primary">Remember</button>
      </form>
      {facts.length > 8 && (
        <input className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Search ${facts.length} memories`} />
      )}
      {error && <div className="error">{error}</div>}
      <ul className="facts">
        {shown.map((f) => (
          <li key={f.id}>
            <span>{f.text}</span>
            <button className="icon-btn danger" title="Forget" onClick={async () => setFacts((await api.deleteFact(f.id)).facts)}>
              {Icon.trash}
            </button>
          </li>
        ))}
        {facts.length === 0 && !error && <li className="muted">Nothing yet. Chat a little and Si will start remembering.</li>}
      </ul>
    </div>
  )
}

function SettingsView({ conn, onSave }: { conn: Connection; onSave: (c: Connection) => void }) {
  const [url, setUrl] = useState(conn.url)
  const [token, setToken] = useState(conn.token)
  return (
    <div className="page">
      <h2>Connect to your Si server</h2>
      <p className="muted">Use http://localhost:8787 while testing locally, or your VPS domain once deployed.</p>
      <form
        className="settings"
        onSubmit={(e) => {
          e.preventDefault()
          onSave({ url: url.trim(), token: token.trim() })
        }}
      >
        <label>
          Server URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://si.example.com" />
        </label>
        <label>
          Access token
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="SIBOT_TOKEN from .env" />
        </label>
        <button className="primary">Connect</button>
      </form>
    </div>
  )
}
