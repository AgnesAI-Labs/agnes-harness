import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { DSH_PUBLIC_SLOT_NAMES, DSH_SLOT_CATALOG_VERSION, DSH_SLOT_NAMES, externals } from '@agnes/web-client'
import { build as bundle } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ReadyClientModule } from '../../src/client-modules/reconcile.js'
import { createWebServer, HTML_VIEWER_PATH, type WebServer } from '../../src/serve.js'
import { SKIN_CACHE_VERSION, SKIN_STORAGE_KEY } from '../../src/skin.js'

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
const VIOLATIONS = `window.__violations = []; document.addEventListener('securitypolicyviolation', (event) =>
  window.__violations.push({ violatedDirective: event.violatedDirective, blockedURI: event.blockedURI }))`

// Two author stylesheets set the same border color, so the cascade shows which one applied last.
const CSS = {
  base: '.evidence-fixture { color: var(--agnes-text-primary); border-left: 1px solid rgb(1, 1, 1); }',
  accent: '.evidence-fixture { border-left-color: rgb(2, 2, 2); }',
  // Served under the digest pinned for `accent`; it would paint rgb(3, 3, 3) if the page applied it.
  tampered: '.evidence-fixture { border-left-color: rgb(3, 3, 3); }',
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const sheet = (file: string, pinned: keyof typeof CSS = file as keyof typeof CSS) => ({
  url: `/plugins/fixture/${file}.css`,
  assetDigest: sha256(CSS[pinned]),
})
const fixtureModule = (revision: string, styles: ReturnType<typeof sheet>[]): ReadyClientModule => ({
  packageId: 'fixture-plugin',
  revision,
  entryUrl: '/plugins/fixture/module.js',
  styleUrls: [],
  styles,
  slots: [...DSH_PUBLIC_SLOT_NAMES],
  slotCatalogVersion: DSH_SLOT_CATALOG_VERSION,
  extIds: [],
})
const AUTHOR_STYLES = `(() => {
  const fixtures = [...document.querySelectorAll('#fixture-slots .evidence-fixture')]
  return {
    links: [...document.head.querySelectorAll('link[data-plugin="fixture-plugin"]')].map(
      (link) => new URL(link.href).pathname + ' ' + link.media),
    fixtures: fixtures.length,
    border: [...new Set(fixtures.map((fixture) => getComputedStyle(fixture).borderLeftColor))],
  }
})()`
type AuthorStyles = { links: string[]; fixtures: number; border: string[] }
// Theme, the fixture in each slot outlet, motion tokens, focus and the document selection.
const SHELL = `(() => {
  const selection = getSelection()
  return {
    dark: document.documentElement.classList.contains('dark'),
    background: getComputedStyle(document.body).backgroundColor,
    slots: [...document.querySelectorAll('#fixture-slots > [data-slot]')].map((outlet) =>
      outlet.dataset.slot + ' ' + outlet.dataset.slotState + ' ' + outlet.querySelectorAll('.evidence-fixture').length),
    colors: [...new Set([...document.querySelectorAll('#fixture-slots .evidence-fixture')].map(
      (fixture) => getComputedStyle(fixture).color))],
    transition: getComputedStyle(document.documentElement).getPropertyValue('--transition').trim(),
    motion: getComputedStyle(document.querySelector('.transcript')).transitionDuration,
    focus: document.activeElement?.className,
    selection: [selection.toString(), selection.anchorNode?.parentElement?.className ?? null],
  }
})()`
type Shell = {
  dark: boolean
  background: string
  slots: string[]
  colors: string[]
  transition: string
  motion: string
  focus: string | undefined
  selection: [string, string | null]
}

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
  frameId?: string
  blockedReason?: string
  url: string
  sessionId: string
  targetInfo: { targetId: string }
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

function evaluator(cdp: Cdp, sessionId: string) {
  return async <T>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await cdp.send<{
      result: { value: T }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (exceptionDetails)
      throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
    return result.value
  }
}

/** Polls until `done` holds or five seconds pass, then returns the last value for the assertion. */
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await delay(50)
  }
}

