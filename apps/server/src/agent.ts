import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai'
import type { ChatEvent, Source, ToolStep } from '@si-bot/shared'
import { sql } from './db.js'
import { getModel, listModels, thinkOptions } from './providers.js'
import { buildTools, describeCall } from './tools.js'
import { memoryPrompt, memoryTools } from './memory.js'
import { formatRecalled, recall } from './recall.js'
import { taskTools } from './tasks.js'
import { attachmentParts } from './attachments.js'

const CONTEXT_MESSAGES = Number(process.env.CONTEXT_MESSAGES ?? 40)
const MAX_STEPS = 12
const DEEP_MAX_STEPS = 30

const SYSTEM = `You are Si, a personal AI assistant. You are one persistent assistant, not a fresh session: the conversation
below is a single continuous timeline with the user, and you keep long-term memory across it.
Current time: {now} ({tz}).

How you answer
- Lead with the answer. Match length to the question: a quick question gets a quick reply, depth only when the topic
  needs it or the user asks. No filler openers ("Great question"), no recaps, no closing offers of more help.
- Be direct, warm and a little witty. Have opinions when asked; say plainly when you are unsure or something is unknown.
- Format with markdown when it helps: short paragraphs, lists for steps, tables for comparisons, headings only for long
  answers. Math in LaTeX: \\( ... \\) inline and $$ ... $$ on
  their own lines for display; never single $ for math, it clashes with prices. Code in fenced blocks with the language.
- Reply in the user's language.

Tools
- web_search for anything current, niche, or that you are not sure of. Pass several differently-worded queries in one call
  and set recency for news. Then read_page the 2-4 best results (in one call) before answering anything non-trivial;
  snippets alone are often stale or wrong. Prefer primary and recent sources; note dates for time-sensitive facts.
- Cite web sources inline as markdown links right after the claim, e.g. ([Reuters](https://...)). Never invent URLs.
- run_code for any non-trivial arithmetic, finance, unit conversion, data work or checking code. Never estimate numbers
  you can compute.
- remember when the user shares a durable fact about themselves or asks you to remember something. recall_memory only
  when they refer to something from the past that is not in view.
- create_task when the user wants something done later or on repeat (reminders, daily briefs, watching for news).
  Only offer follow-ups you can actually do with these tools.`

const DEEP = `

DeepSearch mode is on: the user wants a thorough, well-sourced answer, and time is fine.
1. Break the question into sub-questions. 2. Search each with several varied queries (at least 3 rounds overall).
3. Read at least 5 strong, primary or recent sources and cross-check claims where sources disagree.
4. Write a structured report: a 2-3 sentence answer up top, then sections, tables where useful, and inline citations for
every key claim. End with a short "Open questions" note only if something important is unresolved.`

export interface TurnInput {
  modelId: string
  /** Id of the newest message to answer from; history is everything up to and including it. */
  upToId: number
  /** Text used for automatic recall (usually the user's message). */
  query: string
  think?: boolean
  deep?: boolean
  timezone: string
  /** Extra system instructions, e.g. for scheduled tasks. */
  extraSystem?: string
  /** A user turn that is sent to the model but not stored (scheduled task instructions). */
  appendUser?: string
  /** Leave out the task tools (scheduled runs must not schedule more runs). */
  noTaskTools?: boolean
  signal?: AbortSignal
  onEvent: (e: ChatEvent) => Promise<void> | void
}

export interface TurnResult {
  /** The model that produced the reply (differs from the requested one after a fallback). */
  modelId: string
  text: string
  reasoning: string
  thoughtMs: number
  steps: ToolStep[]
  sources: Source[]
  partial: boolean
  error?: string
}

function clip(text: string, max = 4000) {
  return text.length > max ? text.slice(0, max) + '\n…' : text
}

function nowIn(tz: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date())
  } catch {
    return new Date().toUTCString()
  }
}

export function validTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return tz
  } catch {
    return undefined
  }
}

