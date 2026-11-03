import { useEffect, useState } from 'react'
import type { AttachmentMeta, Message, Source, ToolStep } from '@si-bot/shared'
import { Icon } from './icons'
import { CopyButton, Markdown } from './Markdown'

export interface LiveReply {
  text: string
  reasoning: string
  reasoningDone: boolean
  steps: ToolStep[]
  sources: Source[]
  startedAt: number
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function Favicon({ url }: { url: string }) {
  const h = host(url)
  // A letter tile, coloured by host, instead of fetching favicons from a third party.
  let hash = 0
  for (const ch of h) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span className="favicon" style={{ background: `hsl(${hash % 360} 65% 92%)`, color: `hsl(${hash % 360} 55% 32%)` }}>
      {h[0]?.toUpperCase()}
    </span>
  )
}

export function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false)
  if (!sources.length) return null
  return (
    <div className="sources">
      <button className="sources-btn" onClick={() => setOpen(!open)}>
        <span className="favicon-stack">
          {sources.slice(0, 4).map((s) => (
            <Favicon key={s.url} url={s.url} />
          ))}
        </span>
        {sources.length} {sources.length === 1 ? 'source' : 'sources'}
      </button>
      {open && (
        <ol className="source-list">
          {sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer">
                <Favicon url={s.url} />
                <span className="source-title">{s.title}</span>
                <span className="source-host">{host(s.url)}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Thinking({ text, live, ms }: { text: string; live: boolean; ms?: number }) {
  const [open, setOpen] = useState(false)
  const secs = ms ? Math.max(1, Math.round(ms / 1000)) : null
  return (
    <div className={`thinking ${live ? 'live' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        {Icon.think}
        <span>{live ? 'Thinking' : secs ? `Thought for ${secs}s` : 'Thoughts'}</span>
        <span className={`chev ${open ? 'open' : ''}`}>{Icon.chevron}</span>
      </button>
      {(open || live) && <div className={`thinking-body ${live && !open ? 'peek' : ''}`}>{text}</div>}
    </div>
  )
}

function Step({ step }: { step: ToolStep }) {
  const running = step.output === undefined && step.error === undefined
  const code = step.name === 'run_code' ? (step.input as any)?.code : null
  return (
    <details className={`step ${running ? 'running' : ''} ${step.error ? 'failed' : ''}`}>
      <summary>
        <span className="step-icon">{(Icon as any)[step.name] ?? Icon.tool}</span>
        <span className="step-label">{step.label}</span>
        {running && <span className="spinner" />}
      </summary>
      {code && <pre>{code}</pre>}
      {step.error ? <pre className="step-error">{step.error}</pre> : step.output && <pre>{step.output}</pre>}
    </details>
  )
}

function Steps({ steps, live }: { steps: ToolStep[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!steps.length) return null
  // While working, show the latest few steps; afterwards fold them into one line like "Searched 3 queries, read 5 pages".
  if (live || open || steps.length === 1) {
    const hidden = live && !open ? Math.max(0, steps.length - 3) : 0
    return (
      <div className="steps">
        {hidden > 0 && (
          <button className="steps-summary" onClick={() => setOpen(true)}>
            {Icon.tool}
            <span>{summarizeSteps(steps.slice(0, hidden))}</span>
            <span className="chev">{Icon.chevron}</span>
          </button>
        )}
        {steps.slice(hidden).map((s) => (
          <Step key={s.id} step={s} />
        ))}
        {!live && steps.length > 1 && (
          <button className="link-btn" onClick={() => setOpen(false)}>
            Hide steps
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="steps">
      <button className="steps-summary" onClick={() => setOpen(true)}>
        {Icon.tool}
        <span>{summarizeSteps(steps)}</span>
        <span className="chev">{Icon.chevron}</span>
      </button>
    </div>
  )
}

function summarizeSteps(steps: ToolStep[]) {
  const count = (name: string) => steps.filter((s) => s.name === name)
  const parts: string[] = []
  const searches = count('web_search')
  const queries = searches.reduce((n, s) => n + (((s.input as any)?.queries?.length as number) || 1), 0)
  if (searches.length) parts.push(`searched ${queries} ${queries === 1 ? 'query' : 'queries'}`)
  const pages = count('read_page').reduce((n, s) => n + (((s.input as any)?.urls?.length as number) || 1), 0)
  if (pages) parts.push(`read ${pages} ${pages === 1 ? 'page' : 'pages'}`)
  const code = count('run_code').length
  if (code) parts.push(`ran code ${code === 1 ? 'once' : `${code} times`}`)
  const other = steps.length - searches.length - count('read_page').length - code
  if (other) parts.push(`${other} other ${other === 1 ? 'step' : 'steps'}`)
  const s = parts.join(', ')
  return s[0].toUpperCase() + s.slice(1)
}

function Attachments({ files, fileUrl }: { files: AttachmentMeta[]; fileUrl: (id: number) => string }) {
  return (
    <div className="msg-files">
      {files.map((f) =>
        f.mediaType.startsWith('image/') ? (
          <a key={f.id} href={fileUrl(f.id)} target="_blank" rel="noreferrer">
            <img className="msg-image" src={fileUrl(f.id)} alt={f.name} />
          </a>
        ) : (
          <a key={f.id} className="file-chip" href={fileUrl(f.id)} target="_blank" rel="noreferrer">
            {Icon.file}
            <span>{f.name}</span>
          </a>
        ),
      )}
    </div>
  )
}

function useSpeech() {
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => () => window.speechSynthesis?.cancel(), [])
  if (!('speechSynthesis' in window)) return null
  return {
    speaking,
    toggle(text: string) {
      if (speaking) {
        speechSynthesis.cancel()
        setSpeaking(false)
        return
      }
      const plain = text
        .replace(/```[\s\S]*?```/g, ' code block. ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_#>`|]/g, '')
      const u = new SpeechSynthesisUtterance(plain)
      u.onend = u.onerror = () => setSpeaking(false)
      speechSynthesis.cancel()
      speechSynthesis.speak(u)
      setSpeaking(true)
    },
  }
}

function time(iso: string) {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return d.toLocaleString(undefined, today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function UserMessage(props: {
  message: Message
  fileUrl: (id: number) => string
  onEdit?: (text: string) => void
}) {
  const { message: m } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.content)
  if (editing) {
    return (
      <div className="msg user editing">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus rows={Math.min(10, draft.split('\n').length + 1)} />
        <div className="edit-row">
          <button className="ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button
            className="primary small"
            disabled={!draft.trim()}
            onClick={() => {
              setEditing(false)
              props.onEdit?.(draft.trim())
            }}
          >
            Send
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="turn user">
      {m.attachments && <Attachments files={m.attachments} fileUrl={props.fileUrl} />}
      {m.content && <div className="msg user">{m.content}</div>}
      <div className="actions">
        <span className="stamp">{time(m.createdAt)}</span>
        <CopyButton text={m.content} />
        {props.onEdit && (
          <button className="icon-btn" title="Edit" onClick={() => setEditing(true)}>
            {Icon.edit}
          </button>
        )}
      </div>
    </div>
  )
}

export function AssistantMessage(props: {
  message?: Message
  live?: LiveReply
  modelLabel?: string
  taskTitle?: string
  onRegenerate?: () => void
}) {
  const { message: m, live } = props
  const speech = useSpeech()
  const text = live ? live.text : m!.content
  const reasoning = live ? live.reasoning : m?.reasoning
  const steps = live ? live.steps : (m?.steps ?? [])
  const sources = live ? live.sources : (m?.sources ?? [])
  const thinkingLive = !!live && !live.reasoningDone && !live.text
  const waiting = !!live && !live.text && !live.reasoning && !steps.length
  return (
    <div className={`turn assistant ${live ? 'live' : ''}`}>
      {props.taskTitle && (
        <div className="task-badge">
          {Icon.tasks}
          Scheduled · {props.taskTitle}
        </div>
      )}
      {reasoning && <Thinking text={reasoning} live={thinkingLive} ms={m?.thoughtMs} />}
      <Steps steps={steps} live={!!live} />
      {waiting && (
        <div className="typing">
          <span />
          <span />
          <span />
        </div>
      )}
      {text && (
        <div className="msg assistant">
          <Markdown text={text} />
          {live && <span className="caret" />}
        </div>
      )}
      {m?.partial && <div className="stopped">Stopped before finishing</div>}
      {!live && <Sources sources={sources} />}
      {m && (
        <div className="actions">
          <CopyButton text={m.content} />
          {speech && (
            <button className="icon-btn" title={speech.speaking ? 'Stop reading' : 'Read aloud'} onClick={() => speech.toggle(m.content)}>
              {speech.speaking ? Icon.pause : Icon.speak}
            </button>
          )}
          {props.onRegenerate && (
            <button className="icon-btn" title="Regenerate" onClick={props.onRegenerate}>
              {Icon.retry}
            </button>
          )}
          <span className="stamp">
            {props.modelLabel ? `${props.modelLabel} · ` : ''}
            {time(m.createdAt)}
          </span>
        </div>
      )}
    </div>
  )
}
