import { tool } from 'ai'
import { z } from 'zod'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'

const env = process.env
const MAX_PAGE_CHARS = 20_000

interface SearchHit {
  title: string
  url: string
  snippet: string
}

async function searxng(query: string): Promise<SearchHit[]> {
  const url = new URL('/search', env.SEARXNG_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`SearXNG returned ${res.status}`)
  const data: any = await res.json()
  return (data.results ?? []).slice(0, 8).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }))
}

async function brave(query: string): Promise<SearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', '8')
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': env.BRAVE_API_KEY!, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Brave Search returned ${res.status}`)
  const data: any = await res.json()
  return (data.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description ?? '' }))
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
  const raw = await res.text()
  if (!type.includes('html')) return { title: url, url: res.url, text: raw.slice(0, MAX_PAGE_CHARS) }

  const { document } = parseHTML(raw)
  const article = new Readability(document as any).parse()
  const text = (article?.textContent ?? document.body?.textContent ?? '').replace(/\n\s*\n\s*/g, '\n\n').trim()
  return { title: article?.title ?? document.title ?? url, url: res.url, text: text.slice(0, MAX_PAGE_CHARS) }
}

async function runCode(language: 'python' | 'javascript', code: string) {
  const res = await fetch(new URL('/run', env.SANDBOX_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language, code }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Sandbox returned ${res.status}`)
  return res.json() as Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>
}

/** Tools available to the assistant; each is enabled only when its backing service is configured. */
export function buildTools() {
  const tools: Record<string, any> = {}

  if (env.SEARXNG_URL || env.BRAVE_API_KEY) {
    tools.web_search = tool({
      description:
        'Search the web for current information, news, facts you are unsure of, or anything after your training cutoff. ' +
        'Returns titles, URLs and snippets. Follow up with read_page for details.',
      inputSchema: z.object({ query: z.string().describe('Search query, as you would type it into a search engine') }),
      execute: async ({ query }) => ({ results: env.BRAVE_API_KEY ? await brave(query) : await searxng(query) }),
    })
  }

  tools.read_page = tool({
    description: 'Fetch a web page or text file by URL and return its readable text.',
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => readPage(url),
  })

  if (env.SANDBOX_URL) {
    tools.run_code = tool({
      description:
        'Run Python or JavaScript in an isolated sandbox with no internet access and return stdout and stderr. ' +
        'Use it for math, data analysis, parsing and checking code. Print what you need to see. Python has numpy and pandas.',
      inputSchema: z.object({
        language: z.enum(['python', 'javascript']),
        code: z.string(),
      }),
      execute: async ({ language, code }) => runCode(language, code),
    })
  }

  return tools
}

/** One-line description of a tool call, shown in the app. */
export function describeCall(name: string, input: any): string {
  if (name === 'web_search') return `Searched the web for "${input?.query ?? ''}"`
  if (name === 'read_page') {
    try {
      return `Read ${new URL(input?.url).hostname}`
    } catch {
      return 'Read a page'
    }
  }
  if (name === 'run_code') return `Ran ${input?.language === 'javascript' ? 'JavaScript' : 'Python'}`
  return `Used ${name}`
}
