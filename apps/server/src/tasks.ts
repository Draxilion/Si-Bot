import { tool } from 'ai'
import { z } from 'zod'
import { Cron } from 'croner'
import type { Task } from '@si-bot/shared'
import { getSetting, sql } from './db.js'

export function toTask(r: any): Task {
  return {
    id: Number(r.id),
    title: r.title,
    prompt: r.prompt,
    cron: r.cron,
    runAt: r.run_at?.toISOString() ?? null,
    timezone: r.timezone,
    enabled: r.enabled,
    nextRunAt: r.next_run_at?.toISOString() ?? null,
    lastRunAt: r.last_run_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  }
}

/** Next time a repeating task fires after `from`, or null if the cron expression never fires again. */
export function nextCronRun(cron: string, timezone: string, from = new Date()): Date | null {
  return new Cron(cron, { timezone, paused: true }).nextRun(from)
}

export async function listTasks(): Promise<Task[]> {
  const rows = await sql`select * from tasks order by enabled desc, next_run_at nulls last, id`
  return rows.map(toTask)
}

export async function createTask(input: { title: string; prompt: string; cron?: string; runAt?: string; timezone?: string }) {
  const timezone = input.timezone || (await getSetting('timezone', 'UTC'))
  let next: Date | null
  if (input.cron) {
    next = nextCronRun(input.cron, timezone) // throws on an invalid expression
  } else if (input.runAt) {
    next = new Date(input.runAt)
    if (Number.isNaN(next.getTime())) throw new Error(`Invalid time: ${input.runAt}`)
    if (next.getTime() < Date.now() - 60_000) throw new Error('That time is in the past')
  } else {
    throw new Error('Give either cron (repeating) or run_at (one-off)')
  }
  const [row] = await sql`
    insert into tasks (title, prompt, cron, run_at, timezone, next_run_at)
    values (${input.title}, ${input.prompt}, ${input.cron ?? null}, ${input.runAt ? new Date(input.runAt) : null},
            ${timezone}, ${next})
    returning *`
  return toTask(row)
}

export async function updateTask(id: number, patch: { enabled?: boolean }) {
  const [cur] = await sql`select * from tasks where id = ${id}`
  if (!cur) return null
  const enabled = patch.enabled ?? cur.enabled
  let next = cur.next_run_at
  if (enabled && !cur.enabled && cur.cron) next = nextCronRun(cur.cron, cur.timezone)
  const [row] = await sql`update tasks set enabled = ${enabled}, next_run_at = ${next} where id = ${id} returning *`
  return toTask(row)
}

export async function deleteTask(id: number) {
  await sql`delete from tasks where id = ${id}`
}

/** Tools that let Si schedule work for itself. */
export function taskTools(getTimezone: () => string | undefined) {
  return {
    create_task: tool({
      description:
        'Schedule work for yourself: a reminder, a daily brief, monitoring something, any prompt to run later or on repeat. ' +
        'When it fires, you run the prompt with all your tools and post the result into the conversation. ' +
        'Give cron for repeating tasks or run_at for a one-off, interpreted in the user\'s timezone.',
      inputSchema: z.object({
        title: z.string().describe('Short name shown to the user, e.g. "Morning news brief"'),
        prompt: z
          .string()
          .describe('Instruction to yourself for when it runs, self-contained, e.g. "Search for today\'s top AI news and summarise the 5 biggest stories."'),
        cron: z.string().optional().describe('5-field cron in the user\'s timezone, e.g. "0 8 * * 1-5" for weekdays at 08:00'),
        run_at: z.string().optional().describe('ISO 8601 date-time with offset for a one-off run, e.g. "2026-11-04T09:30:00+02:00"'),
      }),
      execute: async ({ title, prompt, cron, run_at }) => {
        const task = await createTask({ title, prompt, cron, runAt: run_at, timezone: getTimezone() })
        return { scheduled: task.title, id: task.id, next_run: task.nextRunAt, timezone: task.timezone }
      },
    }),
    list_tasks: tool({
      description: 'List your scheduled tasks with their ids and next run times.',
      inputSchema: z.object({}),
      execute: async () => ({ tasks: await listTasks() }),
    }),
    cancel_task: tool({
      description: 'Delete a scheduled task by id (use list_tasks to find it).',
      inputSchema: z.object({ id: z.number() }),
      execute: async ({ id }) => {
        await deleteTask(id)
        return { cancelled: id }
      },
    }),
  }
}

/**
 * Checks for due tasks every 30 seconds and runs them one at a time. A task's next run is set before it runs,
 * so a crash mid-run never fires it twice; one-off tasks are disabled once they start.
 */
export function startScheduler(run: (task: Task) => Promise<void>) {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const due = await sql`select * from tasks where enabled and next_run_at <= now() order by next_run_at limit 5`
      for (const r of due) {
        const task = toTask(r)
        const next = task.cron ? nextCronRun(task.cron, task.timezone) : null
        await sql`
          update tasks set last_run_at = now(), next_run_at = ${next}, enabled = ${next !== null}
          where id = ${task.id}`
        console.log(`[tasks] running #${task.id} "${task.title}"`)
        await run(task).catch((err) => console.error(`[tasks] #${task.id} failed:`, err))
      }
    } catch (err) {
      console.error('[tasks] scheduler error:', err)
    } finally {
      busy = false
    }
  }
  setInterval(tick, 30_000)
  void tick()
}
