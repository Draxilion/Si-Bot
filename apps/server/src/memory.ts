import { generateText, tool } from 'ai'
import { z } from 'zod'
import type { Fact } from '@si-bot/shared'
import { sql } from './db.js'
import { getModel, listModels } from './providers.js'
import { formatRecalled, recall } from './recall.js'

export async function listFacts(): Promise<Fact[]> {
  const rows = await sql`select id, text, created_at from facts order by created_at desc`
  return rows.map((r) => ({ id: Number(r.id), text: r.text, createdAt: r.created_at.toISOString() }))
}

export async function addFact(text: string, sourceMessageId?: number) {
  await sql`
    insert into facts (text, source_message_id) values (${text.trim()}, ${sourceMessageId ?? null})
    on conflict (lower(text)) do nothing`
}

export async function deleteFact(id: number) {
  await sql`delete from facts where id = ${id}`
}

/** Facts injected into every prompt. Phase 2 swaps this for pgvector recall once the list grows. */
export async function memoryPrompt(): Promise<string> {
  const facts = await listFacts()
  if (!facts.length) return ''
  return `\n\nWhat you remember about the user (long-term memory):\n${facts.map((f) => `- ${f.text}`).join('\n')}`
}

function memoryModelId(): string | undefined {
  const wanted = process.env.MEMORY_MODEL
  const models = listModels()
  if (wanted && models.some((m) => m.id === wanted)) return wanted
  return models[0]?.id
}

/**
 * Runs after each exchange, in the background: asks a cheap model for durable facts worth
 * remembering and stores the new ones. Failures are logged and never reach the chat.
 */
export async function extractFacts(userText: string, assistantText: string, sourceMessageId: number) {
  const modelId = memoryModelId()
  if (!modelId) return
  try {
    const known = (await listFacts()).map((f) => `- ${f.text}`).join('\n') || '(none)'
    const { text } = await generateText({
      model: getModel(modelId),
      system:
        'You maintain the long-term memory of a personal assistant. From the exchange, list NEW durable facts about the user ' +
        '(identity, preferences, projects, people, goals, setup). Skip small talk, one-off requests and anything already known. ' +
        'One fact per line, third person, under 20 words, no bullets. If nothing is worth saving, reply NONE.',
      prompt: `Already known:\n${known}\n\nUser: ${userText}\n\nAssistant: ${assistantText}`,
    })
    if (text.trim().toUpperCase() === 'NONE') return
    for (const line of text.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean)) {
      await addFact(line, sourceMessageId)
    }
  } catch (err) {
    console.error('[memory] extraction failed:', err)
  }
}

/** Tools that let the assistant manage its own memory mid-conversation. */
export function memoryTools() {
  return {
    remember: tool({
      description:
        'Save a durable fact about the user to long-term memory (preferences, people, projects, plans). ' +
        'Use it when the user asks you to remember something or shares something clearly worth keeping.',
      inputSchema: z.object({ fact: z.string().describe('One fact, third person, under 20 words') }),
      execute: async ({ fact }) => {
        await addFact(fact)
        return { saved: fact }
      },
    }),
    recall_memory: tool({
      description:
        'Search the whole conversation history with the user, by keyword and meaning. ' +
        'Use it when the user refers to something from the past that is not in the recent conversation.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const found = await recall(query, { limit: 10 })
        return { results: found.length ? formatRecalled(found, 1200) : 'Nothing found.' }
      },
    }),
  }
}
