import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bot, Layout } from '@si-bot/shared'
import { Avatar } from './Avatar'
import { Icon } from './icons'
import { Menu, type MenuEntry, type MenuState } from './Menu'

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

/** Pinned bots in their pinned order. */
export function pinnedBots(bots: Bot[]) {
  return bots.filter((b) => b.pinned).sort((a, b) => a.pinSort - b.pinSort)
}

/** Applies a layout change locally, so a drag shows instantly while the server saves it. */
export function applyLayout(bots: Bot[], teams: string[], l: Layout): { bots: Bot[]; teams: string[] } {
  let next = bots
  if (l.order) {
    const byId = new Map(bots.map((b) => [b.id, b]))
    next = l.order.map((o) => ({ ...byId.get(o.id)!, team: o.team })).filter((b) => b.id)
  }
  if (l.pins) {
    const pins = l.pins
    next = next.map((b) => (pins.includes(b.id) ? { ...b, pinned: true, pinSort: pins.indexOf(b.id) } : { ...b, pinned: false }))
  }
  const named = new Set([...(l.teams ?? teams), ...next.map((b) => b.team).filter(Boolean)] as string[])
  return { bots: next, teams: [...(l.teams ?? teams), ...[...named].filter((t) => !(l.teams ?? teams).includes(t))] }
}

export interface SidebarActions {
  open: (id: number) => void
  details: (id: number) => void
  page: (p: Page) => void
  newBot: (team?: string | null) => void
  /** Saves a new arrangement; with a label, an Undo toast says what changed. */
  arrange: (l: Layout, label?: string) => void
  renameBot: (id: number, name: string) => void
  duplicateBot: (b: Bot) => void
  deleteBot: (b: Bot) => void
  markRead: (b: Bot) => void
  createTeam: (name: string) => Promise<void>
  renameTeam: (from: string, to: string) => Promise<void>
  deleteTeam: (name: string) => void
}

type Drag =
  | { kind: 'bot'; id: number; fromPins: boolean; x: number; y: number }
  | { kind: 'team'; name: string; x: number; y: number }

type Drop =
  | { type: 'list'; team: string | null; beforeId: number | null }
  | { type: 'pin'; beforeId: number | null }
  | { type: 'team'; before: string | null }

type Rename = { kind: 'bot'; id: number } | { kind: 'team'; name: string } | { kind: 'new-team' }

function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return s ? JSON.parse(s) : initial
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (x: T) => {
      setV(x)
      try {
        localStorage.setItem(key, JSON.stringify(x))
      } catch {}
    },
    [key],
  )
  return [v, set]
}

