import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Fact, Message, ModelOption, ToolStep } from '@si-bot/shared'
import { Api, loadConnection, saveConnection, type Connection } from './api'

type View = 'chat' | 'memory' | 'settings'
interface Live {
  text: string
  steps: ToolStep[]
}

const Icon = {
  chat: (
    <svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z" /></svg>
  ),
  memory: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>
  ),
  send: (
    <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" className="fill" /></svg>
  ),
  think: (
    <svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" /></svg>
  ),
  web_search: (
    <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>
  ),
  read_page: (
    <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M9 12h6M9 16h6" /></svg>
  ),
  run_code: (
    <svg viewBox="0 0 24 24"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" /></svg>
  ),
  tool: (
    <svg viewBox="0 0 24 24"><path d="M14 6a4 4 0 0 0 5 5l-8 8a2 2 0 0 1-3-3z" /></svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" /></svg>
  ),
}

export default function App() {
  const [conn, setConn] = useState<Connection>(loadConnection)
  const api = useMemo(() => new Api(conn), [conn])
  const [view, setView] = useState<View>(conn.token ? 'chat' : 'settings')
  const [messages, setMessages] = useState<Message[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState<string>('')
  const [think, setThink] = useState(false)
  const [streaming, setStreaming] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!conn.token) return
    try {
      const [m, ms] = await Promise.all([api.models(), api.messages()])
      setModels(m.models)
      setModel((cur) => cur || m.default || '')
      setMessages(ms.messages)
      setError(null)
    } catch (e: any) {
      setError(e.message === 'Failed to fetch' ? `Can't reach ${conn.url}` : e.message)
    }
  }, [api, conn])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function send(text: string) {
    setError(null)
    setStreaming({ text: '', steps: [] })
    const ctrl = new AbortController()
    abort.current = ctrl
    try {
      await api.chat(
        { content: text, model: model || undefined, think },
        (e) => {
          if (e.type === 'user') setMessages((m) => [...m, e.message])
          else if (e.type === 'delta') setStreaming((s) => s && { ...s, text: s.text + e.text })
          else if (e.type === 'tool-call') setStreaming((s) => s && { ...s, steps: [...s.steps, e.step] })
          else if (e.type === 'tool-result')
            setStreaming(
              (s) =>
                s && {
                  ...s,
                  steps: s.steps.map((st) => (st.id === e.id ? { ...st, output: e.output, error: e.error } : st)),
                },
            )
          else if (e.type === 'done') {
            setMessages((m) => [...m, e.message])
            setStreaming(null)
          } else if (e.type === 'error') setError(e.error)
        },
        ctrl.signal,
      )
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally {
      setStreaming(null)
      abort.current = null
    }
  }

  return (
    <div className="app">
      <nav className="rail">
        <div className="logo" title="Si">
          <img src="/si.svg" alt="Si" />
        </div>
        {(['chat', 'memory', 'settings'] as View[]).map((v) => (
          <button key={v} className={`rail-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)} title={v}>
            {Icon[v]}
            <span>{v[0].toUpperCase() + v.slice(1)}</span>
          </button>
        ))}
      </nav>
      <main className="main">
        {view === 'chat' && (
          <ChatView
            messages={messages}
            streaming={streaming}
            error={error}
            models={models}
            model={model}
            setModel={setModel}
            think={think}
            setThink={setThink}
            onSend={send}
            onStop={() => abort.current?.abort()}
          />
        )}
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
  messages: Message[]
  streaming: Live | null
  error: string | null
  models: ModelOption[]
  model: string
  setModel: (m: string) => void
  think: boolean
  setThink: (t: boolean) => void
  onSend: (text: string) => void
  onStop: () => void
}) {
  const { messages, streaming } = props
  const bottom = useRef<HTMLDivElement>(null)
  const empty = messages.length === 0 && streaming === null

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages, streaming])

  const composer = <Composer {...props} busy={streaming !== null} />

  if (empty) {
    return (
      <div className="hero">
        <h1 className="wordmark">Si</h1>
        <p className="tagline">Your assistant. One mind, always on.</p>
        {composer}
        {props.error && <div className="error">{props.error}</div>}
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="scroll">
        <div className="thread">
          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} content={m.content} steps={m.steps} />
          ))}
          {streaming !== null && <Bubble role="assistant" content={streaming.text} steps={streaming.steps} live />}
          {props.error && <div className="error">{props.error}</div>}
          <div ref={bottom} />
        </div>
      </div>
      <div className="dock">{composer}</div>
    </div>
  )
}

function Bubble(props: { role: string; content: string; steps?: ToolStep[]; live?: boolean }) {
  const { role, content, steps, live } = props
  if (role === 'user') return <div className="msg user">{content}</div>
  return (
    <div className={`msg assistant ${live ? 'live' : ''}`}>
      {steps && steps.length > 0 && (
        <div className="steps">
          {steps.map((s) => (
            <Step key={s.id} step={s} />
          ))}
        </div>
      )}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

function Step({ step }: { step: ToolStep }) {
  const running = step.output === undefined && step.error === undefined
  const code = step.name === 'run_code' ? (step.input as any)?.code : null
  return (
    <details className={`step ${running ? 'running' : ''} ${step.error ? 'failed' : ''}`}>
      <summary>
        <span className="step-icon">{Icon[step.name as keyof typeof Icon] ?? Icon.tool}</span>
        {step.label}
        {running && <span className="spinner" />}
      </summary>
      {code && <pre>{code}</pre>}
      {step.error ? <pre className="step-error">{step.error}</pre> : step.output && <pre>{step.output}</pre>}
    </details>
  )
}

function Composer(props: {
  models: ModelOption[]
  model: string
  setModel: (m: string) => void
  think: boolean
  setThink: (t: boolean) => void
  onSend: (text: string) => void
  onStop: () => void
  busy: boolean
}) {
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [text])

  function submit() {
    const t = text.trim()
    if (!t || props.busy) return
    props.onSend(t)
    setText('')
  }

  return (
    <div className="composer">
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder="What do you want to know?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        autoFocus
      />
      <div className="composer-row">
        <button className={`pill ${props.think ? 'on' : ''}`} onClick={() => props.setThink(!props.think)}>
          {Icon.think}
          Think
        </button>
        <div className="spacer" />
        <select className="pill select" value={props.model} onChange={(e) => props.setModel(e.target.value)}>
          {props.models.length === 0 && <option value="">No models configured</option>}
          {props.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {props.busy ? (
          <button className="send" onClick={props.onStop} title="Stop">
            {Icon.stop}
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!text.trim()} title="Send">
            {Icon.send}
          </button>
        )}
      </div>
    </div>
  )
}

function MemoryView({ api }: { api: Api }) {
  const [facts, setFacts] = useState<Fact[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.facts().then((r) => setFacts(r.facts), (e) => setError(e.message))
  }, [api])

  return (
    <div className="page">
      <h2>Memory</h2>
      <p className="muted">
        What Si remembers about you. It learns these from conversations; you can add or remove anything.
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
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Teach Si something about you…" />
        <button className="primary">Remember</button>
      </form>
      {error && <div className="error">{error}</div>}
      <ul className="facts">
        {facts.map((f) => (
          <li key={f.id}>
            <span>{f.text}</span>
            <button className="icon-btn" title="Forget" onClick={async () => setFacts((await api.deleteFact(f.id)).facts)}>
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
