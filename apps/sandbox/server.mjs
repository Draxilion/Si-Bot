// Si-Bot code sandbox: runs untrusted Python or JavaScript for the core server.
// Runs on an internal Docker network with no internet access, as an unprivileged user,
// with a fresh working directory, a time limit and an output cap per run.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 30_000)
const MAX_OUTPUT = 20_000
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** Images the code saved in its working directory (charts, plots), returned base64-encoded. */
async function collectImages(dir) {
  const images = []
  for (const name of (await readdir(dir)).sort()) {
    const type = IMAGE_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()]
    if (!type || images.length >= MAX_IMAGES) continue
    const path = join(dir, name)
    if ((await stat(path)).size > MAX_IMAGE_BYTES) continue
    images.push({ name, mediaType: type, base64: (await readFile(path)).toString('base64') })
  }
  return images
}
const RUNTIMES = {
  python: { file: 'main.py', cmd: 'python3', args: ['-u', 'main.py'] },
  javascript: { file: 'main.mjs', cmd: 'node', args: ['main.mjs'] },
}

async function run(language, code) {
  const rt = RUNTIMES[language]
  if (!rt) throw new Error(`Unsupported language: ${language}`)
  const dir = await mkdtemp(join(tmpdir(), 'run-'))
  try {
    await writeFile(join(dir, rt.file), code)
    return await new Promise((resolve) => {
      const child = spawn(rt.cmd, rt.args, {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, MPLBACKEND: 'Agg' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      child.stdout.on('data', (d) => (stdout = (stdout + d).slice(0, MAX_OUTPUT)))
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(0, MAX_OUTPUT)))
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, TIMEOUT_MS)
      child.on('close', async (exitCode) => {
        clearTimeout(timer)
        const images = await collectImages(dir).catch(() => [])
        resolve({ stdout, stderr, exitCode, timedOut, images })
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

http
  .createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok')
    if (req.method !== 'POST' || req.url !== '/run') {
      res.writeHead(404)
      return res.end()
    }
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { language, code } = JSON.parse(body)
      const result = await run(language, String(code ?? ''))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })
  .listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log('sandbox listening on :8080'))
