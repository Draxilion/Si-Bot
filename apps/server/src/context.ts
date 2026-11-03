/**
 * The context engine: how one endless timeline fits into a model's finite context window.
 *
 * Every prompt is built from layers, so nothing depends on the window being large:
 *   1. Notebook   - Si's own living notes: ongoing projects, open loops, commitments. Always in the prompt.
 *   2. Facts      - durable facts about the user, ranked by relevance when there are many.
 *   3. Digest     - a rolling summary of everything older than the recent window, updated in the background
 *                   as messages fall out of it. This is what makes old context survive without a "session".
 *   4. Recall     - the most relevant older moments for this message (keyword + vector search).
 *   5. Recent     - the newest messages, verbatim, up to a token budget rather than a fixed count.
 */
import { generateText, tool } from 'ai'
import { z } from 'zod'
import { getSetting, setSetting, sql } from './db.js'
import { getModel, listModels } from './providers.js'

/** Token budget for the verbatim recent messages. Tokens are estimated at ~3.5 characters each. */
const CONTEXT_TOKENS = Number(process.env.CONTEXT_TOKENS ?? 24_000)
/** Messages older than the newest few are clipped to this many characters in the window. */
const OLD_REPLY_CHARS = 2_500
const KEEP_FULL = 6
const MAX_MESSAGES = 120
const DIGEST_MAX_WORDS = 1_200
const NOTES_MAX_CHARS = 4_000

const tokens = (s: string) => Math.ceil(s.length / 3.5)

function clipMiddle(text: string, max: number) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  return `${text.slice(0, head)}\n[…]\n${text.slice(text.length - (max - head))}`
}

export interface WindowRow {
  id: number
  role: 'user' | 'assistant'
  content: string
}

/** The newest messages up to and including `upToId` that fit the token budget, oldest first. */
export async function recentWindow(upToId: number, budget = CONTEXT_TOKENS): Promise<WindowRow[]> {
  const rows = await sql`
    select id, role, content from messages where id <= ${upToId} order by id desc limit ${MAX_MESSAGES}`
  const out: WindowRow[] = []
  let used = 0
  for (const [i, r] of rows.entries()) {
    const content = i < KEEP_FULL ? r.content : clipMiddle(r.content, OLD_REPLY_CHARS)
    const cost = tokens(content) + 4
    // Always keep the newest exchange, even if it alone is over budget.
    if (used + cost > budget && out.length >= 2) break
    used += cost
    out.push({ id: Number(r.id), role: r.role, content })
  }
  return out.reverse()
}

// ---------- Digest ----------

interface Digest {
  text: string
  /** Every message with id <= this is folded into the digest. */
  upToId: number
  updatedAt: string
}

export async function getDigest(): Promise<Digest | null> {
  return getSetting<Digest | null>('digest', null)
}

export async function setDigestText(text: string) {
  const cur = await getDigest()
  await setSetting('digest', { text: text.trim(), upToId: cur?.upToId ?? 0, updatedAt: new Date().toISOString() })
}

function helperModelId(): string | undefined {
  const wanted = process.env.MEMORY_MODEL
  const models = listModels()
  if (wanted && models.some((m) => m.id === wanted)) return wanted
  return models[0]?.id
}

let digesting = false

/**
 * Folds messages that have left the recent window into the rolling digest. Runs in the background after each
 * reply; does nothing until enough has fallen out of the window to be worth a model call.
 */
export async function updateDigest(force = false) {
  if (digesting) return
  const modelId = helperModelId()
  if (!modelId) return
  digesting = true
  try {
    const [last] = await sql`select coalesce(max(id), 0) as id from messages`
    const window = await recentWindow(Number(last.id))
    const windowStart = window[0]?.id ?? Number(last.id) + 1
    const digest = await getDigest()
    const from = digest?.upToId ?? 0
    const pending = await sql`
      select id, role, content, created_at from messages
      where id > ${from} and id < ${windowStart} order by id limit 200`
    if (!pending.length) return
    const pendingChars = pending.reduce((n, r) => n + r.content.length, 0)
    if (!force && pending.length < 8 && pendingChars < 12_000) return

    const transcript = pending
      .map((r) => `[${r.created_at.toISOString().slice(0, 16).replace('T', ' ')}] ${r.role === 'user' ? 'User' : 'Si'}: ${clipMiddle(r.content, 3_000)}`)
      .join('\n\n')
    const { text } = await generateText({
      model: getModel(modelId),
      maxOutputTokens: 3_000,
      system:
        'You maintain the running digest of a personal assistant\'s single, lifelong conversation with its user. ' +
        'Merge the new messages into the existing digest and return the full updated digest. Keep: who the user is, ' +
        'their projects, decisions and why, preferences, promises either side made, open questions, and concrete ' +
        'details likely to matter later (names, numbers, dates, places, IDs). Drop small talk and anything the assistant ' +
        'merely looked up unless the user acted on it. Group by topic with short markdown headings, newest developments ' +
        `last within each topic, dates as YYYY-MM-DD. Stay under ${DIGEST_MAX_WORDS} words: compress older detail ` +
        'rather than dropping recent detail. Output only the digest.',
      prompt: `Existing digest:\n${digest?.text || '(empty)'}\n\nNew messages:\n${transcript}`,
    })
    await setSetting('digest', {
      text: text.trim(),
      upToId: Number(pending.at(-1)!.id),
      updatedAt: new Date().toISOString(),
    })
    console.log(`[context] digest now covers up to message ${pending.at(-1)!.id}`)
  } catch (err) {
    console.error('[context] digest update failed:', (err as Error).message)
  } finally {
    digesting = false
  }
}

// ---------- Notebook ----------

export async function getNotes(): Promise<string> {
  return getSetting<string>('notes', '')
}

export async function setNotes(text: string) {
  await setSetting('notes', text.slice(0, NOTES_MAX_CHARS))
}

/** Lets Si keep its own notebook of what is going on in the user's life and work. */
export function notebookTools() {
  return {
    update_notes: tool({
      description:
        'Rewrite your notebook: your own short, living notes on what is going on with the user right now: ' +
        'ongoing projects and their status, open loops, things you promised to do or follow up on, upcoming dates. ' +
        'It is shown to you at the start of every conversation turn, forever. Update it when something changes ' +
        '(a project starts or ends, a decision is made, a deadline is set, a loop closes). Return the whole notebook ' +
        `in markdown, under ${NOTES_MAX_CHARS} characters; remove what is done or stale.`,
      inputSchema: z.object({ notes: z.string() }),
      execute: async ({ notes }) => {
        await setNotes(notes)
        return { saved: true, chars: Math.min(notes.length, NOTES_MAX_CHARS) }
      },
    }),
  }
}

/** The long-memory layers of the system prompt: notebook and digest. */
export async function contextPrompt(): Promise<string> {
  const [notes, digest] = await Promise.all([getNotes(), getDigest()])
  let out = ''
  if (notes.trim()) {
    out += `\n\nYour notebook (your own running notes; keep it current with update_notes):\n${notes.trim()}`
  } else {
    out += '\n\nYour notebook is empty. Start it with update_notes once you learn about the user\'s ongoing projects or open loops.'
  }
  if (digest?.text) {
    out +=
      `\n\nDigest of your timeline before the recent messages (your own summary, up to ${digest.updatedAt.slice(0, 10)}). ` +
      `Treat it as things you remember; use recall_memory for exact wording or details:\n${digest.text}`
  }
  return out
}
