import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from '../../src/serve.js'

const web = resolve(import.meta.dirname, '../..')
const buildLocal = pathToFileURL(resolve(web, '../cli/tools/build-local.ts')).href
const BUILDS = ['web package build', 'local CLI build'] as const
type Build = (typeof BUILDS)[number]
const PAGES = ['/', '/admin/plugins', '/admin/resources']
const CSP = /Content[- ]Security[- ]Policy/i
// No daemon or admin backend runs, so XHR, Fetch, WebSocket and EventSource calls fail by design;
// only the static resources a page needs to render are checked.
const STATIC = new Set(['Document', 'Script', 'Stylesheet', 'Image', 'Font'])
// The local CLI build emits no source maps. Unminified esbuild output keys every bundled CommonJS
// module by its package path, so this path marks React's core module in both builds. It is the
// module that owns the hooks dispatcher; a second copy is what breaks hooks across bundles. A
// minified build drops the path and fails this check closed rather than passing it.
const REACT_CORE = /node_modules\/react\/cjs\/react\.(?:development|production)\b/

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  if (process.platform === 'darwin') {
    const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    return existsSync(app) ? app : undefined
  }
  if (process.platform !== 'linux') return undefined
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/bin']
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'])
    for (const dir of dirs) if (existsSync(join(dir, name))) return join(dir, name)
  return undefined
}
const chrome = findChrome()

async function availablePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener did not bind')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

// CDP event payloads are untyped JSON; each field below is present only for the methods that read it.
type Params = {
  requestId: string
  type: string
  request: { url: string }
  response: { status: number }
  errorText: string
  args: { value?: unknown; description?: string }[]
  exceptionDetails: { text: string; exception?: { description?: string } }
  entry: { text: string }
}
type Message = {
  id?: number
  method?: string
  sessionId?: string
  params: Params
  result?: unknown
  error?: { message: string }
}

async function connect(url: string) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error(`cannot connect to ${url}`))
  })
  let next = 0
  const pending = new Map<number, (message: Partial<Message>) => void>()
  const listeners = new Set<(message: Message) => void>()
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Message
    if (message.id === undefined) for (const listener of listeners) listener(message)
    else pending.get(message.id)?.(message)
  }
  socket.onclose = () => {
    for (const settle of pending.values()) settle({ error: { message: 'browser connection closed' } })
  }
  return {
    send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
      return new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, (message) => {
          pending.delete(id)
          if (message.error) reject(new Error(`${method}: ${message.error.message}`))
          else resolve(message.result as T)
        })
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      })
    },
    listen(listener: (message: Message) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => socket.close(),
  }
}
type Cdp = Awaited<ReturnType<typeof connect>>

type Visit = {
  imports: Record<string, string>
  requested: string[]
  problems: string[]
  messages: string[]
  violations: unknown[]
  importFailures: string[]
}

