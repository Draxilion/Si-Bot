import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'
import { streamSSE } from 'hono/streaming'
import { stepCountIs, streamText, type ModelMessage } from 'ai'
import type { ChatEvent, ChatRequest, Message, ToolStep } from '@si-bot/shared'
import { migrate, sql } from './db.js'
import { defaultModel, getModel, listModels, thinkOptions } from './providers.js'
import { buildTools, describeCall } from './tools.js'
import { addFact, deleteFact, extractFacts, listFacts, memoryPrompt } from './memory.js'

const token = process.env.SIBOT_TOKEN
if (!token || token === 'change-me') {
  console.error('Set SIBOT_TOKEN in .env (openssl rand -hex 32).')
  process.exit(1)
}

const CONTEXT_MESSAGES = 40
const MAX_STEPS = 10
const tools = buildTools()

const SYSTEM = `You are Si, a personal AI assistant. You are one persistent assistant, not a fresh session:
the conversation below is a single continuous timeline with the user, and you keep long-term memory across it.
Be direct, warm and concise. Use markdown when it helps. Today is {date}.
Use your tools whenever they make the answer better: search the web for anything current or uncertain and read the
best sources before answering, and run code for math, data or anything you would otherwise estimate.
When you use web sources, cite them inline as markdown links.`

function toMessage(r: any): Message {
  return {
    id: Number(r.id),
    role: r.role,
    content: r.content,
    model: r.model,
    steps: r.steps ?? undefined,
    createdAt: r.created_at.toISOString(),
  }
}

function clip(text: string, max = 4000) {
  return text.length > max ? text.slice(0, max) + '\n…' : text
}

const app = new Hono()
app.use('*', cors())
app.get('/health', (c) => c.json({ ok: true }))
app.use('/api/*', bearerAuth({ token }))

app.get('/api/models', (c) => c.json({ models: listModels(), default: defaultModel() ?? null }))

/** The timeline, newest page last. ?before=<id> pages backwards. */
app.get('/api/messages', async (c) => {
  const before = Number(c.req.query('before') ?? 0) || Number.MAX_SAFE_INTEGER
  const rows = await sql`select * from messages where id < ${before} order by id desc limit 100`
  return c.json({ messages: rows.reverse().map(toMessage) })
})

app.get('/api/memory', async (c) => c.json({ facts: await listFacts() }))
app.post('/api/memory', async (c) => {
  const { text } = await c.req.json<{ text: string }>()
  if (!text?.trim()) return c.json({ error: 'text required' }, 400)
  await addFact(text)
  return c.json({ facts: await listFacts() })
})
app.delete('/api/memory/:id', async (c) => {
  await deleteFact(Number(c.req.param('id')))
  return c.json({ facts: await listFacts() })
})

app.post('/api/chat', async (c) => {
  const body = await c.req.json<ChatRequest>()
  const content = body.content?.trim()
  const modelId = body.model ?? defaultModel()
  if (!content) return c.json({ error: 'content required' }, 400)
  if (!modelId) return c.json({ error: 'No provider configured. Add an API key to .env.' }, 400)

  const [userRow] = await sql`insert into messages (role, content) values ('user', ${content}) returning *`
  const history = await sql`select role, content from messages order by id desc limit ${CONTEXT_MESSAGES}`
  const messages: ModelMessage[] = history.reverse().map((r) => ({ role: r.role, content: r.content }))
  const system = SYSTEM.replace('{date}', new Date().toDateString()) + (await memoryPrompt())

  return streamSSE(c, async (stream) => {
    const send = (e: ChatEvent) => stream.writeSSE({ data: JSON.stringify(e) })
    await send({ type: 'user', message: toMessage(userRow) })
    let full = ''
    const steps: ToolStep[] = []
    try {
      const result = streamText({
        model: getModel(modelId),
        system,
        messages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: c.req.raw.signal,
        providerOptions: body.think ? (thinkOptions(modelId) as any) : undefined,
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          full += part.text
          await send({ type: 'delta', text: part.text })
        } else if (part.type === 'tool-call') {
          const step: ToolStep = {
            id: part.toolCallId,
            name: part.toolName,
            label: describeCall(part.toolName, part.input),
            input: part.input,
          }
          steps.push(step)
          await send({ type: 'tool-call', step })
        } else if (part.type === 'tool-result' || part.type === 'tool-error') {
          const step = steps.find((s) => s.id === part.toolCallId)
          const update =
            part.type === 'tool-result'
              ? { output: clip(typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2)) }
              : { error: String((part as any).error?.message ?? (part as any).error) }
          if (step) Object.assign(step, update)
          await send({ type: 'tool-result', id: part.toolCallId, ...update })
        } else if (part.type === 'error') {
          throw (part as any).error
        }
      }
      const [row] = await sql`
        insert into messages (role, content, model, steps)
        values ('assistant', ${full}, ${modelId}, ${steps.length ? sql.json(steps as any) : null})
        returning *`
      await send({ type: 'done', message: toMessage(row) })
      void extractFacts(content, full, Number(row.id))
    } catch (err: any) {
      console.error('[chat]', err)
      await send({ type: 'error', error: err?.message ?? String(err) })
    }
  })
})

const port = Number(process.env.PORT ?? 8787)
await migrate()
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
console.log(`Si-Bot core listening on :${port} with ${listModels().length} models, tools: ${Object.keys(tools).join(', ')}`)