/** Collects the pages behind an answer: links cited in the text first, then pages read, then search hits. */
function collectSources(text: string, steps: { name: string; raw: any }[]): Source[] {
  const out: Source[] = []
  const seen = new Set<string>()
  const add = (url: string, title?: string) => {
    if (!/^https?:\/\//.test(url)) return
    const key = url.replace(/[#].*$/, '').replace(/\/$/, '')
    const existing = out.find((s) => s.url.replace(/[#].*$/, '').replace(/\/$/, '') === key)
    if (existing) {
      if (title && existing.title === hostOf(existing.url)) existing.title = title
      return
    }
    if (seen.has(key)) return
    seen.add(key)
    out.push({ url, title: title || hostOf(url) })
  }
  const titles = new Map<string, string>()
  for (const s of steps) {
    if (s.name === 'read_page') for (const p of s.raw?.pages ?? []) if (p.title) titles.set(p.url, p.title)
    if (s.name === 'web_search') for (const h of s.raw?.results ?? []) if (!titles.has(h.url)) titles.set(h.url, h.title)
  }
  for (const m of text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) add(m[1], titles.get(m[1]))
  for (const s of steps) if (s.name === 'read_page') for (const p of s.raw?.pages ?? []) if (!p.error) add(p.url, p.title)
  for (const s of steps) if (s.name === 'web_search') for (const h of (s.raw?.results ?? []).slice(0, 6)) add(h.url, h.title)
  return out.slice(0, 20)
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The recent timeline as model messages, with attachments inlined. Images only travel with the newest message. */
async function loadHistory(upToId: number): Promise<{ messages: ModelMessage[]; oldestId: number }> {
  const rows = await sql`
    select id, role, content from messages where id <= ${upToId} order by id desc limit ${CONTEXT_MESSAGES}`
  // A user message with no reply after it was interrupted (stopped, failed, or still running elsewhere). Leave it out,
  // or the model answers it again alongside the new one.
  const ordered = [...rows].reverse().filter((r, i, all) => {
    if (r.role !== 'user' || Number(r.id) === upToId) return true
    return all[i + 1]?.role === 'assistant'
  })
  const userIds = ordered.filter((r) => r.role === 'user').map((r) => Number(r.id))
  const files = await attachmentParts(userIds, (id) => id === upToId)
  const messages: ModelMessage[] = ordered.map((r) => {
    const extra = files.get(Number(r.id))
    if (r.role === 'user' && extra?.length) {
      return { role: 'user', content: [{ type: 'text', text: r.content || '(see attached)' }, ...extra] }
    }
    return { role: r.role, content: r.content }
  })
  // Providers reject a conversation that starts with an assistant turn.
  while (messages[0]?.role === 'assistant') messages.shift()
  return { messages, oldestId: Number(ordered[0]?.id ?? upToId) }
}

export async function buildSystem(opts: { timezone: string; deep?: boolean; query: string; beforeId: number; extra?: string }) {
  const recalled = await recall(opts.query, { beforeId: opts.beforeId }).catch(() => [])
  return (
    SYSTEM.replace('{now}', nowIn(opts.timezone)).replace('{tz}', opts.timezone) +
    (opts.deep ? DEEP : '') +
    (await memoryPrompt()) +
    (recalled.length
      ? `\n\nRelevant moments from earlier in your timeline (recalled automatically; use them only if they help):\n${formatRecalled(recalled)}`
      : '') +
    (opts.extra ? `\n\n${opts.extra}` : '')
  )
}

/** Runs one assistant turn with tools, streaming events as it goes. Never throws; failures come back in `error`. */
/**
 * Runs a turn, and if the model fails before producing anything (provider down, rate limit, model rejects the
 * request), runs it once more on FALLBACK_MODEL so the user still gets an answer.
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const result = await runTurnOnce(input)
  const fallback = process.env.FALLBACK_MODEL
  const failedEarly = result.error && !result.text && !result.steps.length && !input.signal?.aborted
  if (failedEarly && fallback && fallback !== input.modelId && listModels().some((m) => m.id === fallback)) {
    console.error(`[chat] ${input.modelId} failed (${result.error}); retrying on ${fallback}`)
    return runTurnOnce({ ...input, modelId: fallback })
  }
  return result
}

async function runTurnOnce(input: TurnInput): Promise<TurnResult> {
  const { messages, oldestId } = await loadHistory(input.upToId)
  if (input.appendUser) {
    // A scheduled run answers only its own instruction, not a user message left unanswered in the timeline.
    while (messages.at(-1)?.role === 'user') messages.pop()
    messages.push({ role: 'user', content: input.appendUser })
  }
  const system = await buildSystem({
    timezone: input.timezone,
    deep: input.deep,
    query: input.query,
    beforeId: oldestId,
    extra: input.extraSystem,
  })
  const tools = {
    ...buildTools(),
    ...memoryTools(),
    ...(input.noTaskTools ? {} : taskTools(() => input.timezone)),
  }

  const emit = async (e: ChatEvent) => {
    try {
      await input.onEvent(e)
    } catch {
      // The client went away; keep going so the reply is still saved to the timeline.
    }
  }

  let text = ''
  let reasoning = ''
  let thoughtMs = 0
  let reasoningStart = 0
  const steps: ToolStep[] = []
  const raw: { name: string; raw: any }[] = []
  let partial = false
  let error: string | undefined

  try {
    const result = streamText({
      model: getModel(input.modelId),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(input.deep ? DEEP_MAX_STEPS : MAX_STEPS),
      abortSignal: input.signal,
      providerOptions: input.think || input.deep ? (thinkOptions(input.modelId) as any) : undefined,
    })
    let newStep = false
    let stepStart = 0
    for await (const part of result.fullStream) {
      if (part.type === 'start-step') {
        stepStart = text.length
        newStep = text.length > 0
      } else if (part.type === 'reasoning-start') {
        reasoningStart = Date.now()
        if (reasoning && !reasoning.endsWith('\n\n')) {
          reasoning += '\n\n'
          await emit({ type: 'reasoning', text: '\n\n' })
        }
      } else if (part.type === 'reasoning-delta') {
        if (!reasoningStart) reasoningStart = Date.now()
        reasoning += part.text
        await emit({ type: 'reasoning', text: part.text })
      } else if (part.type === 'reasoning-end') {
        if (reasoningStart) thoughtMs += Date.now() - reasoningStart
        reasoningStart = 0
      } else if (part.type === 'text-delta') {
        // Text from separate steps (before and after a tool call) would otherwise run together.
        const chunk = newStep && !/\s$/.test(text) ? '\n\n' + part.text : part.text
        newStep = false
        text += chunk
        await emit({ type: 'delta', text: chunk })
      } else if (part.type === 'tool-call') {
        // "Let me look that up…" before a tool call is narration, not answer: fold it into the reasoning.
        if (text.length > stepStart) {
          const narration = text.slice(stepStart).trim()
          text = text.slice(0, stepStart)
          if (narration) reasoning += (reasoning ? '\n\n' : '') + narration
          await emit({ type: 'retract', from: stepStart })
        }
        const step: ToolStep = {
          id: part.toolCallId,
          name: part.toolName,
          label: describeCall(part.toolName, part.input),
          input: part.input,
        }
        steps.push(step)
        await emit({ type: 'tool-call', step })
      } else if (part.type === 'tool-result' || part.type === 'tool-error') {
        const step = steps.find((s) => s.id === part.toolCallId)
        let update: { output?: string; error?: string }
        if (part.type === 'tool-result') {
          raw.push({ name: part.toolName, raw: part.output })
          update = { output: clip(typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2)) }
        } else {
          update = { error: String((part as any).error?.message ?? (part as any).error) }
        }
        if (step) Object.assign(step, update)
        await emit({ type: 'tool-result', id: part.toolCallId, ...update })
      } else if (part.type === 'abort') {
        partial = true
      } else if (part.type === 'error') {
        throw (part as any).error
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || input.signal?.aborted) {
      partial = true
    } else {
      console.error('[chat]', err)
      partial = true
      error = friendlyError(err)
    }
  }
  if (reasoningStart) thoughtMs += Date.now() - reasoningStart

  const sources = collectSources(text, raw)
  if (sources.length) await emit({ type: 'sources', sources })
  return { modelId: input.modelId, text, reasoning, thoughtMs, steps, sources, partial, error }
}

function friendlyError(err: any): string {
  const msg = String(err?.message ?? err)
  const status = err?.statusCode ?? err?.lastError?.statusCode
  if (status === 401 || status === 403) return `The model provider rejected the API key (${status}). Check it in .env.`
  if (status === 429) return 'The model provider is rate-limiting requests. Try again in a minute or pick another model.'
  if (/image|vision|multimodal/i.test(msg)) return `This model can't read images. Pick a vision model and try again. (${msg})`
  return msg
}

function cheapModelId(preferred?: string): string | undefined {
  const wanted = process.env.MEMORY_MODEL
  const models = listModels()
  if (wanted && models.some((m) => m.id === wanted)) return wanted
  return preferred ?? models[0]?.id
}

/** Three short follow-up questions the user might ask next, Grok-style. Empty on failure or when none fit. */
export async function suggestFollowUps(userText: string, answer: string, modelId: string): Promise<string[]> {
  const id = cheapModelId(modelId)
  if (!id || answer.length < 200) return []
  try {
    const { text } = await generateText({
      model: getModel(id),
      maxOutputTokens: 400,
      abortSignal: AbortSignal.timeout(15_000),
      system:
        'Suggest 3 natural follow-up questions the user might ask next, written as the user would type them ' +
        '(first person, under 12 words each, specific to the answer, in the user\'s language). One per line, no numbering, ' +
        'no quotes. If the exchange is small talk or needs no follow-up, reply NONE.',
      prompt: `User: ${userText.slice(0, 2000)}\n\nAssistant: ${answer.slice(0, 6000)}`,
    })
    if (/^\s*NONE\s*$/i.test(text)) return []
    return text
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s"]+/, '').replace(/"$/, '').trim())
      .filter((l) => l.length > 3 && l.length < 120)
      .slice(0, 3)
  } catch (err) {
    console.error('[suggest] failed:', (err as Error).message)
    return []
  }
}
