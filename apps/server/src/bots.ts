import { tool } from 'ai'
import { z } from 'zod'
import type { Activity, Bot, BotInput, Layout, LibraryItem } from '@si-bot/shared'
import { sql } from './db.js'

export function toBot(r: any): Bot {
  return {
    id: Number(r.id),
    name: r.name,
    role: r.role,
    avatar: r.avatar,
    instructions: r.instructions,
    model: r.model,
    team: r.team,
    pinned: r.pinned,
    pinSort: r.pin_sort ?? 0,
    createdAt: r.created_at.toISOString(),
    ...(r.last_id
      ? {
          lastMessage: {
            id: Number(r.last_id),
            role: r.last_role,
            preview: String(r.last_content ?? '').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120),
            createdAt: r.last_at.toISOString(),
          },
        }
      : { lastMessage: null }),
  }
}

/** All bots with their newest message, for the sidebar. */
export async function listBots(): Promise<Bot[]> {
  const rows = await sql`
    select b.*, m.id as last_id, m.role as last_role, left(m.content, 400) as last_content, m.created_at as last_at
    from bots b
    left join lateral (
      select id, role, content, created_at from messages where bot_id = b.id order by id desc limit 1
    ) m on true
    order by b.sort, b.id`
  return rows.map(toBot)
}

/** Category names in sidebar order. */
export async function listTeams(): Promise<string[]> {
  return (await sql`select name from teams order by sort, name`).map((r) => r.name as string)
}

async function ensureTeam(name: string | null | undefined) {
  if (!name) return
  await sql`
    insert into teams (name, sort) values (${name}, (select coalesce(max(sort), 0) + 1 from teams))
    on conflict do nothing`
}

export async function createTeam(name: string) {
  const n = name.trim()
  if (!n) throw new Error('name required')
  if (n.toLowerCase() === 'unassigned') throw new Error('That name is reserved')
  await ensureTeam(n)
}

/** Renames a category; renaming onto an existing one merges them. */
export async function renameTeam(from: string, to: string) {
  const n = to.trim()
  if (!n) throw new Error('name required')
  if (n.toLowerCase() === 'unassigned') throw new Error('That name is reserved')
  if (n === from) return
  await sql.begin(async (tx) => {
    const [exists] = await tx`select 1 from teams where name = ${n}`
    if (exists) await tx`delete from teams where name = ${from}`
    else await tx`update teams set name = ${n} where name = ${from}`
    await tx`update bots set team = ${n} where team = ${from}`
  })
}

/** Deletes a category; its bots move to Unassigned. */
export async function deleteTeam(name: string) {
  await sql.begin(async (tx) => {
    await tx`update bots set team = null where team = ${name}`
    await tx`delete from teams where name = ${name}`
  })
}

/** Saves the sidebar arrangement after a drag: category order, each bot's category and position, and pinned order. */
export async function saveLayout(layout: Layout) {
  await sql.begin(async (tx) => {
    for (const [i, name] of (layout.teams ?? []).entries()) {
      await tx`insert into teams (name, sort) values (${name}, ${i}) on conflict (name) do update set sort = ${i}`
    }
    for (const [i, b] of (layout.order ?? []).entries()) {
      const team = b.team?.trim() || null
      if (team) await tx`insert into teams (name, sort) values (${team}, (select coalesce(max(sort), 0) + 1 from teams)) on conflict do nothing`
      await tx`update bots set sort = ${i}, team = ${team} where id = ${b.id}`
    }
    if (layout.pins) {
      await tx`update bots set pinned = false where not (id = any(${layout.pins}::bigint[]))`
      for (const [i, id] of layout.pins.entries()) await tx`update bots set pinned = true, pin_sort = ${i} where id = ${id}`
    }
  })
}

export async function getBot(id: number): Promise<Bot | null> {
  const [r] = await sql`select * from bots where id = ${id}`
  return r ? toBot(r) : null
}

export async function firstBotId(): Promise<number> {
  const [r] = await sql`select id from bots order by sort, id limit 1`
  return Number(r.id)
}

