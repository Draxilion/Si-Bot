import type { Bot } from '@si-bot/shared'
import { Avatar } from './Avatar'
import { Icon } from './icons'

export type Page = 'search' | 'tasks' | 'memory' | 'settings'

function label(b: Bot) {
  return b.role ? `${b.name} · ${b.role}` : b.name
}

function relTime(iso: string) {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (new Date().toDateString() === d.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (diff < 7 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function Sidebar(props: {
  bots: Bot[]
  activeId: number | null
  page: Page | null
  unread: (b: Bot) => boolean
  working: Set<number>
  onOpen: (id: number) => void
  onPage: (p: Page) => void
  onNewBot: () => void
  me: string
}) {
  const { bots } = props
  const pinned = bots.filter((b) => b.pinned)
  const teams = [...new Set(bots.map((b) => b.team).filter(Boolean))] as string[]
  const groups: [string, Bot[]][] = [
    ...teams.map((t) => [t, bots.filter((b) => b.team === t)] as [string, Bot[]]),
    ['Unassigned', bots.filter((b) => !b.team)],
  ].filter(([, list]) => (list as Bot[]).length > 0) as [string, Bot[]][]

  return (
    <aside className="sidebar">
      <div className="side-top">
        <button className={`round-btn ${props.page === 'search' ? 'active' : ''}`} title="Search everything" onClick={() => props.onPage('search')}>
          {Icon.search}
        </button>
        <button className="round-btn" title="New bot" onClick={props.onNewBot}>
          {Icon.plus}
        </button>
      </div>

      <div className="side-scroll">
        {pinned.length > 0 && (
          <div className="pinned">
            {pinned.map((b) => (
              <button key={b.id} className={`pin ${props.activeId === b.id && !props.page ? 'active' : ''}`} onClick={() => props.onOpen(b.id)} title={label(b)}>
                <span className="pin-avatar">
                  <Avatar avatar={b.avatar} name={b.name} size={56} />
                  {props.unread(b) && <i className="pin-dot" />}
                  {props.working.has(b.id) && <i className="pin-working" />}
                </span>
                <span className="pin-label">{b.name}</span>
              </button>
            ))}
          </div>
        )}

        {groups.map(([team, list]) => (
          <div key={team} className="group">
            <div className="group-name">{team}</div>
            {list.map((b) => (
              <button key={b.id} className={`bot-row ${props.activeId === b.id && !props.page ? 'active' : ''}`} onClick={() => props.onOpen(b.id)}>
                <Avatar avatar={b.avatar} name={b.name} size={36} />
                <span className="bot-row-text">
                  <span className="bot-row-top">
                    <span className="bot-row-name">{label(b)}</span>
                    {b.lastMessage && <span className="bot-row-time">{relTime(b.lastMessage.createdAt)}</span>}
                  </span>
                  <span className="bot-row-preview">
                    {props.working.has(b.id) ? <em>Working…</em> : (b.lastMessage?.preview ?? <em>Say hi</em>)}
                  </span>
                </span>
                {props.unread(b) && <i className="unread-dot" />}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="side-bottom">
        <button className={`me ${props.page === 'settings' ? 'active' : ''}`} title="Settings" onClick={() => props.onPage('settings')}>
          {props.me.trim() ? props.me.trim()[0].toUpperCase() : Icon.settings}
        </button>
        <button className={`side-link ${props.page === 'tasks' ? 'active' : ''}`} onClick={() => props.onPage('tasks')}>
          {Icon.tasks}
          Tasks
        </button>
        <button className={`side-link ${props.page === 'memory' ? 'active' : ''}`} onClick={() => props.onPage('memory')}>
          {Icon.memory}
          Memory
        </button>
      </div>
    </aside>
  )
}
