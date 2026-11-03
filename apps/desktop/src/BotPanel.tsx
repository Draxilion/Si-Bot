import { useEffect, useState } from 'react'
import type { Activity, Bot, BotInput, LibraryItem, ModelOption, Task } from '@si-bot/shared'
import type { Api } from './api'
import { AVATAR_STYLES, Avatar, randomAvatar } from './Avatar'
import { PROVIDER_NAMES } from './Composer'
import { Icon } from './icons'
import { Step } from './Message'
import { ContextEditors } from './Pages'

type Tab = 'details' | 'library' | 'computer'

export function BotPanel(props: {
  api: Api
  bot: Bot
  bots: Bot[]
  models: ModelOption[]
  defaultModel: string
  /** Bumped whenever the bot's timeline changes, so Library and Computer refresh. */
  version: number
  onSaved: (bots: Bot[]) => void
  onDeleted: (bots: Bot[]) => void
  onClose: () => void
}) {
  const { bot } = props
  const [tab, setTab] = useState<Tab>('details')
  return (
    <aside className="panel">
      <div className="panel-top">
        <button className="round-btn" title="Close" onClick={props.onClose}>
          {Icon.close}
        </button>
      </div>
      <div className="panel-head">
        <Avatar avatar={bot.avatar} name={bot.name} size={72} />
        <h3>{bot.role ? `${bot.name} · ${bot.role}` : bot.name}</h3>
        <div className="tabs">
          {(['details', 'library', 'computer'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body">
        {tab === 'details' && <Details key={bot.id} {...props} />}
        {tab === 'library' && <Library api={props.api} botId={bot.id} version={props.version} />}
        {tab === 'computer' && <Computer api={props.api} botId={bot.id} version={props.version} />}
      </div>
    </aside>
  )
}

function Details(props: React.ComponentProps<typeof BotPanel>) {
  const { api, bot } = props
  const [form, setForm] = useState<BotInput>({ ...bot })
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const teams = [...new Set(props.bots.map((b) => b.team).filter(Boolean))] as string[]
  const dirty = (['name', 'role', 'avatar', 'instructions', 'model', 'team', 'pinned'] as const).some(
    (k) => (form[k] ?? null) !== ((bot as any)[k] ?? null),
  )

  useEffect(() => {
    api.tasks(bot.id).then((r) => setTasks(r.tasks), () => {})
  }, [api, bot.id, props.version])

  const set = (patch: BotInput) => setForm((f) => ({ ...f, ...patch }))
  const style = form.avatar?.startsWith('dicebear:') ? form.avatar.split(':')[1] : 'adventurer'

  async function save() {
    try {
      const r = await api.updateBot(bot.id, form)
      props.onSaved(r.bots)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div className="details">
      <div className="avatar-edit">
        <Avatar avatar={form.avatar ?? bot.avatar} name={form.name ?? bot.name} size={48} />
        <button className="ghost small" onClick={() => set({ avatar: randomAvatar(form.name ?? bot.name, style) })}>
          New look
        </button>
        <select className="ghost small" value={style} onChange={(e) => set({ avatar: randomAvatar(form.name ?? bot.name, e.target.value) })}>
          {AVATAR_STYLES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <label className="ghost small upload">
          Upload
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const { file } = await api.upload(f)
              set({ avatar: `file:${file.id}` })
            }}
          />
        </label>
      </div>
      <label>
        Name
        <input value={form.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label>
        Role
        <input value={form.role ?? ''} onChange={(e) => set({ role: e.target.value })} placeholder="e.g. Trucking specialist" />
      </label>
      <div className="row2">
        <label>
          Team
          <input list="teams" value={form.team ?? ''} onChange={(e) => set({ team: e.target.value })} placeholder="Unassigned" />
          <datalist id="teams">
            {teams.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="pin-toggle">
          Pinned
          <button className={`toggle ${form.pinned ? 'on' : ''}`} onClick={() => set({ pinned: !form.pinned })} type="button">
            <span />
          </button>
        </label>
      </div>
      <label>
        Model
        <select value={form.model ?? ''} onChange={(e) => set({ model: e.target.value || null })}>
          <option value="">Default ({props.models.find((m) => m.id === props.defaultModel)?.label.replace(/\s*\(.*\)$/, '') ?? 'none'})</option>
          {[...new Set(props.models.map((m) => m.provider))].map((p) => (
            <optgroup key={p} label={PROVIDER_NAMES[p] ?? p}>
              {props.models
                .filter((m) => m.provider === p)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label.replace(/\s*\(.*\)$/, '')}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        Instructions
        <textarea
          rows={5}
          value={form.instructions ?? ''}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder="How this bot should behave, what it specialises in, its tone…"
        />
      </label>
      <button className="primary small" disabled={!dirty} onClick={save}>
        {saved ? 'Saved' : 'Save changes'}
      </button>
      {error && <div className="error">{error}</div>}

      {tasks.length > 0 && (
        <>
          <div className="panel-section">Scheduled</div>
          <ul className="mini-list">
            {tasks.map((t) => (
              <li key={t.id} className={t.enabled ? '' : 'off'}>
                {Icon.tasks}
                <span>
                  {t.title}
                  <small>
                    {t.enabled && t.nextRunAt
                      ? `next ${new Date(t.nextRunAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
                      : 'done'}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="panel-section">Memory</div>
      <ContextEditors api={api} botId={bot.id} />

      <button
        className="link-btn danger-link"
        onClick={async () => {
          if (!confirm(`Delete ${bot.name} and its whole timeline? This can't be undone.`)) return
          try {
            props.onDeleted((await api.deleteBot(bot.id)).bots)
          } catch (e: any) {
            setError(e.message)
          }
        }}
      >
        Delete bot
      </button>
    </div>
  )
}

function bucket(iso: string) {
  const d = new Date(iso)
  if (d.toDateString() === new Date().toDateString()) return 'Today'
  if (Date.now() - d.getTime() < 7 * 86_400_000) return 'This week'
  return 'Older'
}

function Library({ api, botId, version }: { api: Api; botId: number; version: number }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  useEffect(() => {
    api.library(botId).then((r) => setItems(r.items), () => setItems([]))
  }, [api, botId, version])
  if (!items) return null
  if (!items.length) return <p className="muted small pad">Files you share with this bot and images it makes will collect here.</p>
  const groups = ['Today', 'This week', 'Older'].map((g) => [g, items.filter((i) => bucket(i.createdAt) === g)] as const)
  return (
    <div className="library">
      {groups
        .filter(([, list]) => list.length)
        .map(([g, list]) => (
          <div key={g}>
            <div className="panel-section">{g}</div>
            <ul className="card-list">
              {list.map((i) => (
                <li key={i.id}>
                  <a href={api.fileUrl(i.id)} target="_blank" rel="noreferrer">
                    {i.mediaType.startsWith('image/') ? <img src={api.fileUrl(i.id)} alt="" /> : <span className="file-ico">{Icon.file}</span>}
                    <span className="lib-name">{i.name}</span>
                    {i.generated && <span className="lib-tag">made</span>}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  )
}

function Computer({ api, botId, version }: { api: Api; botId: number; version: number }) {
  const [items, setItems] = useState<Activity[] | null>(null)
  useEffect(() => {
    api.activity(botId).then((r) => setItems(r.items), () => setItems([]))
  }, [api, botId, version])
  if (!items) return null
  if (!items.length) return <p className="muted small pad">Searches, pages read and code runs this bot does show up here.</p>
  return (
    <div className="computer">
      <p className="muted small">What this bot did on its computer, newest first.</p>
      <div className="steps">
        {items.map((s) => (
          <div key={`${s.messageId}-${s.id}`} className="activity">
            <span className="activity-time">
              {new Date(s.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
            <Step step={s} />
          </div>
        ))}
      </div>
    </div>
  )
}