/** One page target kept open across steps, for checks that change media features or page state. */
async function openPage(cdp: Cdp, origin: string) {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: VIOLATIONS }, sessionId)
  const evaluate = evaluator(cdp, sessionId)
  return {
    sessionId,
    evaluate,
    async navigate(path: string): Promise<void> {
      let stop: () => void = () => undefined
      const loaded = new Promise<void>((resolve) => {
        stop = cdp.listen(({ method, sessionId: from }) => {
          if (from === sessionId && method === 'Page.loadEventFired') resolve()
        })
      })
      await cdp.send('Page.navigate', { url: new URL(path, origin).href }, sessionId)
      await loaded
      stop()
    },
    settle: <T>(expression: string, done: (value: T) => boolean): Promise<T> =>
      poll(() => evaluate<T>(expression), done),
    emulate: (features: Record<string, string>) =>
      cdp.send(
        'Emulation.setEmulatedMedia',
        { features: Object.entries(features).map(([name, value]) => ({ name, value })) },
        sessionId,
      ),
    close: () => cdp.send('Target.closeTarget', { targetId }),
  }
}
type Page = Awaited<ReturnType<typeof openPage>>

type FrameRequest = { url: string; frameId: string | undefined; status?: number; failed?: string }

/**
 * A page for embedding viewer frames. It records the requests of every frame inside it, including
 * frames Chrome runs as targets of their own, and its console log. `frameEvaluate` reads a frame
 * from an isolated world, which neither the frame's origin nor its policy restricts.
 */
async function openFramingPage(cdp: Cdp, origin: string) {
  const page = await openPage(cdp, origin)
  const frameSessions = new Map<string, string>()
  const requests = new Map<string, FrameRequest>()
  const log: string[] = []
  const stop = cdp.listen(({ method, params, sessionId: from }) => {
    const frame = [...frameSessions].find(([, session]) => session === from)?.[0]
    if (from !== page.sessionId && !frame) return
    const request = requests.get(params?.requestId)
    switch (method) {
      case 'Target.attachedToTarget':
        frameSessions.set(params.targetInfo.targetId, params.sessionId)
        // The frame starts paused until its requests are recorded. A frame removed meanwhile has
        // nothing left to record.
        cdp
          .send('Network.enable', {}, params.sessionId)
          .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId))
          .catch(() => undefined)
        break
      case 'Network.requestWillBeSent':
        requests.set(params.requestId, { url: params.request.url, frameId: params.frameId ?? frame })
        break
      case 'Network.webSocketCreated':
        requests.set(params.requestId, { url: params.url, frameId: frame })
        break
      case 'Network.responseReceived':
        if (request) request.status = params.response.status
        break
      case 'Network.loadingFailed':
        if (request) request.failed = params.blockedReason ?? params.errorText
        break
      case 'Log.entryAdded':
        log.push(params.entry.text)
    }
  })
  for (const domain of ['Network', 'Log']) await cdp.send(`${domain}.enable`, {}, page.sessionId)
  await cdp.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    page.sessionId,
  )
  type Tree = { frame: { id: string; name?: string }; childFrames?: Tree[] }
  const tree = () =>
    cdp.send<{ frameTree: Tree }>('Page.getFrameTree', {}, page.sessionId).then(({ frameTree }) => frameTree)
  const main = (await tree()).frame.id
  return {
    ...page,
    log,
    /** Requests made by frames inside the page, not by the page itself. */
    frameRequests: () =>
      [...requests.values()].filter((request) => request.frameId !== undefined && request.frameId !== main),
    /** The id of a child frame the page runs in its own process, found by its name. */
    childFrame: async (name: string) =>
      (await tree()).childFrames?.find(({ frame }) => frame.name === name)?.frame.id,
    async frameEvaluate<T>(frameId: string, expression: string): Promise<T> {
      const session = frameSessions.get(frameId) ?? page.sessionId
      const { executionContextId: contextId } = await cdp.send<{ executionContextId: number }>(
        'Page.createIsolatedWorld',
        { frameId },
        session,
      )
      const { result } = await cdp.send<{ result: { value: T } }>(
        'Runtime.evaluate',
        { expression, contextId, returnByValue: true },
        session,
      )
      return result.value
    },
    close: async () => {
      stop()
      await page.close()
    },
  }
}
type FramingPage = Awaited<ReturnType<typeof openFramingPage>>
type FrameState = { loads: number; messages: unknown[] }