export function Sidebar(props: {
  bots: Bot[]
  teams: string[]
  activeId: number | null
  page: Page | null
  unread: (b: Bot) => boolean
  working: Set<number>
  me: string
  width: number
  onResize: (w: number) => void
  actions: SidebarActions
}) {
  const { bots, teams, actions: act } = props
  const pinned = pinnedBots(bots)
  const [collapsed, setCollapsed] = usePref<string[]>('si.collapsed', [])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [rename, setRename] = useState<Rename | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const pending = useRef<{ start: () => Drag; x: number; y: number; touch: boolean; timer?: number; ready: boolean; longPress?: (x: number, y: number) => void } | null>(null)
  const dragged = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const lastY = useRef(0)

  const groups: [string | null, Bot[]][] = [
    ...teams.map((t) => [t, bots.filter((b) => b.team === t)] as [string, Bot[]]),
    [null, bots.filter((b) => !b.team || !teams.includes(b.team))],
  ]
  const key = (t: string | null) => t ?? ''
  const isCollapsed = (t: string | null) => collapsed.includes(key(t))
  const toggle = (t: string | null) => setCollapsed(isCollapsed(t) ? collapsed.filter((c) => c !== key(t)) : [...collapsed, key(t)])

  // ---- Drag and drop (pointer events, so it works the same in the browser, Tauri and on touch screens) ----

  const target = useCallback(
    (d: Drag, x: number, y: number): Drop | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      if (!el) return null
      if (d.kind === 'team') {
        const g = el.closest<HTMLElement>('[data-group]')
        if (!g || g.dataset.group === '') return g ? { type: 'team', before: null } : null
        const name = g.dataset.group!
        const r = g.getBoundingClientRect()
        const i = teams.indexOf(name)
        if (y < r.top + Math.min(r.height / 2, 40)) return { type: 'team', before: name }
        return { type: 'team', before: teams[i + 1] ?? null }
      }
      const pin = el.closest<HTMLElement>('[data-pin]')
      if (pin) {
        const id = Number(pin.dataset.pin)
        const r = pin.getBoundingClientRect()
        const i = pinned.findIndex((b) => b.id === id)
        if (x < r.left + r.width / 2) return { type: 'pin', beforeId: id }
        return { type: 'pin', beforeId: pinned[i + 1]?.id ?? null }
      }
      if (el.closest('.pinned, .pin-drop')) return { type: 'pin', beforeId: null }
      const row = el.closest<HTMLElement>('[data-bot]')
      if (row) {
        const id = Number(row.dataset.bot)
        const team = row.dataset.team || null
        const list = groups.find(([t]) => t === team)?.[1] ?? []
        const i = list.findIndex((b) => b.id === id)
        const r = row.getBoundingClientRect()
        if (y < r.top + r.height / 2) return { type: 'list', team, beforeId: id }
        return { type: 'list', team, beforeId: list[i + 1]?.id ?? null }
      }
      const g = el.closest<HTMLElement>('[data-group]')
      if (g) {
        const team = g.dataset.group || null
        // Dropping on a header puts the bot at the top of that category.
        if (el.closest('.group-head')) {
          const list = groups.find(([t]) => t === team)?.[1] ?? []
          return { type: 'list', team, beforeId: isCollapsed(team) ? null : (list[0]?.id ?? null) }
        }
        return { type: 'list', team, beforeId: null }
      }
      return null
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bots, teams, collapsed],
  )

  function finish(d: Drag, t: Drop | null) {
    if (!t) return
    if (d.kind === 'team') {
      if (t.type !== 'team' || t.before === d.name) return
      const rest = teams.filter((x) => x !== d.name)
      const at = t.before === null ? rest.length : rest.indexOf(t.before)
      rest.splice(at, 0, d.name)
      if (rest.join('\n') !== teams.join('\n')) act.arrange({ teams: rest }, `Moved category ${d.name}`)
      return
    }
    const bot = bots.find((b) => b.id === d.id)
    if (!bot) return
    if (t.type === 'pin') {
      const rest = pinned.filter((b) => b.id !== bot.id).map((b) => b.id)
      const at = t.beforeId === null ? rest.length : rest.indexOf(t.beforeId)
      rest.splice(at < 0 ? rest.length : at, 0, bot.id)
      act.arrange({ pins: rest }, bot.pinned ? undefined : `Pinned ${bot.name}`)
      return
    }
    if (t.type !== 'list' || t.beforeId === bot.id) return
    const rest = bots.filter((b) => b.id !== bot.id)
    let at: number
    if (t.beforeId !== null) at = rest.findIndex((b) => b.id === t.beforeId)
    else {
      const lastOfTeam = rest.map((b, i) => [b, i] as const).filter(([b]) => (b.team || null) === t.team && (t.team === null || teams.includes(t.team))).at(-1)
      at = lastOfTeam ? lastOfTeam[1] + 1 : rest.length
    }
    rest.splice(at < 0 ? rest.length : at, 0, { ...bot, team: t.team })
    const layout: Layout = { order: rest.map((b) => ({ id: b.id, team: b.team || null })) }
    // Dragging a bot out of the pinned row into the list unpins it.
    const unpin = d.fromPins && bot.pinned
    if (unpin) layout.pins = pinned.filter((b) => b.id !== bot.id).map((b) => b.id)
    const moved = (bot.team || null) !== t.team
    act.arrange(
      layout,
      unpin ? `Unpinned ${bot.name}` : moved ? `Moved ${bot.name} to ${t.team ?? 'Unassigned'}` : undefined,
    )
  }

  useEffect(() => {
    function move(e: PointerEvent) {
      const p = pending.current
      lastY.current = e.clientY
      if (drag) {
        e.preventDefault()
        const d = { ...drag, x: e.clientX, y: e.clientY }
        setDrag(d)
        setDrop(target(d, e.clientX, e.clientY))
        return
      }
      if (!p) return
      const far = Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6
      if (!far) return
      if (p.touch && !p.ready) {
        // On touch, moving before the long-press fires means the user is scrolling.
        clearTimeout(p.timer)
        pending.current = null
        return
      }
      const d = { ...p.start(), x: e.clientX, y: e.clientY }
      pending.current = null
      dragged.current = true
      setMenu(null)
      setDrag(d)
      setDrop(target(d, e.clientX, e.clientY))
    }
    function up() {
      const p = pending.current
      if (p) {
        clearTimeout(p.timer)
        pending.current = null
        // A touch held still past the long-press delay opens the menu instead of the bot.
        if (p.touch && p.ready && !drag) {
          dragged.current = true
          p.longPress?.(p.x, p.y)
          setTimeout(() => (dragged.current = false), 400)
        }
      }
      if (drag) {
        finish(drag, drop)
        setDrag(null)
        setDrop(null)
        // The click that follows a drop should not open the bot.
        setTimeout(() => (dragged.current = false), 0)
      }
    }
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape' && drag) {
        setDrag(null)
        setDrop(null)
        setTimeout(() => (dragged.current = false), 0)
      }
    }
    const noScroll = (e: TouchEvent) => drag && e.preventDefault()
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key)
    window.addEventListener('touchmove', noScroll, { passive: false })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key)
      window.removeEventListener('touchmove', noScroll)
    }
  })

  // Scroll the list while dragging near its top or bottom edge.
  useEffect(() => {
    if (!drag) return
    const t = setInterval(() => {
      const el = scroller.current
      if (!el) return
      const r = el.getBoundingClientRect()
      if (lastY.current < r.top + 40) el.scrollTop -= 10
      else if (lastY.current > r.bottom - 40) el.scrollTop += 10
    }, 16)
    return () => clearInterval(t)
  }, [!!drag])

  function grab(e: React.PointerEvent, start: () => Drag, onLongPress?: (x: number, y: number) => void) {
    if (e.button !== 0 || rename) return
    const touch = e.pointerType === 'touch'
    const p = { start, x: e.clientX, y: e.clientY, touch, ready: !touch, timer: undefined as number | undefined, longPress: onLongPress }
    if (touch) {
      // After a short hold, moving drags and letting go opens the menu.
      p.timer = window.setTimeout(() => {
        p.ready = true
        navigator.vibrate?.(10)
      }, 380)
    }
    pending.current = p
  }

  // ---- Menus ----

  function botMenu(b: Bot): MenuEntry[] {
    const moveTo: MenuEntry[] = [
      ...teams.map((t) => ({ label: t, icon: Icon.folder, checked: b.team === t, onClick: () => moveBot(b, t) })),
      { label: 'Unassigned', icon: Icon.folder, checked: !b.team || !teams.includes(b.team), onClick: () => moveBot(b, null) },
      'sep',
      {
        label: 'New category…',
        icon: Icon.plus,
        onClick: () => {
          pendingMove.current = b.id
          setRename({ kind: 'new-team' })
        },
      },
    ]
    return [
      { label: 'Open', icon: Icon.chat, onClick: () => act.open(b.id) },
      { label: 'Details', icon: Icon.info, onClick: () => act.details(b.id) },
      'sep',
      { label: 'Rename', icon: Icon.edit, hint: 'F2', onClick: () => setRename({ kind: 'bot', id: b.id }) },
      b.pinned
        ? { label: 'Unpin', icon: Icon.unpin, onClick: () => act.arrange({ pins: pinned.filter((x) => x.id !== b.id).map((x) => x.id) }, `Unpinned ${b.name}`) }
        : { label: 'Pin to top', icon: Icon.pin, onClick: () => act.arrange({ pins: [...pinned.map((x) => x.id), b.id] }, `Pinned ${b.name}`) },
      { label: 'Move to', icon: Icon.folder, submenu: moveTo },
      ...(props.unread(b) ? [{ label: 'Mark as read', icon: Icon.eye, onClick: () => act.markRead(b) }] : []),
      { label: 'Duplicate', icon: Icon.copy, onClick: () => act.duplicateBot(b) },
      'sep',
      { label: 'Delete…', icon: Icon.trash, danger: true, onClick: () => act.deleteBot(b) },
    ]
  }

  function teamMenu(t: string | null): MenuEntry[] {
    if (t === null)
      return [
        { label: 'New bot here', icon: Icon.plus, onClick: () => act.newBot(null) },
        { label: isCollapsed(null) ? 'Expand' : 'Collapse', icon: Icon.chevron, onClick: () => toggle(null) },
      ]
    return [
      { label: 'New bot here', icon: Icon.plus, onClick: () => act.newBot(t) },
      { label: 'Rename category', icon: Icon.edit, onClick: () => setRename({ kind: 'team', name: t }) },
      { label: isCollapsed(t) ? 'Expand' : 'Collapse', icon: Icon.chevron, onClick: () => toggle(t) },
      'sep',
      { label: 'Delete category', icon: Icon.trash, danger: true, onClick: () => act.deleteTeam(t) },
    ]
  }

  const pendingMove = useRef<number | null>(null)

  function moveBot(b: Bot, team: string | null) {
    const rest = bots.filter((x) => x.id !== b.id)
    const last = rest.map((x, i) => [x, i] as const).filter(([x]) => (x.team || null) === team).at(-1)
    rest.splice(last ? last[1] + 1 : rest.length, 0, { ...b, team })
    act.arrange({ order: rest.map((x) => ({ id: x.id, team: x.team || null })) }, `Moved ${b.name} to ${team ?? 'Unassigned'}`)
  }

  function openMenu(e: React.MouseEvent, items: MenuEntry[]) {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    // Keyboard-opened context menus have no pointer position.
    const fromKey = e.clientX === 0 && e.clientY === 0
    setMenu({ x: fromKey ? r.left + 24 : e.clientX, y: fromKey ? r.bottom : e.clientY, items })
  }

  function moreMenu(e: React.MouseEvent, items: MenuEntry[]) {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: r.right - 4, y: r.bottom + 4, items })
  }

  // ---- Rendering ----

  const dropLine = (id: number | null, team: string | null) =>
    drop?.type === 'list' && drop.beforeId === id && (id !== null || drop.team === team)

  function botRow(b: Bot, team: string | null) {
    const renaming = rename?.kind === 'bot' && rename.id === b.id
    const active = props.activeId === b.id && !props.page
    const isDragged = drag?.kind === 'bot' && drag.id === b.id
    return (
      <div key={b.id} className="row-wrap">
        {dropLine(b.id, team) && <div className="drop-line" />}
        <div
          role="button"
          tabIndex={0}
          data-bot={b.id}
          data-team={team ?? ''}
          className={`bot-row ${active ? 'active' : ''} ${isDragged ? 'dragging' : ''}`}
          onPointerDown={(e) => grab(e, () => ({ kind: 'bot', id: b.id, fromPins: false, x: 0, y: 0 }), (x, y) => setMenu({ x, y, items: botMenu(b) }))}
          onClick={() => !dragged.current && !renaming && act.open(b.id)}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('.bot-row-name')) setRename({ kind: 'bot', id: b.id })
          }}
          onKeyDown={(e) => {
            if (renaming) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              act.open(b.id)
            } else if (e.key === 'F2') setRename({ kind: 'bot', id: b.id })
            else if (e.key === 'Delete') act.deleteBot(b)
          }}
          onContextMenu={(e) => openMenu(e, botMenu(b))}
          title={renaming ? undefined : label(b)}
        >
          <span className="bot-row-avatar">
            <Avatar avatar={b.avatar} name={b.name} size={36} />
            {props.working.has(b.id) && <i className="pin-working" />}
          </span>
          <span className="bot-row-text">
            <span className="bot-row-top">
              {renaming ? (
                <InlineInput
                  value={b.name}
                  onDone={(v) => {
                    setRename(null)
                    if (v && v !== b.name) act.renameBot(b.id, v)
                  }}
                />
              ) : (
                <span className="bot-row-name">
                  {b.name}
                  {b.role && <span className="bot-row-role"> · {b.role}</span>}
                </span>
              )}
              {!renaming && b.lastMessage && <span className="bot-row-time">{relTime(b.lastMessage.createdAt)}</span>}
            </span>
            <span className="bot-row-preview">
              {props.working.has(b.id) ? <em>Working…</em> : (b.lastMessage?.preview ?? <em>Say hi</em>)}
            </span>
          </span>
          {props.unread(b) && <i className="unread-dot" />}
          {!renaming && (
            <button className="row-more" title="More" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => moreMenu(e, botMenu(b))}>
              {Icon.more}
            </button>
          )}
        </div>
      </div>
    )
  }

  const draggingBot = drag?.kind === 'bot' ? bots.find((b) => b.id === drag.id) : undefined
  const draggingTeam = drag?.kind === 'team' ? drag.name : null

  return (
    <aside className={`sidebar ${drag ? 'is-dragging' : ''}`}>
      <div className="side-top">
        <button className={`round-btn ${props.page === 'search' ? 'active' : ''}`} title="Search everything (Ctrl+K)" onClick={() => act.page('search')}>
          {Icon.search}
        </button>
        <button
          className="round-btn"
          title="New bot or category"
          onClick={(e) =>
            moreMenu(e, [
              { label: 'New bot', icon: Icon.bot, onClick: () => act.newBot() },
              { label: 'New category', icon: Icon.folder, onClick: () => setRename({ kind: 'new-team' }) },
            ])
          }
        >
          {Icon.plus}
        </button>
      </div>

      <div className="side-scroll" ref={scroller}>
        {(pinned.length > 0 || drag?.kind === 'bot') && (
          <div className={`pinned ${drop?.type === 'pin' ? 'drop-into' : ''} ${pinned.length === 0 ? 'empty' : ''}`}>
            {pinned.map((b) => (
              <div key={b.id} className="pin-wrap">
                {drop?.type === 'pin' && drop.beforeId === b.id && <i className="pin-drop-line" />}
                <button
                  data-pin={b.id}
                  className={`pin ${props.activeId === b.id && !props.page ? 'active' : ''} ${drag?.kind === 'bot' && drag.id === b.id ? 'dragging' : ''}`}
                  onPointerDown={(e) => grab(e, () => ({ kind: 'bot', id: b.id, fromPins: true, x: 0, y: 0 }), (x, y) => setMenu({ x, y, items: botMenu(b) }))}
                  onClick={() => !dragged.current && act.open(b.id)}
                  onContextMenu={(e) => openMenu(e, botMenu(b))}
                  title={label(b)}
                >
                  <span className="pin-avatar">
                    <Avatar avatar={b.avatar} name={b.name} size={56} />
                    {props.unread(b) && <i className="pin-dot" />}
                    {props.working.has(b.id) && <i className="pin-working" />}
                  </span>
                  <span className="pin-label">{b.name}</span>
                </button>
              </div>
            ))}
            {pinned.length === 0 && <div className="pin-drop">{Icon.pin} Drop here to pin</div>}
            {drop?.type === 'pin' && drop.beforeId === null && pinned.length > 0 && <i className="pin-drop-line end" />}
          </div>
        )}

        {groups.map(([team, list]) => {
          if (team === null && list.length === 0 && !drag && teams.length > 0) return null
          const closed = isCollapsed(team)
          const renamingTeam = team !== null && rename?.kind === 'team' && rename.name === team
          const teamDropBefore = drop?.type === 'team' && drop.before === team && team !== null
          return (
            <div
              key={key(team)}
              data-group={key(team)}
              className={`group ${draggingTeam !== null && draggingTeam === team ? 'dragging' : ''} ${drop?.type === 'list' && drop.team === team ? 'drop-target' : ''}`}
            >
              {teamDropBefore && <div className="drop-line team" />}
              <div
                className="group-head"
                onPointerDown={team !== null ? (e) => grab(e, () => ({ kind: 'team', name: team, x: 0, y: 0 }), (x, y) => setMenu({ x, y, items: teamMenu(team) })) : undefined}
                onClick={() => !dragged.current && !renamingTeam && toggle(team)}
                onDoubleClick={() => team !== null && setRename({ kind: 'team', name: team })}
                onContextMenu={(e) => openMenu(e, teamMenu(team))}
              >
                <span className={`group-chev ${closed ? '' : 'open'}`}>{Icon.chevron}</span>
                {renamingTeam ? (
                  <InlineInput
                    value={team}
                    onDone={async (v) => {
                      setRename(null)
                      if (v && v !== team) await act.renameTeam(team, v)
                    }}
                  />
                ) : (
                  <span className="group-name">{team ?? 'Unassigned'}</span>
                )}
                {closed && list.length > 0 && <span className="group-count">{list.length}</span>}
                {!renamingTeam && (
                  <span className="group-tools">
                    <button title="New bot here" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), act.newBot(team))}>
                      {Icon.plus}
                    </button>
                    <button title="More" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => moreMenu(e, teamMenu(team))}>
                      {Icon.more}
                    </button>
                  </span>
                )}
              </div>
              {!closed && list.map((b) => botRow(b, team))}
              {!closed && list.length === 0 && <div className="group-empty">{drag?.kind === 'bot' ? 'Drop here' : 'Drag bots here'}</div>}
              {dropLine(null, team) && list.length > 0 && !closed && <div className="drop-line" />}
            </div>
          )
        })}
        {drop?.type === 'team' && drop.before === null && <div className="drop-line team" />}

        {rename?.kind === 'new-team' && (
          <div className="group new-group">
            <div className="group-head">
              <span className="group-chev open">{Icon.chevron}</span>
              <InlineInput
                value=""
                placeholder="Category name"
                onDone={async (v) => {
                  setRename(null)
                  const id = pendingMove.current
                  pendingMove.current = null
                  if (!v) return
                  await act.createTeam(v)
                  const b = id ? bots.find((x) => x.id === id) : undefined
                  if (b) moveBot(b, v)
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="side-bottom">
        <button className={`me ${props.page === 'settings' ? 'active' : ''}`} title="Settings" onClick={() => act.page('settings')}>
          {props.me.trim() ? props.me.trim()[0].toUpperCase() : Icon.settings}
        </button>
        <button className={`side-link ${props.page === 'tasks' ? 'active' : ''}`} onClick={() => act.page('tasks')}>
          {Icon.tasks}
          Tasks
        </button>
        <button className={`side-link ${props.page === 'memory' ? 'active' : ''}`} onClick={() => act.page('memory')}>
          {Icon.memory}
          Memory
        </button>
      </div>

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
          {draggingBot && (
            <>
              <Avatar avatar={draggingBot.avatar} name={draggingBot.name} size={28} />
              <span>{draggingBot.name}</span>
            </>
          )}
          {draggingTeam && (
            <>
              {Icon.folder}
              <span>{draggingTeam}</span>
            </>
          )}
        </div>
      )}
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
      <div
        className="side-resize"
        title="Drag to resize, double-click to reset"
        onDoubleClick={() => props.onResize(280)}
        onPointerDown={(e) => {
          e.preventDefault()
          const startX = e.clientX
          const startW = props.width
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          el.classList.add('active')
          const move = (ev: PointerEvent) => props.onResize(Math.max(220, Math.min(440, startW + ev.clientX - startX)))
          const up = () => {
            el.classList.remove('active')
            el.removeEventListener('pointermove', move)
            el.removeEventListener('pointerup', up)
          }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', up)
        }}
      />
    </aside>
  )
}

/** A text field that edits in place: Enter or leaving it saves, Escape cancels. */
function InlineInput(props: { value: string; placeholder?: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(props.value)
  const done = useRef(false)
  const finish = (val: string | null) => {
    if (done.current) return
    done.current = true
    props.onDone(val === null ? null : val.trim())
  }
  return (
    <input
      className="inline-input"
      value={v}
      placeholder={props.placeholder}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(v)
        else if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(v)}
      maxLength={60}
    />
  )
}
