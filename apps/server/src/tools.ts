import { tool } from 'ai'
import { z } from 'zod'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { extractText, getDocumentProxy } from 'unpdf'
import { saveAttachment } from './attachments.js'

const env = process.env
const MAX_PAGE_CHARS = 20_000

export interface SearchHit {
  title: string
  url: string
  snippet: string
  date?: string
}

type Recency = 'day' | 'week' | 'month' | 'year'

async function searxng(query: string, recency?: Recency): Promise<SearchHit[]> {
  const url = new URL('/search', env.SEARXNG_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  if (recency) url.searchParams.set('time_range', recency)
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`SearXNG returned ${res.status}`)
  const data: any = await res.json()
  return (data.results ?? []).slice(0, 8).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? '',
    ...(r.publishedDate ? { date: String(r.publishedDate).slice(0, 10) } : {}),
  }))
}

async function brave(query: string, recency?: Recency): Promise<SearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', '8')
  if (recency) url.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[recency])
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': env.BRAVE_API_KEY!, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Brave Search returned ${res.status}`)
  const data: any = await res.json()
  return (data.web?.results ?? []).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? '',
    ...(r.page_age ? { date: String(r.page_age).slice(0, 10) } : {}),
  }))
}

/** Runs several queries in parallel and merges the hits, dropping duplicate URLs. */
export async function search(queries: string[], recency?: Recency): Promise<SearchHit[]> {
  const engine = env.BRAVE_API_KEY ? brave : searxng
  const settled = await Promise.allSettled(queries.map((q) => engine(q, recency)))
  const failures = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  if (failures.length === settled.length) throw failures[0].reason
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  // Interleave so each query's best results come first.
  const lists = settled.map((r) => (r.status === 'fulfilled' ? r.value.slice(0, 6) : []))
  for (let i = 0; i < 6; i++) {
    for (const list of lists) {
      const h = list[i]
      if (!h) continue
      const key = h.url.replace(/[#?].*$/, '').replace(/\/$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(h)
    }
  }
  return hits
}

/** Fetches a page and returns its readable text (article extraction, falling back to body text). */
export async function readPage(url: string): Promise<{ title: string; url: string; text: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; SiBot/0.1)', accept: 'text/html,text/plain,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('pdf') || /\.pdf($|\?)/i.test(res.url)) {
    const text = await pdfText(new Uint8Array(await res.arrayBuffer()))
    return { title: res.url.split('/').pop() || url, url: res.url, text: text.slice(0, MAX_PAGE_CHARS) }
  }
  const raw = await res.text()
  if (!type.includes('html')) return { title: url, url: res.url, text: raw.slice(0, MAX_PAGE_CHARS) }

  const { document } = parseHTML(raw)
  const article = new Readability(document as any).parse()
  const text = (article?.textContent ?? document.body?.textContent ?? '').replace(/\n\s*\n\s*/g, '\n\n').trim()
  return { title: article?.title ?? document.title ?? url, url: res.url, text: text.slice(0, MAX_PAGE_CHARS) }
}

/** Plain text of a PDF, pages separated by blank lines. */
export async function pdfText(data: Uint8Array): Promise<string> {
  // pdf.js transfers (detaches) the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(data.slice())
  const { text } = await extractText(pdf, { mergePages: false })
  return (text as string[]).map((t, i) => `[page ${i + 1}]\n${t.trim()}`).join('\n\n')
}

