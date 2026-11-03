import { useEffect, useRef, useState } from 'react'
import type { AttachmentMeta } from '@si-bot/shared'
import { Icon } from './icons'

export interface Pending {
  key: string
  name: string
  preview?: string
  meta?: AttachmentMeta
  error?: string
}

export interface ComposerProps {
  placeholder?: string
  think: boolean
  setThink: (t: boolean) => void
  deep: boolean
  setDeep: (d: boolean) => void
  onSend: (text: string, files: AttachmentMeta[]) => void
  onStop: () => void
  upload: (file: File) => Promise<AttachmentMeta>
  busy: boolean
  /** Text to place in the box (e.g. a suggestion the user clicked to edit). */
  prefill?: { text: string; n: number }
}

export const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode Go',
  ollama: 'Local (Ollama)',
}

const SpeechRecognition: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition

export function Composer(props: ComposerProps) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Pending[]>([])
  const [listening, setListening] = useState(false)
  const [dragging, setDragging] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const recognizer = useRef<any>(null)

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [text])

  useEffect(() => {
    if (props.prefill) {
      setText(props.prefill.text)
      ta.current?.focus()
    }
  }, [props.prefill])

  function addFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const key = `${file.name}-${file.size}-${Math.random()}`
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      setFiles((f) => [...f, { key, name: file.name, preview }])
      props.upload(file).then(
        (meta) => setFiles((f) => f.map((p) => (p.key === key ? { ...p, meta } : p))),
        (err) => setFiles((f) => f.map((p) => (p.key === key ? { ...p, error: err.message } : p))),
      )
    }
  }

  const uploading = files.some((f) => !f.meta && !f.error)
  const ready = files.filter((f) => f.meta).map((f) => f.meta!)

  function submit() {
    const t = text.trim()
    if ((!t && !ready.length) || props.busy || uploading) return
    recognizer.current?.stop()
    props.onSend(t, ready)
    setText('')
    files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview))
    setFiles([])
  }

  function toggleMic() {
    if (listening) {
      recognizer.current?.stop()
      return
    }
    const r = new SpeechRecognition()
    r.interimResults = true
    r.continuous = true
    r.lang = navigator.language
    const base = text ? text.replace(/\s*$/, ' ') : ''
    r.onresult = (e: any) => {
      let said = ''
      for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript
      setText(base + said)
    }
    r.onend = () => setListening(false)
    r.onerror = () => setListening(false)
    recognizer.current = r
    r.start()
    setListening(true)
  }

  return (
    <div
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
      }}
    >
      {files.length > 0 && (
        <div className="pending-files">
          {files.map((f) => (
            <div key={f.key} className={`pending ${f.error ? 'failed' : ''} ${f.meta ? '' : 'loading'}`} title={f.error ?? f.name}>
              {f.preview ? <img src={f.preview} alt="" /> : <span className="pending-icon">{Icon.file}</span>}
              <span className="pending-name">{f.error ? f.error : f.name}</span>
              <button className="pending-x" title="Remove" onClick={() => setFiles((all) => all.filter((p) => p.key !== f.key))}>
                {Icon.close}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-line">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/*,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.js,.ts,.tsx,.py,.rs,.go,.java,.sql,.log"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <button className="round-btn" title="Attach files" onClick={() => fileInput.current?.click()}>
          {Icon.plus}
        </button>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={listening ? 'Listening…' : props.deep ? 'What should I research?' : (props.placeholder ?? 'Message')}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault()
              addFiles(e.clipboardData.files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          autoFocus
        />
        <button className={`mode-btn ${props.deep ? 'on' : ''}`} onClick={() => props.setDeep(!props.deep)} title="DeepSearch: thorough multi-source research">
          {Icon.deep}
          {props.deep && <span>DeepSearch</span>}
        </button>
        <button className={`mode-btn ${props.think ? 'on' : ''}`} onClick={() => props.setThink(!props.think)} title="Think: reason longer before answering">
          {Icon.think}
          {props.think && <span>Think</span>}
        </button>
        {SpeechRecognition && !props.busy && (
          <button className={`mode-btn ${listening ? 'recording' : ''}`} title={listening ? 'Stop dictation' : 'Dictate'} onClick={toggleMic}>
            {Icon.mic}
          </button>
        )}
        {props.busy ? (
          <button className="send" onClick={props.onStop} title="Stop (Esc)">
            {Icon.stop}
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={(!text.trim() && !ready.length) || uploading} title="Send">
            {Icon.send}
          </button>
        )}
      </div>
    </div>
  )
}
