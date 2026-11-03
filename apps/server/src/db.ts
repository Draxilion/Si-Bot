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
  // Keyword recall: full-text index over the whole timeline ('simple' config works for any language).
  await sql`
    alter table messages add column if not exists tsv tsvector
    generated always as (to_tsvector('simple', content)) stored`
  await sql`create index if not exists messages_tsv_idx on messages using gin (tsv)`
  // Semantic recall: untyped vector so the embedding model can change; rows are matched on dimension.
  await sql`alter table messages add column if not exists embedding vector`
  await sql`create unique index if not exists facts_text_uniq on facts (lower(text))`
  await sql`alter table messages add column if not exists reasoning text`
  await sql`alter table messages add column if not exists thought_ms integer`
  await sql`alter table messages add column if not exists sources jsonb`
  await sql`alter table messages add column if not exists partial boolean not null default false`
  await sql`
    create table if not exists tasks (
      id bigserial primary key,
      title text not null,
      prompt text not null,
      cron text,
      run_at timestamptz,
      timezone text not null default 'UTC',
      enabled boolean not null default true,
      next_run_at timestamptz,
      last_run_at timestamptz,
      created_at timestamptz not null default now()
    )`
  await sql`alter table messages add column if not exists task_id bigint references tasks(id) on delete set null`
  // Uploaded files. Kept in Postgres so a single pg_dump backs up everything.
  await sql`
    create table if not exists attachments (
      id bigserial primary key,
      -- Set null rather than cascade, so editing a message can re-attach its files to the replacement.
      message_id bigint references messages(id) on delete set null,
      name text not null,
      media_type text not null,
      size integer not null,
      data bytea not null,
      text text,
      created_at timestamptz not null default now()
    )`
  // Kept for convenience: settings the server needs between requests (e.g. the user's timezone).
  await sql`create table if not exists settings (key text primary key, value jsonb not null)`
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await sql`select value from settings where key = ${key}`
  return row ? (row.value as T) : fallback
}

export async function setSetting(key: string, value: unknown) {
  await sql`
    insert into settings (key, value) values (${key}, ${sql.json(value as any)})
    on conflict (key) do update set value = excluded.value`
}
