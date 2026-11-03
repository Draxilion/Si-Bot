# Si-Bot

A self-hosted, persistent AI assistant with a native app. One assistant, one continuous timeline, long-term memory, and a server that keeps working while the app is closed. Bring your own models: Claude, OpenAI, OpenRouter (Grok, Gemini, DeepSeek and more) or local models through Ollama.

## What works today (Phase 1, in progress)

- Streaming chat on one persistent timeline, stored in Postgres
- Providers by API key: Anthropic, OpenAI, OpenRouter, OpenCode Go, Ollama (plus any model via `EXTRA_MODELS`)
- Think mode (extended reasoning on Claude and OpenAI)
- Tools with live steps in the app: web search (self-hosted SearXNG, or Brave with `BRAVE_API_KEY`), reading web pages, and a code sandbox for Python (numpy, pandas, matplotlib) and JavaScript
- Memory: facts extracted after each exchange and injected into every prompt (viewable and editable in the app), plus recall over the whole timeline. Each message Si gets pulls in relevant older moments by keyword and by meaning (pgvector), and Si has `remember` and `recall_memory` tools
- Bright desktop UI (Tauri 2 + React), dark mode follows the system
- Docker Compose for local and VPS, with automatic HTTPS via Caddy

Next up: agents, scheduled tasks, MCP and subscription bridges (Claude Code, Codex, opencode). See the plan doc for the full roadmap.

## Layout

```
apps/server     Core server: Hono + Vercel AI SDK + Postgres
apps/sandbox    Code runner on an internal network with no internet access
apps/desktop    Native app: Tauri 2 + React + Vite
packages/shared Types shared by both
```

## Run locally

Requirements: Node 22+, pnpm 10, Docker. For the native window you also need Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
cp .env.example .env          # set SIBOT_TOKEN (openssl rand -hex 32) and at least one API key
docker compose up -d --build  # Postgres, SearXNG, sandbox and core server on http://localhost:8787
pnpm tauri dev                # opens the Si app
```

Open Settings in the app, enter `http://localhost:8787` and your `SIBOT_TOKEN`.

No Rust yet? `pnpm dev:desktop` serves the same UI at http://localhost:1420 in your browser.

Developing the server without Docker: start the services (`docker compose up -d postgres searxng sandbox`) and run `pnpm dev:server`. Tools are switched on by `SEARXNG_URL` and `SANDBOX_URL`; the sandbox is only reachable from inside compose, so set `SANDBOX_URL` only when the server runs there.

## Deploy to a VPS

1. Point a domain (for example `si.yourdomain.com`) at the VPS.
2. Clone the repo, `cp .env.example .env`, set `SIBOT_TOKEN`, your API keys, a strong `POSTGRES_PASSWORD` and `DOMAIN`.
3. `docker compose --profile vps up -d --build`
4. In the app's Settings, use `https://si.yourdomain.com` and your token.

Caddy fetches the TLS certificate automatically. Back up with `docker compose exec postgres pg_dump -U sibot sibot > backup.sql`.

## API

All `/api/*` routes need `Authorization: Bearer $SIBOT_TOKEN`.

| Route | Purpose |
| --- | --- |
| `GET /api/models` | Configured models and the default |
| `GET /api/messages?before=<id>` | The timeline, 100 at a time |
| `POST /api/chat` | `{content, model?, think?}`, streams server-sent events |
| `GET/POST /api/memory`, `DELETE /api/memory/:id` | Long-term facts |
