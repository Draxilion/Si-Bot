import { useEffect, useState } from 'react'
import type { Bot, Fact, Message, Task } from '@si-bot/shared'
import { Avatar } from './Avatar'
import type { Api, Connection } from './api'
import { Icon } from './icons'
import { Markdown } from './Markdown'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

export function DayDivider({ iso }: { iso: string }) {
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

export function TasksView({ api, bots, tasks, setTasks }: { api: Api; bots: Bot[]; tasks: Task[]; setTasks: (t: Task[]) => void }) {
  const [botId, setBotId] = useState<number>(bots[0]?.id ?? 0)
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
      setTasks((await api.addTask({ botId, title: title.trim(), prompt: prompt.trim(), timezone: TZ, ...schedule })).tasks)
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
        Things your bots do on their own: reminders, daily briefs, keeping an eye on news or prices. Results land in that bot's chat.
        You can also just ask in chat, like "every morning at 8, summarise the news".
      </p>
      <ul className="task-list">
        {tasks.map((t) => (
          <li key={t.id} className={t.enabled ? '' : 'off'}>
            <div className="task-main">
              <div className="task-title">
                {(() => {
                  const b = bots.find((x) => x.id === t.botId)
                  return b ? <Avatar avatar={b.avatar} name={b.name} size={20} /> : null
                })()}
                {t.title}
              </div>
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
          placeholder="What should it do? e.g. Search today's top AI and tech news and give me the 5 biggest stories with links."
          rows={3}
          required
        />
        <div className="task-when">
          <select value={botId} onChange={(e) => setBotId(Number(e.target.value))} title="Which bot runs it">
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
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

/** Markdown syntax reads as noise in a two-line snippet. */
function plainSnippet(s: string) {
  return s
    .replace(/\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?/g, ' ')
    .replace(/[*`#]+/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/(\s·)+/g, ' ·')
    .replace(/\s+/g, ' ')
    .trim()
}

export function SearchView({ api, bots, onOpen }: { api: Api; bots: Bot[]; onOpen: (botId: number) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<(Message & { snippet: string })[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    if (!q.trim()) return setResults(null)
    const t = setTimeout(() => api.search(q).then((r) => setResults(r.messages), () => setResults([])), 250)
    return () => clearTimeout(t)
  }, [api, q])
  return (
    <div className="page">
      <h2>Search</h2>
      <p className="muted">Everything you and your bots have ever said.</p>
      <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your conversation…" autoFocus />
      {results && (
        <ul className="results">
          {results.map((m) => (
            <li key={m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
              <div className="result-meta">
                {(() => {
                  const b = bots.find((x) => x.id === m.botId)
                  return b ? (
                    <button className="result-bot" onClick={(e) => (e.stopPropagation(), onOpen(b.id))}>
                      <Avatar avatar={b.avatar} name={b.name} size={18} />
                      {b.name}
                    </button>
                  ) : null
                })()}
                {m.role === 'user' ? 'You' : 'Bot'} · {new Date(m.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
              {open === m.id ? (
                <div className="msg assistant">
                  <Markdown text={m.content} />
                </div>
              ) : (
                <div className="result-snippet">
                  {plainSnippet(m.snippet).split(/(<<.*?>>)/g).map((part, i) =>
                    part.startsWith('<<') ? <mark key={i}>{part.slice(2, -2)}</mark> : <span key={i}>{part}</span>,
                  )}
                </div>
              )}
            </li>
          ))}
          {results.length === 0 && <li className="muted">No matches.</li>}
        </ul>
      )}
    </div>
  )
}

export function MemoryView({ api }: { api: Api }) {
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
      <p className="muted">
        What your bots know about you, shared by all of them. No bot ever starts over: each also keeps its own notebook and
        a digest of its older timeline, under Details in its side panel. Everything is yours to read and edit.
      </p>
      <form
        className="add-fact"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!text.trim()) return
          setFacts((await api.addFact(text)).facts)
          setText('')
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Teach your bots something about you…" />
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
        {facts.length === 0 && !error && <li className="muted">Nothing yet. Chat a little and your bots will start remembering.</li>}
      </ul>
    </div>
  )
}

export function ContextEditors({ api, botId }: { api: Api; botId: number }) {
  const [notes, setNotes] = useState<string | null>(null)
  const [digest, setDigest] = useState<string | null>(null)
  const [meta, setMeta] = useState<string>('')
  const [saved, setSaved] = useState<'notes' | 'digest' | null>(null)
  useEffect(() => {
    api.context(botId).then(
      (r) => {
        setNotes(r.notes)
        setDigest(r.digest?.text ?? '')
        setMeta(r.digest ? `updated ${new Date(r.digest.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : '')
      },
      () => {},
    )
  }, [api, botId])
  if (notes === null) return null
  const save = async (which: 'notes' | 'digest') => {
    await api.saveContext(botId, which === 'notes' ? { notes: notes ?? '' } : { digest: digest ?? '' })
    setSaved(which)
    setTimeout(() => setSaved(null), 1500)
  }
  return (
    <div className="context-editors">
      <details className="context-card" open={!!notes}>
        <summary>
          <span>Notebook</span>
          <span className="muted small">What this bot is tracking right now: projects, open loops, promises</span>
        </summary>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={8} placeholder="The bot fills this in as it learns what you're working on." />
        <button className="ghost" onClick={() => save('notes')}>{saved === 'notes' ? 'Saved' : 'Save notebook'}</button>
      </details>
      <details className="context-card">
        <summary>
          <span>Timeline digest</span>
          <span className="muted small">{digest ? `Summary of older conversation, ${meta}` : 'Starts once this timeline outgrows the recent window'}</span>
        </summary>
        <textarea value={digest ?? ''} onChange={(e) => setDigest(e.target.value)} rows={14} />
        <button className="ghost" onClick={() => save('digest')}>{saved === 'digest' ? 'Saved' : 'Save digest'}</button>
      </details>
    </div>
  )
}

export function SettingsView(props: { conn: Connection; me: string; onSave: (c: Connection, me: string) => void }) {
  const { conn, onSave } = props
  const [url, setUrl] = useState(conn.url)
  const [token, setToken] = useState(conn.token)
  const [name, setName] = useState(props.me)
  return (
    <div className="page">
      <h2>Settings</h2>
      <p className="muted">Use http://localhost:8787 while testing locally, or your VPS domain once deployed.</p>
      <form
        className="settings"
        onSubmit={(e) => {
          e.preventDefault()
          onSave({ url: url.trim(), token: token.trim() }, name.trim())
        }}
      >
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown on your avatar" />
        </label>
        <label>
          Server URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://si.example.com" />
        </label>
        <label>
          Access token
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="SIBOT_TOKEN from .env" />
        </label>
        <button className="primary">Save</button>
      </form>
    </div>
  )
}
