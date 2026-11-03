import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './icons'

export interface MenuItem {
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  checked?: boolean
  disabled?: boolean
  onClick?: () => void
  submenu?: MenuEntry[]
}
export type MenuEntry = MenuItem | 'sep'

export interface MenuState {
  x: number
  y: number
  items: MenuEntry[]
}

/** A context menu at a screen point, kept inside the window. Closes on outside click, Escape, scroll or resize. */
export function Menu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  const [sub, setSub] = useState<number | null>(null)
  const [focus, setFocus] = useState(-1)
  const actionable = menu.items.map((e, i) => (e !== 'sep' && !e.disabled ? i : -1)).filter((i) => i >= 0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    })
  }, [menu.x, menu.y])

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.('.menu')) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const at = actionable.indexOf(focus)
        const next = e.key === 'ArrowDown' ? actionable[(at + 1) % actionable.length] : actionable[(at - 1 + actionable.length) % actionable.length]
        setFocus(next)
      } else if (e.key === 'Enter' && focus >= 0) {
        e.preventDefault()
        const item = menu.items[focus] as MenuItem
        if (item.submenu) setSub(focus)
        else {
          onClose()
          item.onClick?.()
        }
      } else if (e.key === 'ArrowRight' && focus >= 0 && (menu.items[focus] as MenuItem).submenu) setSub(focus)
    }
    const close = () => onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [onClose, focus, actionable, menu.items])

  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((e, i) =>
        e === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div key={i} className="menu-item-wrap" onPointerEnter={() => setSub(e.submenu ? i : null)}>
            <button
              role="menuitem"
              className={`menu-item ${e.danger ? 'danger' : ''} ${focus === i || sub === i ? 'focus' : ''}`}
              disabled={e.disabled}
              onPointerEnter={() => setFocus(i)}
              onClick={() => {
                if (e.submenu) return setSub(sub === i ? null : i)
                onClose()
                e.onClick?.()
              }}
            >
              <span className="menu-icon">{e.checked ? Icon.check : e.icon}</span>
              <span className="menu-label">{e.label}</span>
              {e.hint && <span className="menu-hint">{e.hint}</span>}
              {e.submenu && <span className="menu-arrow">{Icon.chevron}</span>}
            </button>
            {e.submenu && sub === i && <SubMenu items={e.submenu} onClose={onClose} />}
          </div>
        ),
      )}
    </div>
  )
}

function SubMenu({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [flip, setFlip] = useState({ x: false, y: 0 })
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setFlip({ x: r.right > window.innerWidth - 8, y: Math.min(0, window.innerHeight - 8 - r.bottom) })
  }, [])
  return (
    <div ref={ref} className={`menu submenu ${flip.x ? 'left' : ''}`} style={{ marginTop: flip.y }} role="menu">
      {items.map((e, i) =>
        e === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${e.danger ? 'danger' : ''}`}
            disabled={e.disabled}
            onClick={() => {
              onClose()
              e.onClick?.()
            }}
          >
            <span className="menu-icon">{e.checked ? Icon.check : e.icon}</span>
            <span className="menu-label">{e.label}</span>
          </button>
        ),
      )}
    </div>
  )
}

// ---- Confirm dialogs (window.confirm is unreliable inside some desktop webviews) ----

interface Ask {
  title: string
  body?: string
  confirm: string
  danger?: boolean
  resolve: (ok: boolean) => void
}
let showAsk: ((a: Ask | null) => void) | null = null

export function confirmDialog(opts: Omit<Ask, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => (showAsk ? showAsk({ ...opts, resolve }) : resolve(window.confirm(opts.title))))
}

export function DialogHost() {
  const [ask, setAsk] = useState<Ask | null>(null)
  useEffect(() => {
    showAsk = setAsk
    return () => {
      showAsk = null
    }
  }, [])
  useEffect(() => {
    if (!ask) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  if (!ask) return null
  function done(ok: boolean) {
    ask!.resolve(ok)
    setAsk(null)
  }
  return (
    <div className="modal-back" onClick={() => done(false)}>
      <div className="modal confirm" role="alertdialog" onClick={(e) => e.stopPropagation()}>
        <h3>{ask.title}</h3>
        {ask.body && <p className="muted">{ask.body}</p>}
        <div className="edit-row">
          <button className="ghost" onClick={() => done(false)}>
            Cancel
          </button>
          <button className={`primary small ${ask.danger ? 'danger-btn' : ''}`} autoFocus onClick={() => done(true)}>
            {ask.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
