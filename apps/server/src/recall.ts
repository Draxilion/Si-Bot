import { embed } from 'ai'
import { sql } from './db.js'
import { embeddingModelId, getEmbeddingModel } from './providers.js'

export interface Recalled {
  id: number
  role: string
  content: string
  createdAt: string
}

const RRF_K = 60

async function embedText(text: string): Promise<number[] | null> {
  const id = embeddingModelId()
  if (!id) return null
  const { embedding } = await embed({ model: getEmbeddingModel(id), value: text.slice(0, 8000) })
  return embedding
}

const toVector = (v: number[]) => `[${v.join(',')}]`

/** Embeds a stored message in the background so it can be recalled by meaning later. */
export async function indexMessage(id: number, content: string) {
  try {
    const v = await embedText(content)
    if (v) await sql`update messages set embedding = ${toVector(v)}::vector where id = ${id}`
  } catch (err) {
    console.error('[recall] embedding failed:', err)
  }
}

/** Embeds messages that have none yet (older history, or after switching on an embedding model). */
export async function backfillEmbeddings(batch = 200) {
  if (!embeddingModelId()) return
  const rows = await sql`select id, content from messages where embedding is null order by id desc limit ${batch}`
  for (const r of rows) await indexMessage(Number(r.id), r.content)
  if (rows.length) console.log(`[recall] embedded ${rows.length} messages`)
}

/**
 * Hybrid recall over the timeline: full-text and vector search, merged with reciprocal rank fusion.
 * `beforeId` excludes messages already in the prompt's recent context.
 */
export async function recall(query: string, opts: { beforeId?: number; limit?: number } = {}): Promise<Recalled[]> {
  const limit = opts.limit ?? 6
  const beforeId = opts.beforeId ?? Number.MAX_SAFE_INTEGER
  const ranks = new Map<number, number>()
  const add = (ids: number[]) => ids.forEach((id, i) => ranks.set(id, (ranks.get(id) ?? 0) + 1 / (RRF_K + i + 1)))

  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
  if (terms.length) {
    const tsq = terms.slice(0, 12).join(' | ')
    const rows = await sql`
      select id from messages
      where id < ${beforeId} and tsv @@ to_tsquery('simple', ${tsq})
      order by ts_rank(tsv, to_tsquery('simple', ${tsq})) desc
      limit 20`
    add(rows.map((r) => Number(r.id)))
  }

  try {
    const v = await embedText(query)
    if (v) {
      const rows = await sql`
        select id from messages
        where id < ${beforeId} and embedding is not null and vector_dims(embedding) = ${v.length}
        order by embedding <=> ${toVector(v)}::vector
        limit 20`
      add(rows.map((r) => Number(r.id)))
    }
  } catch (err) {
    console.error('[recall] vector search failed:', err)
  }

  const top = [...ranks.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)
  if (!top.length) return []
  const rows = await sql`select id, role, content, created_at from messages where id = any(${top}) order by id`
  return rows.map((r) => ({ id: Number(r.id), role: r.role, content: r.content, createdAt: r.created_at.toISOString() }))
}

export function formatRecalled(items: Recalled[], maxChars = 600): string {
  return items
    .map((m) => {
      const text = m.content.length > maxChars ? m.content.slice(0, maxChars) + '…' : m.content
      return `[${m.createdAt.slice(0, 10)}] ${m.role === 'user' ? 'User' : 'You'}: ${text}`
    })
    .join('\n')
}
