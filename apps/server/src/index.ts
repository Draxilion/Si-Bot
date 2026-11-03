import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'
import { streamSSE } from 'hono/streaming'
import type { AttachmentMeta, Bot, BotInput, ChatEvent, ChatRequest, Message, Task } from '@si-bot/shared'
import { getSetting, migrate, setSetting, sql } from './db.js'
import { defaultModel, discoverModels, listModels } from './providers.js'
import { addFact, deleteFact, extractFacts, listFacts } from './memory.js'
import { backfillEmbeddings, indexMessage } from './recall.js'
import { runTurn, suggestFollowUps, validTimezone } from './agent.js'
import { getDigest, getNotes, setDigestText, setNotes, updateDigest } from './context.js'
import { createTask, deleteTask, listTasks, startScheduler, toTask, updateTask } from './tasks.js'
import { activity, createBot, createTeam, deleteBot, deleteTeam, firstBotId, getBot, library, listBots, listTeams, renameTeam, saveLayout, updateBot } from './bots.js'
import { attachmentsFor, claimAttachments, getAttachment, MAX_FILE_BYTES, saveAttachment } from './attachments.js'

const token = process.env.SIBOT_TOKEN
if (!token || token === 'change-me') {
  console.error('Set SIBOT_TOKEN in .env (openssl rand -hex 32).')
  process.exit(1)
}

