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
  // Bots: each one is a named assistant with its own persistent timeline. The first bot (Si) owns pre-bot history.
  await sql`
    create table if not exists bots (
      id bigserial primary key,
      name text not null,
      role text not null default '',
      avatar text not null default '',
      instructions text not null default '',
      model text,
      team text,
      pinned boolean not null default false,
      sort integer not null default 0,
      created_at timestamptz not null default now()
    )`
  // Categories in the sidebar. They exist on their own so an empty one can be kept, renamed and ordered.
  await sql`alter table bots add column if not exists pin_sort integer not null default 0`
  await sql`create table if not exists teams (name text primary key, sort integer not null default 0)`
  const [{ n }] = await sql`select count(*)::int as n from bots`
  if (n === 0) await seedBots()
  await sql`
    insert into teams (name, sort)
    select team, row_number() over (order by min(sort)) + (select coalesce(max(sort), 0) from teams)
    from bots where team is not null group by team
    on conflict do nothing`
  const [first] = await sql`select min(id) as id from bots`
  const firstId = Number(first.id)
  for (const table of ['messages', 'tasks', 'attachments']) {
    await sql.unsafe(`alter table ${table} add column if not exists bot_id bigint references bots(id) on delete cascade`)
    await sql.unsafe(`update ${table} set bot_id = ${firstId} where bot_id is null`)
  }
  await sql`alter table messages add column if not exists from_bot_id bigint references bots(id) on delete set null`
  await sql`create index if not exists messages_bot_idx on messages (bot_id, id)`
  // Notebook and digest became per bot: the first bot inherits the old single-timeline ones.
  await sql`update settings set key = key || ':' || ${firstId} where key in ('digest', 'notes')`
  // Kept for convenience: settings the server needs between requests (e.g. the user's timezone).
  await sql`create table if not exists settings (key text primary key, value jsonb not null)`
}

/** A small starter team, so a fresh install looks like a team of assistants rather than a single chat. */
async function seedBots() {
  const bots = [
    { name: 'Si', role: 'General assistant', avatar: 'dicebear:adventurer:Si-07', team: null, pinned: true,
      instructions: '' },
    { name: 'Researchy', role: 'Deep research', avatar: 'dicebear:adventurer:Researchy-3', team: 'Research', pinned: false,
      instructions: 'You are a meticulous researcher. Search widely with several queries, read primary sources, cross-check claims, and write structured, well-cited answers. Say what is uncertain.' },
    { name: 'News', role: 'AI wire', avatar: 'dicebear:adventurer:News-wire-12', team: 'Research', pinned: false,
      instructions: 'You track news. Always search with recency set, prefer the last 24-72 hours, lead with what changed, give dates and sources for every item, and keep briefs tight.' },
    { name: 'Hank', role: 'Trucking specialist', avatar: 'dicebear:adventurer:Hank-truck-5', team: 'Business', pinned: true,
      instructions: 'You are an expert in road freight and dispatch in Europe (EU, Moldova, Romania): rates per km, lanes, brokers, CMR, permits, cabotage, driving and rest rules, fuel and margins. Be practical and numeric; compute with run_code.' },
    { name: 'Quill', role: 'Writer', avatar: 'dicebear:adventurer:Quill-ink-9', team: 'Business', pinned: false,
      instructions: 'You write: emails, posts, offers, translations (Romanian, Russian, English, French, German). Match the tone asked for, keep it natural and concise, and offer one alternative when wording matters.' },
    { name: 'Nova', role: 'Life assistant', avatar: 'dicebear:adventurer:Nova-life-2', team: null, pinned: false,
      instructions: 'You help with everyday life: plans, reminders, health habits, travel, shopping and decisions. Use create_task for anything with a time. Be warm and brief.' },
  ]
  for (const [i, b] of bots.entries()) {
    await sql`
      insert into bots (name, role, avatar, instructions, team, pinned, sort)
      values (${b.name}, ${b.role}, ${b.avatar}, ${b.instructions}, ${b.team}, ${b.pinned}, ${i})`
  }
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