const viewerMessage = (html: string) =>
  JSON.stringify({ kind: 'agnes.html-viewer/v1', html, lang: '', colorScheme: 'light', tokens: {} })
// Frames a viewer address as the host does, records the frame's loads and the messages it posts to
// the page, and on its first load posts `html` to it the way the host does.
const addFrame = (name: string, src: string, html?: string) => `(() => {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.dataset.evidence = ${JSON.stringify(name)}
  frame.src = ${JSON.stringify(src)}
  const state = { loads: 0, messages: [] }
  ;(window.__frames ??= {})[${JSON.stringify(name)}] = state
  frame.addEventListener('load', () => {
    if (++state.loads === 1 && ${html !== undefined})
      frame.contentWindow.postMessage(${html === undefined ? 'null' : viewerMessage(html)}, '*')
  })
  addEventListener('message', (event) => {
    if (event.source === frame.contentWindow) state.messages.push(event.data)
  })
  document.body.append(frame)
})()`
const frameState = (name: string) => `window.__frames[${JSON.stringify(name)}]`
const posts = (value: string) => `<script>parent.postMessage(${JSON.stringify(value)}, '*')</script>`
// Content that tries every way out of the frame and reports to the page what happened. A request
// the frame's policy blocks also reports a violation inside the frame, by directive and scheme.
const probe = (daemon: string) => `<form id="form" action="/"></form><script>(async () => {
  const violations = []
  document.addEventListener('securitypolicyviolation', (event) =>
    violations.push(event.effectiveDirective + ' ' + event.blockedURI.split(':')[0]))
  const read = (value) => { try { value(); return 'read' } catch { return 'refused' } }
  const load = (start) => new Promise((resolve) => {
    try { start(() => resolve('loaded'), () => resolve('failed')) } catch { resolve('failed') }
  })
  const report = {
    origin: self.origin,
    cookie: read(() => document.cookie),
    localStorage: read(() => localStorage.length),
    parent: read(() => parent.document.title),
    fetch: await fetch('/').then(() => 'loaded', () => 'failed'),
    xhr: await load((ok, fail) => {
      const request = new XMLHttpRequest()
      request.onload = ok
      request.onerror = fail
      request.open('GET', '/')
      request.send()
    }),
    webSocket: await load((ok, fail) => {
      const socket = new WebSocket(${JSON.stringify(daemon)})
      socket.onopen = ok
      socket.onerror = fail
    }),
    image: await load((ok, fail) => {
      const image = new Image()
      image.onload = ok
      image.onerror = fail
      image.src = '/brand-mark.png'
    }),
    popup: window.open('/') === null ? 'refused' : 'opened',
  }
  document.getElementById('form').submit()
  await new Promise((resolve) => setTimeout(resolve, 100))
  parent.postMessage({ ...report, violations: [...new Set(violations)].sort() }, '*')
})()</script>`

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
  const evaluate = evaluator(cdp, sessionId)
  try {
    for (const domain of ['Page', 'Network', 'Runtime', 'Log'])
      await cdp.send(`${domain}.enable`, {}, sessionId)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: VIOLATIONS }, sessionId)
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
    // The fixture is served like an installed client module: same-origin, platform modules external.
    const fixture = await bundle({
      entryPoints: [resolve(import.meta.dirname, 'fixtures/browser-evidence-plugin.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2023'],
      external: [...externals],
      write: false,
    })
    const assets = new Map([['/plugins/fixture/module.js', fixture.outputFiles[0]?.contents ?? null]])
    for (const [file, text] of Object.entries(CSS))
      assets.set(`/plugins/fixture/${file}.css`, new TextEncoder().encode(text))
    const clientModuleAsset = (path: string) => assets.get(path) ?? null
    // Nothing listens on this port: the pages must render without a daemon.
    const wsUrl = `ws://127.0.0.1:${await availablePort()}`
    for (const build of BUILDS) {
      const port = await availablePort()
      const root = outputs.get(build) ?? ''
      const origin = `http://127.0.0.1:${port}`
      servers.set(build, await createWebServer({ root, wsUrl, port, origin, clientModuleAsset }))
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

  describe('author styles, theme, slots, focus and motion in the web package build', () => {
    let page: Page | undefined
    const fixturePage = (): Page => {
      if (!page) throw new Error('fixture page is not open')
      return page
    }
    type Status = { phase: string; revision?: string; error?: { code: string } }
    const publish = (modules: ReadyClientModule[]) =>
      fixturePage().evaluate<Record<string, Status>>(
        `globalThis.fixtureHost.publish(${JSON.stringify(modules)})`,
      )
    const allFixtures = (state: AuthorStyles) => state.fixtures === DSH_SLOT_NAMES.length

    beforeAll(async () => {
      if (!cdp) throw new Error('browser is not connected')
      page = await openPage(cdp, server('web package build').url)
      await page.navigate('/')
      await page.evaluate(`import('/plugins/fixture/module.js').then(async (fixture) => {
        globalThis.fixtureHost = await fixture.startHost()
      })`)
    }, 60_000)

    afterEach(async () => {
      await publish([])
      await fixturePage().emulate({})
    }, 60_000)

    afterAll(async () => {
      await page?.close()
    })

    it('applies two author stylesheets in declared order and reclaims them with their owner', async () => {
      for (const [revision, order, border] of [
        ['v1', ['base', 'accent'], 'rgb(2, 2, 2)'],
        ['v2', ['accent', 'base'], 'rgb(1, 1, 1)'],
      ] as const) {
        const styles = order.map((file) => sheet(file))
        expect(await publish([fixtureModule(revision, styles)])).toMatchObject({
          'fixture-plugin': { phase: 'active', revision },
        })
        expect(await fixturePage().settle(AUTHOR_STYLES, allFixtures)).toEqual({
          links: order.map((file) => `/plugins/fixture/${file}.css all`),
          fixtures: 63,
          border: [border],
        })
      }
      await publish([])
      // Only the host's own root fixture is left, and no author rule paints it.
      const withdrawn = await fixturePage().settle<AuthorStyles>(
        AUTHOR_STYLES,
        (state) => state.fixtures === 1,
      )
      expect(withdrawn).toMatchObject({ links: [], fixtures: 1 })
      expect(withdrawn.border).not.toContain('rgb(1, 1, 1)')
    }, 60_000)

    it.each(['missing', 'tampered'])(
      'refuses a %s stylesheet and keeps the active generation',
      async (file) => {
        await publish([fixtureModule('v1', [sheet('base'), sheet('accent')])])
        const active = await fixturePage().settle(AUTHOR_STYLES, allFixtures)
        expect(active).toMatchObject({ fixtures: 63, border: ['rgb(2, 2, 2)'] })

        const candidate = fixtureModule('v2', [sheet('base'), sheet(file, 'accent')])
        expect(await publish([candidate])).toMatchObject({
          'fixture-plugin': {
            phase: 'failed',
            revision: 'v1',
            error: { code: 'CLIENT_MODULE_STYLES_FAILED' },
          },
        })
        expect(await fixturePage().evaluate(AUTHOR_STYLES)).toEqual(active)
      },
      60_000,
    )

    it('keeps every slot themed and the page focus and selection across theme, motion and style changes', async () => {
      const target = fixturePage()
      await target.emulate({ 'prefers-color-scheme': 'light', 'prefers-reduced-motion': 'no-preference' })
      await publish([fixtureModule('v1', [sheet('base'), sheet('accent')])])
      // Without a daemon the composer stays disabled, so focus a shell control and select heading text.
      await target.settle<boolean>(`!!document.querySelector('.empty-state-heading')?.firstChild`, Boolean)
      await target.evaluate(`(() => {
        document.querySelector('.sidebar-toggle').focus()
        const text = document.querySelector('.empty-state-heading').firstChild
        getSelection().setBaseAndExtent(text, 0, text, 5)
      })()`)
      const ready = DSH_SLOT_NAMES.map((name) => `${name} ready 1`)
      const kept = { focus: 'icon-button sidebar-toggle', selection: ['Agnes', 'empty-state-heading'] }

      const light = await target.settle<Shell>(SHELL, (state) => state.slots.join() === ready.join())
      expect(ready).toHaveLength(63)
      expect(light).toMatchObject({
        dark: false,
        slots: ready,
        transition: '170ms ease-out',
        motion: '0.17s',
        ...kept,
      })
      expect(light.colors).toHaveLength(1)

      await target.emulate({ 'prefers-color-scheme': 'dark', 'prefers-reduced-motion': 'reduce' })
      const dark = await target.settle<Shell>(SHELL, (state) => state.dark)
      expect(dark).toMatchObject({ dark: true, slots: ready, transition: '0ms', motion: '0s', ...kept })
      expect(dark.colors).toHaveLength(1)
      expect(dark.colors).not.toEqual(light.colors)
      expect(dark.background).not.toBe(light.background)

      await publish([fixtureModule('v2', [sheet('accent'), sheet('base')])])
      expect(await target.settle<Shell>(SHELL, (state) => state.slots.join() === ready.join())).toMatchObject(
        kept,
      )
      expect(await target.evaluate('window.__violations')).toEqual([])
    }, 60_000)

    it('applies the selected cached skin inside the page policy and repaints its tokens with the theme', async () => {
      if (!cdp) throw new Error('browser is not connected')
      const skinPage = await openPage(cdp, server('web package build').url)
      const skin = {
        version: SKIN_CACHE_VERSION,
        id: 'fixture-skin',
        revision: 'r1',
        css: ':root { --fixture-skin-sheet: applied; }',
        tokens: { '--fixture-skin-token': { light: 'rgb(1, 2, 3)', dark: 'rgb(4, 5, 6)' } },
      }
      const SKIN = `(() => {
        const root = getComputedStyle(document.documentElement)
        return [root.getPropertyValue('--fixture-skin-sheet').trim(), root.getPropertyValue('--fixture-skin-token').trim()]
      })()`
      try {
        await skinPage.emulate({ 'prefers-color-scheme': 'light' })
        await skinPage.navigate('/')
        await skinPage.evaluate(
          `localStorage.setItem(${JSON.stringify(SKIN_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(skin))})`,
        )
        await skinPage.navigate('/')
        expect(await skinPage.evaluate(SKIN)).toEqual(['applied', 'rgb(1, 2, 3)'])
        await skinPage.emulate({ 'prefers-color-scheme': 'dark' })
        expect(await skinPage.settle<string[]>(SKIN, ([, token]) => token !== 'rgb(1, 2, 3)')).toEqual([
          'applied',
          'rgb(4, 5, 6)',
        ])
        expect(await skinPage.evaluate('window.__violations')).toEqual([])
        // The one-shot override selects the built-in look over the cached choice.
        await skinPage.navigate('/?skin=none')
        expect(await skinPage.evaluate(SKIN)).toEqual(['', ''])
      } finally {
        await skinPage.evaluate('localStorage.clear()')
        await skinPage.close()
      }
    }, 60_000)
  })

  // Each check opens its own page, so the violations the viewer's own policy reports by design
  // never reach the page checks above.
  describe.each(BUILDS)('sandboxed HTML viewer served with the %s', (build) => {
    let page: FramingPage | undefined
    let other: Server | undefined
    let otherOrigin = ''
    const framing = (): FramingPage => {
      if (!page) throw new Error('framing page is not open')
      return page
    }
    const viewer = (scripts: 0 | 1) => `${server(build).url}${HTML_VIEWER_PATH}?scripts=${scripts}`
    const probeReport = async (target: FramingPage) => {
      const daemon = await target.evaluate<string>(`document.getElementById('agnes-config').dataset.ws`)
      await target.evaluate(addFrame('probe', viewer(1), probe(daemon)))
      return target.settle<FrameState>(frameState('probe'), (state) => state.messages.length > 0)
    }

    beforeAll(async () => {
      // A page of another origin with no policy of its own.
      other = createHttpServer((_request, response) => response.end('<!doctype html><title>other</title>'))
      await new Promise<void>((resolve) => other?.listen(0, '127.0.0.1', resolve))
      const address = other.address()
      if (!address || typeof address === 'string') throw new Error('other origin did not bind')
      otherOrigin = `http://127.0.0.1:${address.port}`
    })

    afterAll(async () => {
      // Chrome is still running here and keeps its connections to this page open; close() alone waits for them.
      other?.closeAllConnections()
      await new Promise((resolve) => other?.close(resolve))
    })

    beforeEach(async () => {
      if (!cdp) throw new Error('browser is not connected')
      page = await openFramingPage(cdp, server(build).url)
    }, 60_000)

    afterEach(async () => {
      await page?.close()
      page = undefined
    }, 60_000)

    it('gives content scripts an opaque origin with no cookie, storage, parent, network, popup or form', async () => {
      const target = framing()
      await target.navigate('/')
      const { messages } = await probeReport(target)
      expect(messages).toEqual([
        {
          origin: 'null',
          cookie: 'refused',
          localStorage: 'refused',
          parent: 'refused',
          fetch: 'failed',
          xhr: 'failed',
          webSocket: 'failed',
          image: 'failed',
          popup: 'refused',
          violations: ['connect-src http', 'connect-src ws', 'img-src http'],
        },
      ])
      // The form submitted before the report: it would have loaded the frame a second time.
      await delay(300)
      expect(await target.evaluate<FrameState>(frameState('probe'))).toMatchObject({ loads: 1 })
      // Everything the frame asked for besides the viewer document was blocked before it left.
      expect(target.frameRequests().filter((request) => !request.failed)).toEqual([
        expect.objectContaining({ url: viewer(1), status: 200 }),
      ])
    }, 60_000)

    it('runs no content script or inline handler in the scriptless variant', async () => {
      const target = framing()
      await target.navigate('/')
      const content = `<p id="inert">inert</p>${posts('script')}<img src="data:," onerror="parent.postMessage('handler', '*')">`
      await target.evaluate(addFrame('inert', viewer(0), content))
      await target.settle<FrameState>(frameState('inert'), (state) => state.loads > 0)
      const frameId = target.frameRequests().find((request) => request.url === viewer(0))?.frameId
      if (!frameId) throw new Error('the viewer frame was not requested')
      // The content is in place, so its script and handler had their chance to run. A read that
      // races the frame's move into its own process is retried.
      expect(
        await poll(
          () =>
            target
              .frameEvaluate<string | null>(frameId, `document.getElementById('inert')?.textContent ?? null`)
              .catch(() => null),
          (text) => text === 'inert',
        ),
      ).toBe('inert')
      await delay(500)
      expect(await target.evaluate<FrameState>(frameState('inert'))).toEqual({ loads: 1, messages: [] })
    }, 60_000)

    it('stays in an opaque origin and ignores messages when opened as a top-level page', async () => {
      const target = framing()
      await target.navigate(viewer(1))
      const opened = await target.evaluate(`new Promise((resolve) => {
        postMessage(${viewerMessage('<p id="content">content</p>')}, '*')
        setTimeout(() => resolve({ origin: self.origin, content: document.getElementById('content') !== null }), 300)
      })`)
      expect(opened).toEqual({ origin: 'null', content: false })
    }, 60_000)

    it('refuses to be framed by a page of another origin', async () => {
      const target = framing()
      await target.navigate(`${otherOrigin}/`)
      await target.evaluate(addFrame('foreign', viewer(1), posts('framed')))
      await target.settle<FrameState>(frameState('foreign'), (state) => state.loads > 0)
      await delay(500)
      expect(await target.evaluate<FrameState>(frameState('foreign'))).toEqual({ loads: 1, messages: [] })
      expect(target.frameRequests().find((request) => request.url === viewer(1))?.failed).toEqual(
        expect.any(String),
      )
      expect(target.log.filter((text) => text.includes(`"frame-ancestors 'self'"`))).toHaveLength(1)
    }, 60_000)

    it('ignores content from a sibling frame and accepts only the first message of the embedding page', async () => {
      const target = framing()
      await target.navigate('/')
      await target.evaluate(addFrame('viewer', viewer(1)))
      await target.settle<FrameState>(frameState('viewer'), (state) => state.loads > 0)
      expect(
        await target.evaluate(
          `frames[0] === document.querySelector('[data-evidence="viewer"]').contentWindow`,
        ),
      ).toBe(true)
      // A sibling of the page's own origin: the right origin from the wrong window.
      await target.evaluate(
        `document.body.append(Object.assign(document.createElement('iframe'), { name: 'sibling' }))`,
      )
      const sibling = await poll(() => target.childFrame('sibling'), Boolean)
      if (!sibling) throw new Error('the sibling frame did not attach')
      await target.frameEvaluate(
        sibling,
        `parent.frames[0].postMessage(${viewerMessage(posts('same-origin sibling'))}, '*')`,
      )
      // A sandboxed sibling: the wrong window and an opaque origin.
      const offer = viewerMessage(posts('opaque sibling')).replaceAll('</', '<\\/')
      await target.evaluate(
        addFrame(
          'opaque',
          viewer(1),
          `<script>parent.frames[0].postMessage(${offer}, '*')</script>${posts('sent')}`,
        ),
      )
      await target.settle<FrameState>(frameState('opaque'), (state) => state.messages.length > 0)
      await delay(500)
      expect(await target.evaluate<FrameState>(frameState('viewer'))).toEqual({ loads: 1, messages: [] })
      for (const content of ['page', 'page again'])
        await target.evaluate(
          `document.querySelector('[data-evidence="viewer"]').contentWindow.postMessage(${viewerMessage(posts(content))}, '*')`,
        )
      await target.settle<FrameState>(frameState('viewer'), (state) => state.messages.length > 0)
      await delay(500)
      expect(await target.evaluate<FrameState>(frameState('viewer'))).toEqual({
        loads: 1,
        messages: ['page'],
      })
    }, 60_000)

    it('removes a frame its content navigates away and shows a notice in its place', async () => {
      const target = framing()
      await target.navigate('/')
      const request = {
        html: `<script>location.href = ${JSON.stringify(`${otherOrigin}/away`)}</script>`,
        title: 'Navigating content',
        height: 240,
        scripts: true,
      }
      await target.evaluate(`import('/plugins/fixture/module.js').then((fixture) => fixture.mountHtmlViewer({
        request: ${JSON.stringify(request)},
        viewerUrl: ${JSON.stringify(HTML_VIEWER_PATH)},
        allowScripts: true,
        onNavigatedAway: () => { window.__navigatedAway = (window.__navigatedAway ?? 0) + 1 },
      }))`)
      const HOST = `(() => {
        const host = document.getElementById('viewer-host')
        const notice = host.querySelector('[data-html-viewer-refused]')
        return {
          frames: host.querySelectorAll('iframe').length,
          notice: notice ? [notice.getAttribute('role'), notice.dataset.htmlViewerRefused] : null,
          reports: window.__navigatedAway ?? 0,
        }
      })()`
      expect(await target.settle<{ notice: unknown }>(HOST, ({ notice }) => notice !== null)).toEqual({
        frames: 0,
        notice: ['alert', 'navigated'],
        reports: 1,
      })
    }, 60_000)

    it('keeps the page policy and keeps the frame policy violations out of the page', async () => {
      const policy = (await fetch(new URL('/', server(build).url))).headers.get('content-security-policy')
      expect(policy?.split('; ').filter((directive) => /^(?:frame|img)-src /.test(directive))).toEqual([
        "img-src 'self' blob:",
        "frame-src 'self' blob:",
      ])
      const target = framing()
      await target.navigate('/')
      const { messages } = await probeReport(target)
      expect(messages).toEqual([
        expect.objectContaining({ violations: expect.arrayContaining(['img-src http']) }),
      ])
      expect(await target.evaluate('window.__violations')).toEqual([])
    }, 60_000)
  })

  it.todo('renders a fixture plugin component under the host assistant-ui Provider')
})
