import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentMeta, Bot, Layout, Message, ModelOption, Task } from '@si-bot/shared'
import { Api, loadConnection, saveConnection, type Connection, type Roster } from './api'
import { Icon } from './icons'
import { AssistantMessage, BotsContext, UserMessage, type LiveReply } from './Message'
import { Composer } from './Composer'
import { setFileResolver } from './Markdown'
import { Avatar, randomAvatar, setAvatarFileResolver } from './Avatar'
import { Sidebar, applyLayout, pinnedBots as pinnedBotsOf, type Page, type SidebarActions } from './Sidebar'
import { DialogHost, confirmDialog } from './Menu'
import { Switcher } from './Switcher'
import { BotPanel } from './BotPanel'
import { DayDivider, MemoryView, SearchView, SettingsView, TasksView } from './Pages'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

function usePref<T>(key: string, initial: T): [T, (v: T | ((cur: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return s === null ? initial : (JSON.parse(s) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T | ((cur: T) => T)) =>
      setV((cur) => {
        const value = typeof next === 'function' ? (next as (c: T) => T)(cur) : next
        try {
          localStorage.setItem(key, JSON.stringify(value))
        } catch {}
        return value
      }),
    [key],
  )
  return [v, set]
}

const label = (b: Bot) => (b.role ? `${b.name} · ${b.role}` : b.name)

interface SendOpts {
  text?: string
  files?: AttachmentMeta[]
  replaceFrom?: number
  regenerate?: boolean
}

export default function App() {
  const [conn, setConn] = useState<Connection>(loadConnection)
  const api = useMemo(() => new Api(conn), [conn])
  setFileResolver(api.fileUrl)
  setAvatarFileResolver(api.fileUrl)

  const [bots, setBots] = useState<Bot[]>([])
  const [teams, setTeams] = useState<string[]>([])
  const [activeId, setActiveId] = usePref<number | null>('si.bot', null)
  const [page, setPage] = useState<Page | null>(conn.token ? null : 'settings')
  const [panelOpen, setPanelOpen] = usePref('si.panel', window.innerWidth > 1100)
  const [read, setRead] = usePref<Record<string, number>>('si.read', {})
  const [me, setMe] = usePref('si.me', '')
  const [models, setModels] = useState<ModelOption[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [timelines, setTimelines] = useState<Record<number, Message[]>>({})
  const [hasOlder, setHasOlder] = useState<Record<number, boolean>>({})
  const [think, setThink] = usePref('si.think', false)
  const [deep, setDeep] = usePref('si.deep', false)
  const [live, setLive] = useState<{ botId: number; reply: LiveReply } | null>(null)
  const [suggestions, setSuggestions] = useState<{ botId: number; list: string[] } | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState<{ botId: number; text: string } | null>(null)
  const [switcher, setSwitcher] = useState(false)
  // Phones show either the bot list or one chat.
  const [mobileList, setMobileList] = useState(true)
  const [toast, setToast] = useState<{ text: string; undo?: () => void; n: number } | null>(null)
  const [sideW, setSideW] = usePref('si.sideWidth', 280)
  const [recent, setRecent] = usePref<number[]>('si.recent', [])
  const [newBot, setNewBot] = useState<{ team: string | null } | null>(null)
  const [version, setVersion] = useState(0)
  const abort = useRef<AbortController | null>(null)
  const searchSeed = useRef('')

  const bot = bots.find((b) => b.id === activeId) ?? bots[0]
  const messages = (bot && timelines[bot.id]) ?? []

  // Saves in flight from drags and renames; a poll that lands meanwhile must not undo what the user just did.
  const saving = useRef(0)
  const setRoster = useCallback((r: Roster) => {
    setBots(r.bots)
    setTeams(r.teams)
  }, [])
  const refreshBots = useCallback(async () => {
    const r = await api.bots()
    if (!saving.current) setRoster(r)
    return r.bots
  }, [api, setRoster])

  /** Applies a change to the roster instantly, then saves it; on failure, reloads what the server has. */
  const mutate = useCallback(
    async (local: ((r: Roster) => Roster) | null, save: () => Promise<Roster>) => {
      if (local) {
        const cur = local({ bots: botsRef.current, teams: teamsRef.current })
        setRoster(cur)
      }
      saving.current++
      try {
        const r = await save()
        saving.current--
        if (!saving.current) setRoster(r)
        return r
      } catch (e: any) {
        saving.current--
        setError({ botId: 0, text: e.message })
        setTimeout(() => setError(null), 4000)
        refreshBots().catch(() => {})
        return null
      }
    },
    [setRoster, refreshBots],
  )
  const botsRef = useRef(bots)
  botsRef.current = bots
  const teamsRef = useRef(teams)
  teamsRef.current = teams

  // Load bots, models and tasks. If the server is down (Docker still starting, laptop just woke up),
  // keep retrying so the app recovers by itself instead of showing a stale error.
  useEffect(() => {
    if (!conn.token) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let failed = false
    const load = () =>
      Promise.all([refreshBots(), api.models(), api.tasks()])
        .then(([, m, t]) => {
          if (cancelled) return
          setModels(m.models)
          setDefaultModel(m.default ?? '')
          setTasks(t.tasks)
          setError(null)
          // Timelines that failed to load while offline are fetched again.
          if (failed) setTimelines({})
        })
        .catch((e) => {
          if (cancelled) return
          failed = true
          setError({ botId: 0, text: e.message })
          if (e.message !== 'Wrong access token') retry = setTimeout(load, 3000)
        })
    load()
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [api, conn, refreshBots])

  // Load a bot's timeline the first time it is opened.
  useEffect(() => {
    if (!bot || timelines[bot.id]) return
    api.messages(bot.id).then(
      (r) => {
        setTimelines((t) => ({ ...t, [bot.id]: r.messages }))
        setHasOlder((h) => ({ ...h, [bot.id]: r.messages.length === 100 }))
      },
      () => {},
    )
  }, [api, bot, timelines])

  // Opening a bot marks it read.
  const lastId = messages.at(-1)?.id ?? 0
  useEffect(() => {
    if (bot && !page && lastId && (read[bot.id] ?? 0) < lastId) setRead((r) => ({ ...r, [bot.id]: lastId }))
  }, [bot, page, lastId, read, setRead])

  // Other bots keep working (tasks, messages from bots): poll the sidebar and the open timeline.
  useEffect(() => {
    if (!conn.token) return
    const timer = setInterval(async () => {
      try {
        const fresh = await refreshBots()
        if (bot && !live) {
          const newest = fresh.find((b) => b.id === bot.id)?.lastMessage?.id ?? 0
          if (newest > lastId) {
            const { messages: more } = await api.newer(bot.id, lastId)
            setTimelines((t) => ({ ...t, [bot.id]: [...(t[bot.id] ?? []), ...more.filter((m) => !(t[bot.id] ?? []).some((x) => x.id === m.id))] }))
            setVersion((v) => v + 1)
          }
        }
        // Notify about new task results in other bots while the window is hidden.
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          for (const b of fresh) {
            const lm = b.lastMessage
            if (lm && lm.role === 'assistant' && lm.id > (read[b.id] ?? 0) && lm.id > (notified.current[b.id] ?? 0)) {
              notified.current[b.id] = lm.id
              new Notification(label(b), { body: lm.preview })
            }
          }
        }
      } catch {}
    }, 12_000)
    return () => clearInterval(timer)
  }, [api, conn.token, bot, live, lastId, refreshBots, read])
  const notified = useRef<Record<number, number>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') abort.current?.abort()
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSwitcher((v) => !v)
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Next / previous bot in sidebar order.
        e.preventDefault()
        stepBot.current(e.key === 'ArrowDown' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setTimeline = (id: number, fn: (m: Message[]) => Message[]) => setTimelines((t) => ({ ...t, [id]: fn(t[id] ?? []) }))

  async function send(target: Bot, opts: SendOpts) {
    const id = target.id
    setError(null)
    setSuggestions(null)
    if (opts.replaceFrom) setTimeline(id, (m) => m.filter((x) => x.id < opts.replaceFrom!))
    if (opts.regenerate) {
      const lastUser = [...(timelines[id] ?? [])].reverse().find((m) => m.role === 'user' && !m.fromBotId)
      if (lastUser) setTimeline(id, (m) => m.filter((x) => x.id <= lastUser.id))
    }
    const update = (fn: (r: LiveReply) => LiveReply) => setLive((l) => (l && l.botId === id ? { botId: id, reply: fn(l.reply) } : l))
    setLive({ botId: id, reply: { text: '', reasoning: '', reasoningDone: false, steps: [], sources: [], startedAt: Date.now() } })
    const ctrl = new AbortController()
    abort.current = ctrl
    if (/remind|every (day|week|morning)|schedule/i.test(opts.text ?? '') && 'Notification' in window) {
      Notification.requestPermission().catch(() => {})
    }
    try {
      await api.chat(
        {
          botId: id,
          content: opts.text ?? '',
          think,
          deep,
          timezone: TZ,
          attachments: opts.files?.map((f) => f.id),
          replaceFrom: opts.replaceFrom,
          regenerate: opts.regenerate,
        },
        (e) => {
          if (e.type === 'user') setTimeline(id, (m) => [...m.filter((x) => x.id !== e.message.id), e.message])
          else if (e.type === 'reasoning') update((r) => ({ ...r, reasoning: r.reasoning + e.text }))
          else if (e.type === 'delta') update((r) => ({ ...r, text: r.text + e.text, reasoningDone: true }))
          else if (e.type === 'retract')
            update((r) => ({
              ...r,
              text: r.text.slice(0, e.from),
              reasoning: [r.reasoning, r.text.slice(e.from).trim()].filter(Boolean).join('\n\n'),
            }))
          else if (e.type === 'tool-call') update((r) => ({ ...r, reasoningDone: true, steps: [...r.steps, e.step] }))
          else if (e.type === 'tool-result')
            update((r) => ({ ...r, steps: r.steps.map((s) => (s.id === e.id ? { ...s, output: e.output, error: e.error } : s)) }))
          else if (e.type === 'sources') update((r) => ({ ...r, sources: e.sources }))
          else if (e.type === 'done') {
            setTimeline(id, (m) => [...m, e.message])
            setLive(null)
            setVersion((v) => v + 1)
            if (e.message.steps?.some((s) => ['create_task', 'cancel_task', 'message_bot'].includes(s.name))) {
              api.tasks().then((r) => setTasks(r.tasks), () => {})
              // Another bot's timeline changed: drop its cache so it reloads when opened.
              const others = e.message.steps.filter((s) => s.name === 'message_bot').map((s) => (s.input as any)?.bot?.toLowerCase())
              setTimelines((t) => {
                const copy = { ...t }
                for (const b of bots) if (others.includes(b.name.toLowerCase())) delete copy[b.id]
                return copy
              })
            }
            refreshBots().catch(() => {})
          } else if (e.type === 'suggestions') setSuggestions({ botId: id, list: e.suggestions })
          else if (e.type === 'error') setError({ botId: id, text: e.error })
        },
        ctrl.signal,
      )
    } catch (e: any) {
      if (e.name !== 'AbortError') setError({ botId: id, text: e.message === 'Failed to fetch' ? `Lost connection to ${conn.url}` : e.message })
      else {
        // The server keeps the partial reply; pick it up.
        setTimeout(async () => {
          const after = (timelinesRef.current[id] ?? []).at(-1)?.id ?? 0
          const r = await api.newer(id, after).catch(() => null)
          if (r) setTimeline(id, (m) => [...m, ...r.messages.filter((f) => !m.some((x) => x.id === f.id))])
        }, 800)
      }
    } finally {
      setLive((l) => (l?.botId === id ? null : l))
      abort.current = null
    }
  }
  const timelinesRef = useRef(timelines)
  timelinesRef.current = timelines

  const unread = (b: Bot) => {
    const lm = b.lastMessage
    if (!lm || lm.role !== 'assistant') return false
    if (b.id === bot?.id && !page) return false
    return lm.id > (read[b.id] ?? 0)
  }

  const actions: SidebarActions = {
    open: (id) => {
      setActiveId(id)
      setPage(null)
      setMobileList(false)
    },
    details: (id) => {
      setActiveId(id)
      setPage(null)
      setPanelOpen(true)
    },
    page: (p) => {
      setPage(page === p ? null : p)
      setMobileList(false)
    },
    newBot: (team) => setNewBot({ team: team ?? null }),
    arrange: (l: Layout, text?: string) => {
      const before: Layout = {
        teams: [...teams],
        order: bots.map((b) => ({ id: b.id, team: b.team })),
        pins: pinnedBotsOf(bots).map((b) => b.id),
      }
      void mutate((r) => applyLayout(r.bots, r.teams, l), () => api.layout(l))
      if (text) showToast(text, () => void mutate((r) => applyLayout(r.bots, r.teams, before), () => api.layout(before)))
    },
    renameBot: (id, name) => {
      const old = bots.find((b) => b.id === id)?.name
      void mutate((r) => ({ ...r, bots: r.bots.map((b) => (b.id === id ? { ...b, name } : b)) }), () => api.updateBot(id, { name }))
      if (old) showToast(`Renamed ${old} to ${name}`, () => actions.renameBot(id, old))
    },
    duplicateBot: async (b) => {
      const r = await mutate(null, () =>
        api.createBot({ name: `${b.name} copy`, role: b.role, avatar: b.avatar, instructions: b.instructions, model: b.model, team: b.team }),
      )
      if (r && 'bot' in r) actions.open((r as any).bot.id)
    },
    deleteBot: async (b) => {
      const ok = await confirmDialog({
        title: `Delete ${b.name}?`,
        body: 'Its whole timeline, notebook, files and scheduled tasks go too. This can\'t be undone.',
        confirm: 'Delete',
        danger: true,
      })
      if (!ok) return
      const r = await mutate(null, () => api.deleteBot(b.id))
      if (r && bot?.id === b.id) setActiveId(r.bots[0]?.id ?? null)
    },
    markRead: (b) => b.lastMessage && setRead((r) => ({ ...r, [b.id]: b.lastMessage!.id })),
    createTeam: async (name) => {
      await mutate((r) => ({ ...r, teams: r.teams.includes(name) ? r.teams : [...r.teams, name] }), () => api.createTeam(name))
    },
    renameTeam: async (from, to) => {
      await mutate(
        (r) => ({
          teams: r.teams.includes(to) ? r.teams.filter((t) => t !== from) : r.teams.map((t) => (t === from ? to : t)),
          bots: r.bots.map((b) => (b.team === from ? { ...b, team: to } : b)),
        }),
        () => api.renameTeam(from, to),
      )
      if (!teams.includes(to)) showToast(`Renamed ${from} to ${to}`, () => void actions.renameTeam(to, from))
    },
    deleteTeam: async (name) => {
      const n = bots.filter((b) => b.team === name).length
      if (n) {
        const ok = await confirmDialog({
          title: `Delete category "${name}"?`,
          body: `Its ${n === 1 ? 'bot moves' : `${n} bots move`} to Unassigned. No bot is deleted.`,
          confirm: 'Delete category',
          danger: true,
        })
        if (!ok) return
      }
      void mutate(
        (r) => ({ teams: r.teams.filter((t) => t !== name), bots: r.bots.map((b) => (b.team === name ? { ...b, team: null } : b)) }),
        () => api.deleteTeam(name),
      )
    },
  }

  // Remember the order bots were visited in, for the switcher.
  useEffect(() => {
    if (bot) setRecent((r) => (r[0] === bot.id ? r : [bot.id, ...r.filter((x) => x !== bot.id)].slice(0, 30)))
  }, [bot?.id, setRecent])

  const stepBot = useRef((_d: number) => {})
  stepBot.current = (d) => {
    const order = [...pinnedBotsOf(bots), ...teams.flatMap((t) => bots.filter((b) => b.team === t)), ...bots.filter((b) => !b.team || !teams.includes(b.team))]
    const seen = new Set<number>()
    const uniq = order.filter((b) => !seen.has(b.id) && seen.add(b.id))
    const i = uniq.findIndex((b) => b.id === bot?.id)
    const next = uniq[(i + d + uniq.length) % uniq.length]
    if (next) actions.open(next.id)
  }

  function showToast(text: string, undo?: () => void) {
    const n = Date.now()
    setToast({ text, undo, n })
    setTimeout(() => setToast((t) => (t?.n === n ? null : t)), 6000)
  }

  const working = useMemo(() => new Set(live ? [live.botId] : []), [live])
  const modelLabels = useMemo(() => new Map(models.map((m) => [m.id, m.label.replace(/\s*\(.*\)$/, '')])), [models])
  const taskTitles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks])

  return (
    <BotsContext.Provider value={bots}>
      <div className={`app ${panelOpen && bot && !page ? 'with-panel' : ''} ${mobileList ? 'mobile-list' : ''}`} style={{ '--side-w': `${sideW}px` } as React.CSSProperties}>
        <Sidebar
          bots={bots}
          teams={teams}
          activeId={bot?.id ?? null}
          page={page}
          unread={unread}
          working={working}
          me={me}
          width={sideW}
          onResize={setSideW}
          actions={actions}
        />
        <main className="main">
          {page && (
            <button className="round-btn mobile-back" onClick={() => (setPage(null), setMobileList(true))} title="All bots">
              {Icon.chevron}
            </button>
          )}
          {page === 'search' && (
            <SearchView
              key={searchSeed.current}
              initial={searchSeed.current}
              api={api}
              bots={bots}
              onOpen={(id) => {
                setActiveId(id)
                setPage(null)
              }}
            />
          )}
          {page === 'tasks' && <TasksView api={api} bots={bots} tasks={tasks} setTasks={setTasks} />}
          {page === 'memory' && <MemoryView api={api} />}
          {page === 'settings' && (
            <SettingsView
              conn={conn}
              me={me}
              onSave={(c, name) => {
                saveConnection(c)
                setConn(c)
                setMe(name)
                setPage(null)
              }}
            />
          )}
          {!page && bot && (
            <ChatView
              key={bot.id}
              api={api}
              bot={bot}
              messages={messages}
              hasOlder={!!hasOlder[bot.id]}
              onLoadOlder={async () => {
                const first = messages[0]?.id
                if (!first) return
                const r = await api.messages(bot.id, first)
                setTimeline(bot.id, (m) => [...r.messages, ...m])
                setHasOlder((h) => ({ ...h, [bot.id]: r.messages.length === 100 }))
              }}
              live={live?.botId === bot.id ? live.reply : null}
              otherBusy={!!live && live.botId !== bot.id}
              error={error?.botId === bot.id || error?.botId === 0 ? error.text : null}
              suggestions={suggestions?.botId === bot.id ? suggestions.list : []}
              modelLabels={modelLabels}
              taskTitles={taskTitles}
              onSend={(o) => send(bot, o)}
              onTogglePanel={() => setPanelOpen(!panelOpen)}
              onBack={() => setMobileList(true)}
              composer={{
                placeholder: `Message ${bot.name}`,
                think,
                setThink,
                deep,
                setDeep,
                onSend: (text, files) => send(bot, { text, files }),
                onStop: () => abort.current?.abort(),
                upload: async (f) => (await api.upload(f)).file,
                busy: !!live,
              }}
            />
          )}
          {!page && !bot && conn.token && (
            <div className="hero muted">{error ? `${error.text} Retrying…` : 'Loading your bots…'}</div>
          )}
        </main>
        {panelOpen && bot && !page && (
          <BotPanel
            api={api}
            bot={bot}
            bots={bots}
            models={models}
            defaultModel={defaultModel}
            version={version}
            teams={teams}
            onSaved={setRoster}
            onDelete={() => actions.deleteBot(bot)}
            onClose={() => setPanelOpen(false)}
          />
        )}
        {newBot && (
          <NewBotDialog
            api={api}
            teams={teams}
            team={newBot.team}
            onClose={() => setNewBot(null)}
            onCreated={(b, r) => {
              setRoster(r)
              setActiveId(b.id)
              setPage(null)
              setNewBot(null)
            }}
          />
        )}
        <DialogHost />
        {switcher && (
          <Switcher
            bots={bots}
            recent={recent}
            unread={unread}
            onOpen={actions.open}
            onClose={() => setSwitcher(false)}
            actions={(q) => [
              ...(q
                ? [{ id: 'search', label: `Search all messages for "${q}"`, icon: Icon.search, run: () => { searchSeed.current = q; setPage('search') } }]
                : []),
              { id: 'new-bot', label: 'New bot', icon: Icon.plus, run: () => actions.newBot() },
              { id: 'tasks', label: 'Tasks', icon: Icon.tasks, run: () => setPage('tasks') },
              { id: 'memory', label: 'Memory', icon: Icon.memory, run: () => setPage('memory') },
              { id: 'settings', label: 'Settings', icon: Icon.settings, run: () => setPage('settings') },
              ...(bot ? [{ id: 'details', label: `Details for ${bot.name}`, icon: Icon.info, run: () => actions.details(bot.id) }] : []),
            ]}
          />
        )}
        {toast && (
          <div className="toast" key={toast.n}>
            <span>{toast.text}</span>
            {toast.undo && (
              <button
                onClick={() => {
                  toast.undo!()
                  setToast(null)
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </BotsContext.Provider>
  )
}

const STARTERS: Record<string, string[]> = {
  default: ["What's happening in the world today?", 'Plot compound growth of €10,000 at 7% for 20 years', 'Every weekday at 8:00, send me a short news brief'],
}

function ChatView(props: {
  api: Api
  bot: Bot
  messages: Message[]
  hasOlder: boolean
  onLoadOlder: () => Promise<void>
  live: LiveReply | null
  otherBusy: boolean
  error: string | null
  suggestions: string[]
  modelLabels: Map<string, string>
  taskTitles: Map<number, string>
  onSend: (opts: SendOpts) => void
  onTogglePanel: () => void
  onBack: () => void
  composer: React.ComponentProps<typeof Composer>
}) {
  const { messages, live, bot } = props
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !m.fromBotId)
  const lastAssistant = messages.at(-1)?.role === 'assistant' ? messages.at(-1) : undefined
  const busy = !!live

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, live, props.suggestions])

  return (
    <div className="chat">
      <button className="round-btn mobile-back" onClick={props.onBack} title="All bots">
        {Icon.chevron}
      </button>
      <button className="bot-pill" onClick={props.onTogglePanel} title="Show details">
        <Avatar avatar={bot.avatar} name={bot.name} size={26} />
        {label(bot)}
      </button>
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
          {messages.length === 0 && !live && (
            <div className="bot-intro">
              <Avatar avatar={bot.avatar} name={bot.name} size={88} />
              <h2>{label(bot)}</h2>
              <p className="muted">{bot.instructions ? bot.instructions.split(/(?<=\.)\s/)[0] : 'Your general assistant. One timeline, always remembering.'}</p>
              <div className="starters">
                {STARTERS.default.map((s) => (
                  <button key={s} className="starter" onClick={() => props.onSend({ text: s })}>
                    {Icon.spark}
                    <span>{s}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {props.hasOlder && (
            <button className="link-btn older" onClick={props.onLoadOlder}>
              Load earlier messages
            </button>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1]
            const gap = !prev || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 3 * 3600_000
            return (
              <div key={m.id} className="entry">
                {gap && <DayDivider iso={m.createdAt} />}
                {m.role === 'user' ? (
                  <UserMessage
                    message={m}
                    fileUrl={props.api.fileUrl}
                    onEdit={!busy && m.id === lastUser?.id ? (text) => props.onSend({ text, files: m.attachments, replaceFrom: m.id }) : undefined}
                  />
                ) : (
                  <AssistantMessage
                    message={m}
                    modelLabel={m.model ? (props.modelLabels.get(m.model) ?? m.model.split(':')[1]) : undefined}
                    taskTitle={m.taskId ? (props.taskTitles.get(m.taskId) ?? 'task') : undefined}
                    onRegenerate={!busy && m.id === lastAssistant?.id && !m.taskId ? () => props.onSend({ regenerate: true }) : undefined}
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
        {props.otherBusy && <div className="dock-note">Another bot is answering; you can send once it's done.</div>}
        <Composer {...props.composer} />
      </div>
    </div>
  )
}

const TEMPLATES = [
  { name: 'Researcher', role: 'Deep research', instructions: 'Research thoroughly with many sources, cross-check, and cite every key claim.' },
  { name: 'Coach', role: 'Fitness coach', instructions: 'Plan workouts and habits, track progress in your notebook, and check in kindly.' },
  { name: 'Ledger', role: 'Finance helper', instructions: 'Help with budgets, invoices and numbers. Always compute with run_code; never estimate.' },
  { name: 'Scout', role: 'Load finder', instructions: 'Find freight opportunities, rates and brokers for European road transport. Be specific and numeric.' },
]

function NewBotDialog(props: { api: Api; teams: string[]; team: string | null; onClose: () => void; onCreated: (b: Bot, r: Roster) => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [team, setTeam] = useState(props.team ?? '')
  const [instructions, setInstructions] = useState('')
  const [avatar, setAvatar] = useState(() => randomAvatar('new'))
  const [error, setError] = useState<string | null>(null)
  const teams = props.teams

  return (
    <div className="modal-back" onClick={props.onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            const r = await props.api.createBot({ name, role, team: team || null, instructions, avatar })
            props.onCreated(r.bot, r)
          } catch (err: any) {
            setError(err.message)
          }
        }}
      >
        <div className="modal-head">
          <h3>New bot</h3>
          <button type="button" className="round-btn" onClick={props.onClose}>
            {Icon.close}
          </button>
        </div>
        <div className="avatar-edit">
          <Avatar avatar={avatar} name={name || 'bot'} size={64} />
          <button type="button" className="ghost small" onClick={() => setAvatar(randomAvatar(name || 'bot'))}>
            New look
          </button>
        </div>
        <div className="templates">
          {TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.name}
              className="chip"
              onClick={() => {
                setName(t.name)
                setRole(t.role)
                setInstructions(t.instructions)
                setAvatar(randomAvatar(t.name))
              }}
            >
              {t.role}
            </button>
          ))}
        </div>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Raider" required autoFocus />
        </label>
        <label>
          Role
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Live X hunt" />
        </label>
        <label>
          Team
          <input list="new-teams" value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Unassigned" />
          <datalist id="new-teams">
            {teams.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label>
          Instructions
          <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What it does, how it talks, what to focus on" />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary">Create bot</button>
      </form>
    </div>
  )
}