async function visit(cdp: Cdp, url: string): Promise<Visit> {
  const html = await (await fetch(url)).text()
  const imports = (
    JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? '{}') as {
      imports?: Record<string, string>
    }
  ).imports
  if (!imports) throw new Error(`${url} has no import map`)
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  const requests = new Map<string, { url: string; type: string; status?: number; failed?: string }>()
  const open = new Set<string>()
  const messages: string[] = []
  let loaded = false
  let activity = Date.now()
  const stop = cdp.listen(({ method, params, sessionId: from }) => {
    if (from !== sessionId) return
    const request = requests.get(params?.requestId)
    switch (method) {
      case 'Network.requestWillBeSent':
        activity = Date.now()
        requests.set(params.requestId, { url: params.request.url, type: params.type })
        // An event stream stays open by design and would hold the quiet window forever.
        if (params.type !== 'EventSource') open.add(params.requestId)
        break
      case 'Network.responseReceived':
        if (request) request.status = params.response.status
        break
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        activity = Date.now()
        open.delete(params.requestId)
        if (request && method === 'Network.loadingFailed') request.failed = params.errorText
        break
      case 'Page.loadEventFired':
        loaded = true
        break
      case 'Runtime.consoleAPICalled':
        messages.push(params.args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' '))
        break
      case 'Runtime.exceptionThrown':
        messages.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text)
        break
      case 'Log.entryAdded':
        messages.push(params.entry.text)
    }
  })
  // Settled once the load event has fired and no request has started or finished for 500 ms.
  const quiet = async (): Promise<void> => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !(loaded && open.size === 0 && Date.now() - activity >= 500))
      await delay(50)
  }
  const evaluate = async <T>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await cdp.send<{
      result: { value: T }
      exceptionDetails?: { text: string }
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.text}`)
    return result.value
  }
  try {
    for (const domain of ['Page', 'Network', 'Runtime', 'Log'])
      await cdp.send(`${domain}.enable`, {}, sessionId)
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `window.__violations = []; document.addEventListener('securitypolicyviolation', (event) =>
          window.__violations.push({ violatedDirective: event.violatedDirective, blockedURI: event.blockedURI }))`,
      },
      sessionId,
    )
    const { errorText } = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sessionId)
    if (errorText) throw new Error(`${url}: ${errorText}`)
    await quiet()
    // Load every import-map entry, not only the ones this page's own bundle happens to import.
    const specifiers = JSON.stringify(Object.keys(imports))
    const importFailures = await evaluate<string[]>(
      `Promise.allSettled(${specifiers}.map((specifier) => import(specifier))).then((results) =>
        results.flatMap((result, index) => result.status === 'rejected' ? [${specifiers}[index] + ': ' + result.reason] : []))`,
    )
    await quiet()
    const violations = await evaluate<unknown[]>('window.__violations')
    // A request still open after the bounded quiet window counts as unfinished, not as loaded.
    const problems = [...requests]
      .filter(
        ([id, { type, status, failed }]) =>
          STATIC.has(type) && (failed || open.has(id) || (status ?? 600) >= 400),
      )
      .map(
        ([id, { type, status, failed, url }]) =>
          `${type} ${failed ?? (open.has(id) ? 'unfinished' : status)} ${url}`,
      )
    const requested = [...requests.values()].map((request) => request.url)
    return { imports, requested, problems, messages, violations, importFailures }
  } finally {
    stop()
    await cdp.send('Target.closeTarget', { targetId })
  }
}

describe.skipIf(process.platform === 'win32' || !chrome)('release Web builds in headless Chrome', () => {
  const outputs = new Map<Build, string>()
  const servers = new Map<Build, WebServer>()
  const visits = new Map<string, Promise<Visit>>()
  let browser: ChildProcess | undefined
  let profile: string | undefined
  let cdp: Cdp | undefined

  const server = (build: Build): WebServer => {
    const found = servers.get(build)
    if (!found) throw new Error(`${build} is not being served`)
    return found
  }
  const visited = (build: Build, page: string): Promise<Visit> => {
    const key = `${build} ${page}`
    if (!cdp) throw new Error('browser is not connected')
    const result = visits.get(key) ?? visit(cdp, new URL(page, server(build).url).href)
    visits.set(key, result)
    return result
  }

  beforeAll(async () => {
    for (const build of BUILDS) outputs.set(build, await mkdtemp(join(tmpdir(), 'agnes-browser-evidence-')))
    const run = (args: string[]) =>
      execFileSync(process.execPath, ['--import', 'tsx', ...args], { cwd: web, stdio: 'pipe' })
    run(['tools/build.ts', '--output-dir', outputs.get('web package build') ?? ''])
    run([
      '--input-type=module',
      '-e',
      `import { buildLocalWeb } from ${JSON.stringify(buildLocal)}; await buildLocalWeb(process.argv[1])`,
      outputs.get('local CLI build') ?? '',
    ])
    // Nothing listens on this port: the pages must render without a daemon.
    const wsUrl = `ws://127.0.0.1:${await availablePort()}`
    for (const build of BUILDS) {
      const port = await availablePort()
      const root = outputs.get(build) ?? ''
      servers.set(build, await createWebServer({ root, wsUrl, port, origin: `http://127.0.0.1:${port}` }))
    }

    profile = await mkdtemp(join(tmpdir(), 'agnes-browser-profile-'))
    const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`]
    args.push('--no-first-run', '--no-default-browser-check')
    // Hosted Ubuntu runners restrict the unprivileged user namespaces Chrome's sandbox needs.
    if (process.platform === 'linux') args.push('--no-sandbox')
    browser = spawn(chrome ?? '', [...args, 'about:blank'], { stdio: 'ignore' })
    const deadline = Date.now() + 30_000
    for (;;) {
      const [port, path] = (
        await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')
      ).split('\n')
      if (port && path) {
        cdp = await connect(`ws://127.0.0.1:${port}${path}`)
        break
      }
      if (Date.now() > deadline || browser.exitCode !== null) throw new Error('Chrome did not open DevTools')
      await delay(100)
    }
  }, 180_000)

  afterAll(async () => {
    cdp?.close()
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise((resolve) => browser?.once('exit', resolve))
      browser.kill()
      await Promise.race([exited, delay(10_000).then(() => browser?.kill('SIGKILL'))])
    }
    await Promise.all([...servers.values()].map((running) => running.close()))
    for (const dir of [profile, ...outputs.values()])
      if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }, 60_000)

  describe.each(BUILDS)('%s', (build) => {
    it('emits React core into exactly one vendor file', async () => {
      const root = outputs.get(build) ?? ''
      const carriers: string[] = []
      for (const file of await readdir(root, { recursive: true }))
        if (file.endsWith('.js') && REACT_CORE.test(await readFile(join(root, file), 'utf8')))
          carriers.push(file)
      expect(carriers).toHaveLength(1)
      expect(carriers[0]).toMatch(/^vendor\//)
    }, 60_000)

    describe.each(PAGES)('page %s', (page) => {
      it('reports no Content Security Policy violation', async () => {
        const { violations, messages } = await visited(build, page)
        expect(violations).toEqual([])
        expect(messages.filter((text) => CSP.test(text))).toEqual([])
      }, 60_000)

      it('loads every static resource', async () => {
        expect((await visited(build, page)).problems).toEqual([])
      }, 60_000)

      it('requests each import-map vendor entry exactly once', async () => {
        const { imports, requested, importFailures } = await visited(build, page)
        const targets = Object.values(imports).map((target) => new URL(target, server(build).url).href)
        expect(targets).toHaveLength(8)
        expect(importFailures).toEqual([])
        const counts = targets.map((target) => [target, requested.filter((url) => url === target).length])
        expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(targets.map((target) => [target, 1])))
      }, 60_000)
    })
  })

  it.todo('renders a fixture plugin component under the host assistant-ui Provider')
})
