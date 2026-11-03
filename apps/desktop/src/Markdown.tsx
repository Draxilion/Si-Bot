import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'
import { Icon } from './icons'

// Images Si makes (charts from run_code) are referenced as attachment:<id>; the app knows how to fetch them.
let resolveFile: (id: number) => string = (id) => `/api/files/${id}`
export function setFileResolver(fn: (id: number) => string) {
  resolveFile = fn
}

function urlTransform(url: string) {
  return url.startsWith('attachment:') ? url : defaultUrlTransform(url)
}

/** Text content of a rendered node tree, used to copy code blocks. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node as any).props.children)
  return ''
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="icon-btn"
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      {done ? Icon.check : Icon.copy}
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  )
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const child: any = Array.isArray(children) ? children[0] : children
  const cls: string = child?.props?.className ?? ''
  const lang = cls.match(/language-([\w+#-]+)/)?.[1]
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang ?? 'text'}</span>
        <CopyButton text={textOf(children).replace(/\n$/, '')} label="Copy" />
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/**
 * remark-math only understands dollar delimiters, and single dollars are off so prices like "$5 and $10" stay text.
 * Models also write \( \) and \[ \]: those become inline $$..$$ and display blocks.
 */
function normalizeMath(md: string) {
  return md
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$$${m.trim()}$$`)
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      urlTransform={urlTransform}
      remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      components={{
        a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
        img: ({ node: _n, src, alt }) => {
          const m = typeof src === 'string' ? src.match(/^attachment:(\d+)$/) : null
          const url = m ? resolveFile(Number(m[1])) : src
          return (
            <a href={url as string} target="_blank" rel="noreferrer" className="md-image">
              <img src={url as string} alt={alt ?? ''} loading="lazy" />
            </a>
          )
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ node: _n, ...p }) => (
          <div className="table-wrap">
            <table {...p} />
          </div>
        ),
      }}
    >
      {normalizeMath(text)}
    </ReactMarkdown>
  )
})
