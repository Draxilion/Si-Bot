import postgres from 'postgres'

export const sql = postgres(process.env.DATABASE_URL ?? 'postgres://sibot:sibot@localhost:5432/sibot', {
  onnotice: () => {},
})

/** Idempotent schema setup, run on boot. pgvector is enabled now for Phase 2 semantic recall. */
export async function migrate() {
  await sql`create extension if not exists vector`
  await sql`
    create table if not exists messages (
      id bigserial primary key,
      role text not null check (role in ('user', 'assistant')),
      content text not null,
      model text,
      created_at timestamptz not null default now()
    )`
  await sql`
    create table if not exists facts (
      id bigserial primary key,
      text text not null,
      source_message_id bigint references messages(id) on delete set null,
      created_at timestamptz not null default now()
    )`
  await sql`alter table messages add column if not exists steps jsonb`
  await sql`create unique index if not exists facts_text_uniq on facts (lower(text))`
}
