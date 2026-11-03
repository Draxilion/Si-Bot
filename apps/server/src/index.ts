import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'
import { streamSSE } from 'hono/streaming'
import type { AttachmentMeta, ChatEvent, ChatRequest, Message, Task } from '@si-bot/shared'
import { getSetting, migrate, setSetting, sql } from './db.js'
import { defaultModel, discoverModels, listModels } from './providers.js'
import { addFact, deleteFact, extractFacts, listFacts } from './memory.js'
import { backfillEmbeddings, indexMessage } from './recall.js'
import { runTurn, suggestFollowUps, validTimezone } from './agent.js'
import { createTask, deleteTask, listTasks, startScheduler, toTask, updateTask } from './tasks.js'
import { attachmentsFor, claimAttachments, getAttachment, MAX_FILE_BYTES, saveAttachment } from './attachments.js'

const token = process.env.SIBOT_TOKEN
if (!token || token === 'change-me') {
  console.error('Set SIBOT_TOKEN in .env (openssl rand -hex 32).')
  process.exit(1)
}

function toMessage(r: any): Message {
  return {
    id: Number(r.id),
    role: r.role,
    content: r.content,
    model: r.model,
    steps: r.steps ?? undefined,
    reasoning: r.reasoning ?? undefined,
    thoughtMs: r.thought_ms ?? undefined,
    sources: r.sources ?? undefined,
    taskId: r.task_id ? Number(r.task_id) : undefined,
    partial: r.partial || undefined,
    createdAt: r.created_at.toISOString(),
  }
}

async function withAttachments(rows: any[]): Promise<Message[]> {
  const files = await attachmentsFor(rows.filter((r) => r.role === 'user').map((r) => Number(r.id)))
  return rows.map((r) => {
    const m = toMessage(r)
    const a = files.get(m.id)
    if (a) m.attachments = a
    return m
  })
}

async function saveReply(result: Awaited<ReturnType<typeof runTurn>>, taskId?: number) {
  const [row] = await sql`
    insert into messages (role, content, model, steps, reasoning, thought_ms, sources, partial, task_id)
    values ('assistant', ${result.text}, ${result.modelId}, ${result.steps.length ? sql.json(result.steps as any) : null},
            ${result.reasoning || null}, ${result.thoughtMs || null},
            ${result.sources.length ? sql.json(result.sources as any) : null}, ${result.partial}, ${taskId ?? null})
    returning *`
  return row
}

const app = new Hono()
app.use('*', cors())
app.get('/health', (c) => c.json({ ok: true }))
// Files can also be fetched with ?token= so the app can show images in <img> tags.
app.use('/api/files/:id', async (c, next) => {
  if (c.req.method === 'GET' && c.req.query('token') === token) return next()
  return bearerAuth({ token })(c, next)
})
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/files/') && c.req.method === 'GET') return next()
  return bearerAuth({ token })(c, next)
})

app.get('/api/models', (c) => c.json({ models: listModels(), default: defaultModel() ?? null }))

/** The timeline, newest page last. ?before=<id> pages backwards; ?after=<id> returns newer messages (polling). */
app.get('/api/messages', async (c) => {
  const after = Number(c.req.query('after') ?? 0)
  if (after) {
    const rows = await sql`select * from messages where id > ${after} order by id limit 100`
    return c.json({ messages: await withAttachments(rows) })
  }
  const before = Number(c.req.query('before') ?? 0) || Number.MAX_SAFE_INTEGER
  const rows = await sql`select * from messages where id < ${before} order by id desc limit 100`
  return c.json({ messages: await withAttachments([...rows].reverse()) })
})

/** Search the whole timeline: full-text first, substring match as a fallback for short or partial words. */
app.get('/api/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json({ messages: [] })
  const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  let rows: any[] = []
  if (terms.length) {
    const tsq = terms.map((t) => `${t}:*`).join(' & ')
    rows = await sql`
      select *, ts_headline('simple', content, to_tsquery('simple', ${tsq}),
        'MaxFragments=2, MaxWords=24, MinWords=8, StartSel=<<, StopSel=>>') as snippet
      from messages where tsv @@ to_tsquery('simple', ${tsq})
      order by id desc limit 50`
  }
  if (!rows.length) {
    rows = await sql`select *, left(content, 240) as snippet from messages where content ilike ${'%' + q + '%'} order by id desc limit 50`
  }
  return c.json({ messages: rows.map((r) => ({ ...toMessage(r), snippet: r.snippet })) })
})

