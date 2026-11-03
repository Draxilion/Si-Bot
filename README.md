# Si-Bot

A self-hosted, persistent AI assistant with a native app. One assistant, one continuous timeline, long-term memory, and a server that keeps working while the app is closed. Bring your own models: Claude, OpenAI, OpenRouter (Grok, Gemini, DeepSeek and more) or local models through Ollama.

## What works today

- **One persistent timeline** in Postgres: no sessions, no "new chat". Edit your last message, regenerate the last reply, stop mid-answer (the partial reply is kept)
- **Models**: Anthropic, OpenAI, OpenRouter, OpenCode Go, Ollama. OpenCode Go and Ollama models are discovered at boot, so every model your key can use shows up (Grok 4.7, Kimi K3, Qwen 3.8, DeepSeek V4, GLM 5.3, Gemini…). `FALLBACK_MODEL` answers when the chosen model fails before replying
- **Think**: reasoning streams live into a collapsible "Thinking" panel, on every provider that exposes it
- **DeepSearch**: multi-round research across many sources with a structured, cited report
- **Tools with live steps**: parallel web search with a recency filter (self-hosted SearXNG, or Brave), reading pages and PDFs, a sandbox for Python (numpy, pandas, matplotlib, scipy, sympy) and JavaScript. Charts the code saves show up in the answer
- **Sources** under every web answer, and **follow-up suggestions** after each reply
- **Files**: attach images (sent to vision models), PDFs and text/code files by picker, paste or drag and drop
- **Tasks**: reminders and recurring jobs ("every weekday at 8, brief me on the news"). Si runs them on the server with all its tools and posts results into the timeline; the app shows a desktop notification
- **Never-ending context**: no sessions and no dependence on the model's context window. Each prompt is built in layers: Si's own **notebook** of ongoing projects and open loops, a **rolling digest** of everything older than the recent window (updated in the background as messages age out), relevance-ranked **facts**, automatic **recall** of older moments, and the newest messages verbatim up to `CONTEXT_TOKENS`. Notebook and digest are readable and editable in the app
- **Memory**: facts extracted after each exchange and injected into every prompt (viewable and editable in the app), plus recall over the whole timeline by keyword and by meaning (pgvector), and `remember` / `recall_memory` tools
- **App**: bright Grok-style UI (Tauri 2 + React) with dark mode, math (KaTeX), syntax highlighting with copy buttons, read aloud, dictation, and a phone layout

Next up: image generation, MCP, voice mode and subscription bridges (Claude Code, Codex, opencode). See the plan doc for the full roadmap.

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
| `GET /api/messages?after=<id>` | Newer messages (the app polls this for task results) |
| `DELETE /api/messages/:id` | Delete one message |
| `POST /api/chat` | `{content, model?, think?, deep?, timezone?, attachments?, replaceFrom?, regenerate?}`, streams server-sent events |
| `POST /api/files`, `GET /api/files/:id` | Upload (multipart `file`, 20 MB max) and fetch attachments |
| `GET/POST /api/tasks`, `PATCH/DELETE /api/tasks/:id`, `POST /api/tasks/:id/run` | Scheduled tasks |
| `GET/POST /api/memory`, `DELETE /api/memory/:id` | Long-term facts |
| `GET/PUT /api/context` | Si's notebook and the timeline digest |
| `GET /api/search?q=` | Search the whole timeline |