async function runCode(language: 'python' | 'javascript', code: string, botId?: number) {
  const res = await fetch(new URL('/run', env.SANDBOX_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language, code }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Sandbox returned ${res.status}`)
  const out = (await res.json()) as {
    stdout: string
    stderr: string
    exitCode: number | null
    timedOut: boolean
    images?: { name: string; mediaType: string; base64: string }[]
  }
  // Charts and other images the code saved are stored as files; the model gets markdown it can show in its answer.
  const images = []
  for (const img of out.images ?? []) {
    const meta = await saveAttachment(img.name, img.mediaType, new Uint8Array(Buffer.from(img.base64, 'base64')), botId)
    images.push({ file: img.name, markdown: `![${img.name}](attachment:${meta.id})` })
  }
  const { images: _drop, ...rest } = out
  return images.length ? { ...rest, images } : rest
}

/** Tools available to the assistant; each is enabled only when its backing service is configured. */
export function buildTools(botId?: number) {
  const tools: Record<string, any> = {}

  if (env.SEARXNG_URL || env.BRAVE_API_KEY) {
    tools.web_search = tool({
      description:
        'Search the web for current information, news, facts you are unsure of, or anything after your training cutoff. ' +
        'Pass up to 4 differently-worded queries at once; they run in parallel. Returns titles, URLs, snippets and ' +
        'dates when known. Follow up with read_page on the best results.',
      inputSchema: z.object({
        queries: z.array(z.string()).min(1).max(4).describe('Search queries, as you would type them into a search engine'),
        recency: z
          .enum(['day', 'week', 'month', 'year'])
          .optional()
          .describe('Only results from this period. Use for news and anything time-sensitive.'),
      }),
      execute: async ({ queries, recency }) => ({ results: await search(queries.slice(0, 4), recency) }),
    })
  }

  tools.read_page = tool({
    description:
      'Fetch web pages, PDFs or text files and return their readable text. Pass up to 4 URLs at once; they load in parallel.',
    inputSchema: z.object({ urls: z.array(z.string().url()).min(1).max(4) }),
    execute: async ({ urls }) => {
      const settled = await Promise.allSettled(urls.slice(0, 4).map((u) => readPage(u)))
      const pages = settled.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { url: urls[i], error: String((r.reason as Error)?.message ?? r.reason) },
      )
      // Share the character budget across pages so several sources fit in context.
      const budget = Math.floor(MAX_PAGE_CHARS * 1.5 / pages.length)
      return { pages: pages.map((p: any) => (p.text ? { ...p, text: p.text.slice(0, budget) } : p)) }
    },
  })

  if (env.SANDBOX_URL) {
    tools.run_code = tool({
      description:
        'Run Python or JavaScript in an isolated sandbox with no internet access and return stdout and stderr. ' +
        'Use it for math, data analysis, parsing and checking code. Print what you need to see. Python has numpy, pandas ' +
        'and matplotlib: for a chart, save it with plt.savefig("chart.png", dpi=150, bbox_inches="tight"), then put the ' +
        'returned markdown image in your answer so the user sees it.',
      inputSchema: z.object({
        language: z.enum(['python', 'javascript']),
        code: z.string(),
      }),
      execute: async ({ language, code }) => runCode(language, code, botId),
    })
  }

  return tools
}

/** One-line description of a tool call, shown in the app. */
export function describeCall(name: string, input: any): string {
  if (name === 'web_search') {
    const qs: string[] = input?.queries ?? (input?.query ? [input.query] : [])
    return `Searched the web for ${qs.map((q) => `"${q}"`).join(', ')}`
  }
  if (name === 'read_page') {
    const urls: string[] = input?.urls ?? (input?.url ? [input.url] : [])
    const hosts = urls.map((u) => {
      try {
        return new URL(u).hostname.replace(/^www\./, '')
      } catch {
        return 'a page'
      }
    })
    return hosts.length ? `Read ${hosts.join(', ')}` : 'Read a page'
  }
  if (name === 'create_task') return `Scheduled "${input?.title ?? 'a task'}"`
  if (name === 'list_tasks') return 'Checked scheduled tasks'
  if (name === 'update_notes') return 'Updated its notebook'
  if (name === 'message_bot') return `Messaged ${input?.bot ?? 'a bot'}`
  if (name === 'cancel_task') return 'Cancelled a scheduled task'
  if (name === 'remember') return `Remembered: ${input?.fact ?? ''}`
  if (name === 'recall_memory') return `Searched memory for "${input?.query ?? ''}"`
  if (name === 'run_code') return `Ran ${input?.language === 'javascript' ? 'JavaScript' : 'Python'}`
  return `Used ${name}`
}