app.delete('/api/messages/:id', async (c) => {
  await sql`delete from messages where id = ${Number(c.req.param('id'))}`
  return c.json({ ok: true })
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

app.get('/api/tasks', async (c) => c.json({ tasks: await listTasks() }))
app.post('/api/tasks', async (c) => {
  const body = await c.req.json<{ title: string; prompt: string; cron?: string; runAt?: string; timezone?: string }>()
  if (!body.title?.trim() || !body.prompt?.trim()) return c.json({ error: 'title and prompt required' }, 400)
  try {
    await createTask({ ...body, timezone: validTimezone(body.timezone) })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
  return c.json({ tasks: await listTasks() })
})
app.patch('/api/tasks/:id', async (c) => {
  await updateTask(Number(c.req.param('id')), await c.req.json())
  return c.json({ tasks: await listTasks() })
})
app.delete('/api/tasks/:id', async (c) => {
  await deleteTask(Number(c.req.param('id')))
  return c.json({ tasks: await listTasks() })
})
/** Runs a task now, outside its schedule. The result lands in the timeline like a scheduled run. */
app.post('/api/tasks/:id/run', async (c) => {
  const [row] = await sql`select * from tasks where id = ${Number(c.req.param('id'))}`
  if (!row) return c.json({ error: 'not found' }, 404)
  void runTask(toTask(row))
  return c.json({ ok: true })
})

app.post('/api/files', async (c) => {
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400)
  if (file.size > MAX_FILE_BYTES) return c.json({ error: 'File is larger than 20 MB' }, 413)
  try {
    const meta = await saveAttachment(file.name, file.type, new Uint8Array(await file.arrayBuffer()))
    return c.json({ file: meta })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})
app.get('/api/files/:id', async (c) => {
  const file = await getAttachment(Number(c.req.param('id')))
  if (!file) return c.json({ error: 'not found' }, 404)
  return c.body(new Uint8Array(file.data), 200, {
    'content-type': file.media_type,
    'content-disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
    'cache-control': 'private, max-age=31536000, immutable',
  })
})

app.post('/api/chat', async (c) => {
  const body = await c.req.json<ChatRequest>()
  const modelId = body.model && listModels().some((m) => m.id === body.model) ? body.model : defaultModel()
  if (!modelId) return c.json({ error: 'No provider configured. Add an API key to .env.' }, 400)
  const timezone = validTimezone(body.timezone) ?? (await getSetting('timezone', 'UTC'))
  if (body.timezone && timezone === body.timezone) void setSetting('timezone', timezone)

  let userRow: any
  let attached: AttachmentMeta[] = []
  if (body.regenerate) {
    ;[userRow] = await sql`select * from messages where role = 'user' order by id desc limit 1`
    if (!userRow) return c.json({ error: 'Nothing to regenerate' }, 400)
    await sql`delete from messages where id > ${userRow.id}`
    attached = (await attachmentsFor([Number(userRow.id)])).get(Number(userRow.id)) ?? []
  } else {
    const content = body.content?.trim() ?? ''
    const files = body.attachments ?? []
    if (!content && !files.length) return c.json({ error: 'content required' }, 400)
    if (body.replaceFrom) await sql`delete from messages where id >= ${body.replaceFrom}`
    ;[userRow] = await sql`insert into messages (role, content) values ('user', ${content}) returning *`
    attached = await claimAttachments(files, Number(userRow.id))
    void indexMessage(Number(userRow.id), content)
  }
  const userId = Number(userRow.id)
  const content: string = userRow.content

  return streamSSE(c, async (stream) => {
    const send = (e: ChatEvent) => stream.writeSSE({ data: JSON.stringify(e) })
    await send({ type: 'user', message: { ...toMessage(userRow), ...(attached.length ? { attachments: attached } : {}) } })
    const result = await runTurn({
      modelId,
      upToId: userId,
      query: content,
      think: body.think,
      deep: body.deep,
      timezone,
      signal: c.req.raw.signal,
      onEvent: send,
    })
    // Save whatever was produced, including a reply the user stopped half-way, so the timeline stays honest.
    if (result.text || result.steps.length) {
      const row = await saveReply(result)
      await send({ type: 'done', message: toMessage(row) }).catch(() => {})
      if (!result.partial) {
        void extractFacts(content, result.text, Number(row.id))
        void indexMessage(Number(row.id), result.text)
      }
    }
    if (result.error) await send({ type: 'error', error: result.error }).catch(() => {})
    if (!result.partial && !result.error && !c.req.raw.signal.aborted) {
      const suggestions = await suggestFollowUps(content, result.text, modelId)
      if (suggestions.length) await send({ type: 'suggestions', suggestions }).catch(() => {})
    }
  })
})

/** Runs a scheduled task and posts the result into the timeline as an assistant message. */
async function runTask(task: Task) {
  const modelId = defaultModel()
  if (!modelId) return
  const [last] = await sql`select coalesce(max(id), 0) as id from messages`
  const result = await runTurn({
    modelId,
    upToId: Number(last.id),
    query: task.prompt,
    timezone: task.timezone,
    noTaskTools: true,
    extraSystem:
      `You are now running the scheduled task "${task.title}" on your own; the user is not watching live. ` +
      'Write the result as a message to the user, starting with a short bold title. Do not ask questions; do the work ' +
      'with your tools.',
    appendUser: `[Scheduled task "${task.title}"] ${task.prompt}`,
    onEvent: () => {},
  })
  if (result.text) {
    const row = await saveReply(result, task.id)
    void indexMessage(Number(row.id), result.text)
  }
}

const port = Number(process.env.PORT ?? 8787)
await migrate()
await discoverModels()
void backfillEmbeddings()
startScheduler(runTask)
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
console.log(`Si-Bot core listening on :${port} with ${listModels().length} models`)
