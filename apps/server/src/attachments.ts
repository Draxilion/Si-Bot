import type { AttachmentMeta } from '@si-bot/shared'
import { sql } from './db.js'
import { pdfText } from './tools.js'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_CHARS = 60_000

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql|csv))/
const TEXT_EXT = /\.(txt|md|csv|tsv|json|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|rs|go|java|kt|swift|c|h|cpp|cs|rb|php|sh|sql|log|ini|env)$/i

export function isImage(mediaType: string) {
  return /^image\/(png|jpe?g|gif|webp)$/.test(mediaType)
}

/** Stores an upload and extracts its text up front (PDFs and text files) so each chat turn is cheap. */
export async function saveAttachment(name: string, mediaType: string, data: Uint8Array): Promise<AttachmentMeta> {
  let text: string | null = null
  if (mediaType === 'application/pdf' || /\.pdf$/i.test(name)) {
    mediaType = 'application/pdf'
    text = await pdfText(data).catch((err) => `(could not read this PDF: ${err.message})`)
  } else if (TEXT_TYPES.test(mediaType) || TEXT_EXT.test(name)) {
    text = new TextDecoder().decode(data)
  } else if (!isImage(mediaType)) {
    throw new Error(`Unsupported file type: ${mediaType || name}`)
  }
  const [row] = await sql`
    insert into attachments (name, media_type, size, data, text)
    values (${name}, ${mediaType}, ${data.byteLength}, ${Buffer.from(data)}, ${text?.slice(0, MAX_TEXT_CHARS) ?? null})
    returning id, name, media_type, size`
  return toMeta(row)
}

function toMeta(r: any): AttachmentMeta {
  return { id: Number(r.id), name: r.name, mediaType: r.media_type, size: r.size }
}

export async function claimAttachments(ids: number[], messageId: number) {
  if (!ids.length) return []
  const rows = await sql`
    update attachments set message_id = ${messageId}
    where id = any(${ids}) and message_id is null
    returning id, name, media_type, size`
  return rows.map(toMeta)
}

export async function attachmentsFor(messageIds: number[]): Promise<Map<number, AttachmentMeta[]>> {
  const map = new Map<number, AttachmentMeta[]>()
  if (!messageIds.length) return map
  const rows = await sql`
    select id, message_id, name, media_type, size from attachments
    where message_id = any(${messageIds}) order by id`
  for (const r of rows) {
    const id = Number(r.message_id)
    map.set(id, [...(map.get(id) ?? []), toMeta(r)])
  }
  return map
}

export async function getAttachment(id: number) {
  const [row] = await sql`select name, media_type, data from attachments where id = ${id}`
  return row as { name: string; media_type: string; data: Buffer } | undefined
}

/**
 * Model content parts for a user message's files: text files and PDFs inline as text, images as image parts.
 * `withImages` is false for older messages, so images are only sent on the turn they were attached.
 */
export async function attachmentParts(messageIds: number[], withImages: (messageId: number) => boolean) {
  const parts = new Map<number, any[]>()
  if (!messageIds.length) return parts
  const rows = await sql`
    select message_id, name, media_type, text, case when media_type like 'image/%' then data end as data
    from attachments where message_id = any(${messageIds}) order by id`
  for (const r of rows) {
    const mid = Number(r.message_id)
    const list = parts.get(mid) ?? []
    if (isImage(r.media_type)) {
      if (withImages(mid)) list.push({ type: 'file', data: new Uint8Array(r.data), mediaType: r.media_type })
      else list.push({ type: 'text', text: `[Image attached earlier: ${r.name}]` })
    } else {
      list.push({ type: 'text', text: `Attached file "${r.name}":\n<file>\n${r.text ?? ''}\n</file>` })
    }
    parts.set(mid, list)
  }
  return parts
}
