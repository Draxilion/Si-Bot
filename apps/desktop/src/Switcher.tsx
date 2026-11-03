import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Bot } from '@si-bot/shared'
import { Avatar } from './Avatar'
import { Icon } from './icons'

export interface SwitcherAction {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  run: () => void
}

function score(b: Bot, q: string) {
  const name = b.name.toLowerCase()
  if (!q) return 1
  if (name.startsWith(q)) return 4
  if (name.includes(q)) return 3
  if (b.role.toLowerCase().includes(q) || (b.team ?? '').toLowerCase().includes(q)) return 2
  // Letters in order, e.g. "rsy" finds Researchy.
  let i = 0
  for (const ch of name) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

/** Ctrl+K: jump to any bot or run a command by typing. */
export function Switcher(props: {
  bots: Bot[]
  recent: number[]
  actions: (query: string) => SwitcherAction[]
  onOpen: (id: number) => void
  onClose: () => void
  unread: (b: Bot) => boolean
}) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const query = q.trim().toLowerCase()

  const items = useMemo(() => {
    const rank = (b: Bot) => {
      const r = props.recent.indexOf(b.id)
      return r < 0 ? 999 : r
    }
    const bots = props.bots
      .map((b) => ({ b, s: score(b, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || rank(a.b) - rank(b.b))
      .map(({ b }) => ({
        id: `bot-${b.id}`,
        label: b.name,
        hint: [b.role, b.team].filter(Boolean).join(' · '),
        icon: <Avatar avatar={b.avatar} name={b.name} size={28} />,
        unread: props.unread(b),
        run: () => props.onOpen(b.id),
      }))
    const acts = props.actions(q.trim()).filter((a) => !query || a.label.toLowerCase().includes(query) || a.id === 'search')
    return [...bots, ...acts.map((a) => ({ ...a, unread: false }))]
  }, [props, query, q])

  useEffect(() => setSel(0), [query])
  useEffect(() => {
    list.current?.querySelector('.sw-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function run(i: number) {
    const it = items[i]
    if (!it) return
    props.onClose()
    it.run()
  }

  return (
    <div className="modal-back sw-back" onClick={props.onClose}>
      <div className="switcher" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Go to bot">
        <div className="sw-input">
          {Icon.search}
          <input
            autoFocus
            value={q}
            placeholder="Go to a bot, or type a command…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(items.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(sel)
              } else if (e.key === 'Escape') props.onClose()
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="sw-list" ref={list}>
          {items.map((it, i) => (
            <button key={it.id} className={`sw-item ${i === sel ? 'sel' : ''}`} onPointerMove={() => setSel(i)} onClick={() => run(i)}>
              <span className="sw-icon">{it.icon}</span>
              <span className="sw-label">{it.label}</span>
              {it.hint && <span className="sw-hint">{it.hint}</span>}
              {it.unread && <i className="unread-dot" />}
            </button>
          ))}
          {items.length === 0 && <div className="sw-empty muted">Nothing matches</div>}
        </div>
      </div>
    </div>
  )
}