function toMessage(r: any): Message {
  return {
    id: Number(r.id),
    botId: Number(r.bot_id),
    ...(r.from_bot_id ? { fromBotId: Number(r.from_bot_id) } : {}),
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

async function saveReply(botId: number, result: Awaited<ReturnType<typeof runTurn>>, taskId?: number) {
  const [row] = await sql`
    insert into messages (bot_id, role, content, model, steps, reasoning, thought_ms, sources, partial, task_id)
    values (${botId}, 'assistant', ${result.text}, ${result.modelId}, ${result.steps.length ? sql.json(result.steps as any) : null},
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

/** The bot to act on: ?bot=<id> (or body.botId), falling back to the first bot. */
async function botFrom(id: unknown): Promise<Bot> {
  const n = Number(id)
  return (n && (await getBot(n))) || (await getBot(await firstBotId()))!
}

function modelFor(bot: Bot, requested?: string) {
  const ok = (m?: string | null) => !!m && listModels().some((x) => x.id === m)
  return ok(requested) ? requested! : ok(bot.model) ? bot.model! : defaultModel()
}

const roster = async () => ({ bots: await listBots(), teams: await listTeams() })
app.get('/api/bots', async (c) => c.json(await roster()))
app.put('/api/layout', async (c) => {
  await saveLayout(await c.req.json())
  return c.json(await roster())
})
app.post('/api/teams', async (c) => {
  try {
    await createTeam((await c.req.json<{ name: string }>()).name ?? '')
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
  return c.json(await roster())
})
app.patch('/api/teams/:name', async (c) => {
  try {
    await renameTeam(decodeURIComponent(c.req.param('name')), (await c.req.json<{ name: string }>()).name ?? '')
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
  return c.json(await roster())
})
app.delete('/api/teams/:name', async (c) => {
  await deleteTeam(decodeURIComponent(c.req.param('name')))
  return c.json(await roster())
})
app.post('/api/bots', async (c) => {
  try {
    const bot = await createBot(await c.req.json<BotInput>())
    return c.json({ bot, ...(await roster()) })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})
app.patch('/api/bots/:id', async (c) => {
  const bot = await updateBot(Number(c.req.param('id')), await c.req.json<BotInput>())
  if (!bot) return c.json({ error: 'not found' }, 404)
  return c.json({ bot, ...(await roster()) })
})
app.delete('/api/bots/:id', async (c) => {
  try {
    await deleteBot(Number(c.req.param('id')))
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
  return c.json(await roster())
})
app.get('/api/bots/:id/library', async (c) => c.json({ items: await library(Number(c.req.param('id'))) }))
app.get('/api/bots/:id/activity', async (c) => c.json({ items: await activity(Number(c.req.param('id'))) }))

/** The timeline, newest page last. ?before=<id> pages backwards; ?after=<id> returns newer messages (polling). */
app.get('/api/messages', async (c) => {
  const bot = await botFrom(c.req.query('bot'))
  const after = Number(c.req.query('after') ?? 0)
  if (after) {
    const rows = await sql`select * from messages where bot_id = ${bot.id} and id > ${after} order by id limit 100`
    return c.json({ messages: await withAttachments(rows) })
  }
  const before = Number(c.req.query('before') ?? 0) || Number.MAX_SAFE_INTEGER
  const rows = await sql`select * from messages where bot_id = ${bot.id} and id < ${before} order by id desc limit 100`
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

/** A bot's notebook and the rolling digest of its older history: both visible and editable in the app. */
app.get('/api/context', async (c) => {
  const bot = await botFrom(c.req.query('bot'))
  return c.json({ notes: await getNotes(bot.id), digest: await getDigest(bot.id) })
})
app.put('/api/context', async (c) => {
  const bot = await botFrom(c.req.query('bot'))
  const body = await c.req.json<{ notes?: string; digest?: string }>()
  if (typeof body.notes === 'string') await setNotes(bot.id, body.notes)
  if (typeof body.digest === 'string') await setDigestText(bot.id, body.digest)
  return c.json({ notes: await getNotes(bot.id), digest: await getDigest(bot.id) })
})

app.get('/api/tasks', async (c) => c.json({ tasks: await listTasks(Number(c.req.query('bot')) || undefined) }))
app.post('/api/tasks', async (c) => {
  const body = await c.req.json<{ botId?: number; title: string; prompt: string; cron?: string; runAt?: string; timezone?: string }>()
  if (!body.title?.trim() || !body.prompt?.trim()) return c.json({ error: 'title and prompt required' }, 400)
  try {
    await createTask({ ...body, botId: (await botFrom(body.botId)).id, timezone: validTimezone(body.timezone) })
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
  const bot = await botFrom(body.botId)
  const modelId = modelFor(bot, body.model)
  if (!modelId) return c.json({ error: 'No provider configured. Add an API key to .env.' }, 400)
  const timezone = validTimezone(body.timezone) ?? (await getSetting('timezone', 'UTC'))
  if (body.timezone && timezone === body.timezone) void setSetting('timezone', timezone)

  let userRow: any
  let attached: AttachmentMeta[] = []
  if (body.regenerate) {
    ;[userRow] = await sql`select * from messages where bot_id = ${bot.id} and role = 'user' order by id desc limit 1`
    if (!userRow) return c.json({ error: 'Nothing to regenerate' }, 400)
    await sql`delete from messages where bot_id = ${bot.id} and id > ${userRow.id}`
    attached = (await attachmentsFor([Number(userRow.id)])).get(Number(userRow.id)) ?? []
  } else {
    const content = body.content?.trim() ?? ''
    const files = body.attachments ?? []
    if (!content && !files.length) return c.json({ error: 'content required' }, 400)
    if (body.replaceFrom) await sql`delete from messages where bot_id = ${bot.id} and id >= ${body.replaceFrom}`
    ;[userRow] = await sql`insert into messages (bot_id, role, content) values (${bot.id}, 'user', ${content}) returning *`
    attached = await claimAttachments(files, Number(userRow.id))
    void indexMessage(Number(userRow.id), content)
  }
  const userId = Number(userRow.id)
  const content: string = userRow.content

  return streamSSE(c, async (stream) => {
    const send = (e: ChatEvent) => stream.writeSSE({ data: JSON.stringify(e) })
    await send({ type: 'user', message: { ...toMessage(userRow), ...(attached.length ? { attachments: attached } : {}) } })
    const result = await runTurn({
      bot,
      deliver,
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
      const row = await saveReply(bot.id, result)
      await send({ type: 'done', message: toMessage(row) }).catch(() => {})
      if (!result.partial) {
        void extractFacts(content, result.text, Number(row.id))
        void indexMessage(Number(row.id), result.text)
      }
      void updateDigest(bot.id)
    }
    if (result.error) await send({ type: 'error', error: result.error }).catch(() => {})
    if (!result.partial && !result.error && !c.req.raw.signal.aborted) {
      const suggestions = await suggestFollowUps(content, result.text, modelId)
      if (suggestions.length) await send({ type: 'suggestions', suggestions }).catch(() => {})
    }
  })
})

const BOT_REPLY_TIMEOUT_MS = 150_000

/**
 * Bot-to-bot messaging: writes the message into the other bot's timeline, lets it answer there, and returns the
 * answer to the sender. The receiving bot gets no message_bot tool for this turn, so bots can't loop.
 */
async function deliver(from: Bot, to: Bot, text: string): Promise<string> {
  const modelId = modelFor(to)
  if (!modelId) return 'No model available.'
  const [row] = await sql`
    insert into messages (bot_id, role, content, from_bot_id) values (${to.id}, 'user', ${text}, ${from.id}) returning id`
  void indexMessage(Number(row.id), text)
  const timezone = await getSetting('timezone', 'UTC')
  const turn = runTurn({
    bot: to,
    modelId,
    upToId: Number(row.id),
    query: text,
    timezone,
    extraSystem: `${from.name} (another bot) is messaging you, not the user. Answer it directly and helpfully.`,
    onEvent: () => {},
  }).then(async (result) => {
    if (result.text || result.steps.length) {
      const saved = await saveReply(to.id, result)
      void indexMessage(Number(saved.id), result.text)
      void updateDigest(to.id)
    }
    return result.text || result.error || '(no answer)'
  })
  const timeout = new Promise<string>((resolve) =>
    setTimeout(() => resolve(`${to.name} is still working on it; its answer will appear in its own timeline.`), BOT_REPLY_TIMEOUT_MS),
  )
  const reply = await Promise.race([turn, timeout])
  return reply.length > 6000 ? reply.slice(0, 6000) + '…' : reply
}

/** Runs a scheduled task and posts the result into its bot's timeline as an assistant message. */
async function runTask(task: Task) {
  const bot = await botFrom(task.botId)
  const modelId = modelFor(bot)
  if (!modelId) return
  const [last] = await sql`select coalesce(max(id), 0) as id from messages where bot_id = ${bot.id}`
  const result = await runTurn({
    bot,
    deliver,
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
    const row = await saveReply(bot.id, result, task.id)
    void indexMessage(Number(row.id), result.text)
  }
}

const port = Number(process.env.PORT ?? 8787)
await migrate()
await discoverModels()
void backfillEmbeddings()
startScheduler(runTask)
for (const b of await listBots()) void updateDigest(b.id)
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
console.log(`Si-Bot core listening on :${port} with ${listModels().length} models`)