export async function createBot(input: BotInput): Promise<Bot> {
  const name = input.name?.trim()
  if (!name) throw new Error('name required')
  const [{ next }] = await sql`select coalesce(max(sort), 0) + 1 as next from bots`
  const [r] = await sql`
    insert into bots (name, role, avatar, instructions, model, team, pinned, sort)
    values (${name}, ${input.role?.trim() ?? ''}, ${input.avatar || `dicebear:adventurer:${name}-${Date.now() % 1000}`},
            ${input.instructions ?? ''}, ${input.model ?? null}, ${input.team?.trim() || null}, ${input.pinned ?? false}, ${next})
    returning *`
  await ensureTeam(input.team?.trim())
  return toBot(r)
}

export async function updateBot(id: number, input: BotInput): Promise<Bot | null> {
  const cur = await getBot(id)
  if (!cur) return null
  const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) }
  const [r] = await sql`
    update bots set name = ${next.name.trim() || cur.name}, role = ${next.role}, avatar = ${next.avatar},
      instructions = ${next.instructions}, model = ${next.model || null}, team = ${next.team?.trim() || null},
      pinned = ${next.pinned},
      pin_sort = case when ${next.pinned} and not pinned then (select coalesce(max(pin_sort), 0) + 1 from bots where pinned) else pin_sort end
    where id = ${id} returning *`
  await ensureTeam(r.team)
  return toBot(r)
}

export async function deleteBot(id: number) {
  const [{ n }] = await sql`select count(*)::int as n from bots`
  if (n <= 1) throw new Error("You can't delete your last bot")
  await sql`delete from bots where id = ${id}`
  await sql`delete from settings where key in (${`digest:${id}`}, ${`notes:${id}`})`
}

/** Files in a bot's library: what the user attached in its timeline and images it made, newest first. */
export async function library(botId: number): Promise<LibraryItem[]> {
  const rows = await sql`
    select a.id, a.name, a.media_type, a.size, a.created_at, (m.role is distinct from 'user') as generated
    from attachments a left join messages m on m.id = a.message_id
    where a.bot_id = ${botId}
    order by a.id desc limit 200`
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    mediaType: r.media_type,
    size: r.size,
    createdAt: r.created_at.toISOString(),
    generated: r.generated,
  }))
}

/** The bot's recent tool actions (searches, pages read, code runs), newest first, for the Computer tab. */
export async function activity(botId: number, limit = 60): Promise<Activity[]> {
  const rows = await sql`
    select id, steps, created_at from messages
    where bot_id = ${botId} and steps is not null order by id desc limit 40`
  const out: Activity[] = []
  for (const r of rows) {
    for (const s of [...(r.steps ?? [])].reverse()) {
      out.push({ ...s, messageId: Number(r.id), createdAt: r.created_at.toISOString() })
      if (out.length >= limit) return out
    }
  }
  return out
}

/** The other bots, for the system prompt, so each bot knows its team and can message them. */
export async function teamPrompt(self: Bot): Promise<string> {
  const others = (await listBots()).filter((b) => b.id !== self.id)
  if (!others.length) return ''
  return (
    `\n\nOther bots you work alongside (message them with message_bot when their role fits better, or to hand ` +
    `something over; they answer in their own timeline and the reply comes back to you):\n` +
    others.map((b) => `- ${b.name}${b.role ? ` · ${b.role}` : ''}${b.team ? ` (team ${b.team})` : ''}`).join('\n')
  )
}

/**
 * Lets a bot message another bot. The message lands in the other bot's timeline, that bot answers there, and its
 * answer is posted back into the sender's timeline. Bots answering another bot cannot message onward, so there are
 * no loops.
 */
export function botTools(self: Bot, deliver: (from: Bot, to: Bot, text: string) => Promise<string>) {
  return {
    message_bot: tool({
      description:
        'Send a message to another bot by name: ask it for its specialty, hand over a task, or pass on something ' +
        'the user said. It answers in its own timeline and you get its reply back here.',
      inputSchema: z.object({
        bot: z.string().describe('The other bot\'s name'),
        message: z.string().describe('What to tell or ask it, self-contained'),
      }),
      execute: async ({ bot, message }) => {
        const all = await listBots()
        const target =
          all.find((b) => b.name.toLowerCase() === bot.toLowerCase()) ??
          all.find((b) => b.name.toLowerCase().startsWith(bot.toLowerCase()))
        if (!target) return { error: `No bot named "${bot}". Bots: ${all.map((b) => b.name).join(', ')}` }
        if (target.id === self.id) return { error: "That's you." }
        const reply = await deliver(self, target, message)
        return { to: target.name, reply }
      },
    }),
  }
}
