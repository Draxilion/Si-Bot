import { tool } from 'ai'
import { z } from 'zod'
import type { Activity, Bot, BotInput, LibraryItem } from '@si-bot/shared'
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
  return toBot(r)
}

export async function updateBot(id: number, input: BotInput): Promise<Bot | null> {
  const cur = await getBot(id)
  if (!cur) return null
  const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) }
  const [r] = await sql`
    update bots set name = ${next.name.trim() || cur.name}, role = ${next.role}, avatar = ${next.avatar},
      instructions = ${next.instructions}, model = ${next.model || null}, team = ${next.team?.trim() || null},
      pinned = ${next.pinned}
    where id = ${id} returning *`
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
