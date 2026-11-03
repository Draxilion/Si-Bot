import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'
import { streamSSE } from 'hono/streaming'
import { streamText, type ModelMessage } from 'ai'
import type { ChatEvent, ChatRequest, Message } from '@si-bot/shared'
import { migrate, sql } from './db.js'
import { defaultModel, getModel, listModels, thinkOptions } from './providers.js'
import { addFact, deleteFact, extractFacts, listFacts, memoryPrompt } from './memory.js'

const token = process.env.SIBOT_TOKEN
if (!token || token === 'change-me') {
  console.error('Set SIBOT_TOKEN in .env (openssl rand -hex 32).')
  process.exit(1)
}

const CONTEXT_MESSAGES = 40

const SYSTEM = `You are Si, a personal AI assistant. You are one persistent assistant, not a fresh session:
the conversation below is a single continuous timeline with the user, and you keep long-term memory across it.
Be direct, warm and concise. Use markdown when it helps. Today is {date}.`

function toMessage(r: any): Message {
  return { id: Number(r.id), role: r.role, content: r.content, model: r.model, createdAt: r.created_at.toISOString() }
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
    try {
      const result = streamText({
        model: getModel(modelId),
        system,
        messages,
        providerOptions: body.think ? (thinkOptions(modelId) as any) : undefined,
      })
      for await (const delta of result.textStream) {
        full += delta
        await send({ type: 'delta', text: delta })
      }
      const [row] = await sql`
        insert into messages (role, content, model) values ('assistant', ${full}, ${modelId}) returning *`
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
console.log(`Si-Bot core listening on :${port} with ${listModels().length} models`)
