// Opt-in real-browser acceptance for the Web incremental projection: bounded opening, event-driven
// patches, streamed previews, reconnect/restart renegotiation, trace panel and earlier-history paging.
//
// Environment:
//   AGNES_PLAYWRIGHT_MODULE   installed playwright entry (required; the script skips without it)
//   AGNES_LOCAL_CLI           built local command (default packages/cli/dist/local/agnes.mjs)
//   AGNES_WEB_ARTIFACTS       directory for screenshots and results.json
//   AGNES_PROJECTION_TURNS    turns in the seeded long session (default 500)
//   AGNES_PROJECTION_RECORD_ONLY=1  record numbers without failing on assertions (for older trees)
//
// Run with `node --import tsx tools/acceptance/web-incremental-projection.mjs`.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = resolve(process.env.AGNES_LOCAL_CLI ?? 'packages/cli/dist/local/agnes.mjs')
const modulePath = process.env.AGNES_PLAYWRIGHT_MODULE
if (!modulePath) {
  console.log('SKIP real browser acceptance: AGNES_PLAYWRIGHT_MODULE is not configured')
  process.exit(0)
}
const recordOnly = process.env.AGNES_PROJECTION_RECORD_ONLY === '1'
const TURNS = Number(process.env.AGNES_PROJECTION_TURNS ?? 500)
const CHILDREN = 20
const playwright = await import(pathToFileURL(modulePath).href)
const { chromium } = playwright
const { createClient, memoryJournal } = await import('../../packages/sdk/src/index.node.ts')
const { createPrivateDirectorySync } = await import('../../packages/system-node/src/index.ts')
const { startProjectionProvider } = await import('./projection-provider.ts')

const M = {
  opening: '_agnes/v1/session.projectUIOpening',
  patch: '_agnes/v1/session.projectUIPatch',
  history: '_agnes/v1/session.projectUIHistory',
  full: '_agnes/v1/session.projectUI',
  event: '_agnes/v1/session.event',
  preview: '_agnes/v1/session.preview',
  update: 'session/update',
}

const root = await mkdtemp(join(tmpdir(), 'agh-wip-'))
const home = join(root, 'h')
const cwd = join(root, 'w')
createPrivateDirectorySync(home)
await mkdir(cwd)
await mkdir(join(home, 'profiles', 'local-dev'), { recursive: true, mode: 0o700 })
await writeFile(
  join(home, 'profiles', 'local-dev', 'profile.yaml'),
  `name: local-dev\npolicy:\n  capabilityCeiling: [tools, hooks, slots, events, resources, ui, network, tools.invoke, artifacts, subagent]\n`,
)
const childFiles = []
for (let index = 0; index < 600; index++) {
  const name = `f${String(index).padStart(3, '0')}.txt`
  childFiles.push(name)
  await writeFile(join(cwd, name), `fixture file ${index}\n`)
}

/** A loopback port outside the ones other local tools commonly hold. */
async function freePort() {
  const reserved = new Set([4177, 4190, 4191, 4192, 4193, 4194])
  for (;;) {
    const probe = createServer()
    await new Promise((done) => probe.listen(0, '127.0.0.1', done))
    const port = probe.address().port
    await new Promise((done) => probe.close(done))
    if (!reserved.has(port)) return port
  }
}
const port = await freePort()
const origin = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  HOME: home,
  AGH_HOME: home,
  AGNES_PROFILE: 'local-dev',
  AGNES_WEB_ORIGIN: origin,
}
const ownerPath = join(home, 'data', 'daemon', 'owner.json')
const artifacts = resolve(process.env.AGNES_WEB_ARTIFACTS ?? join(tmpdir(), 'agnes-web-projection-artifacts'))
await mkdir(artifacts, { recursive: true })

const command = (args) =>
  new Promise((done, reject) => {
    const child = execFile(
      process.execPath,
      [entry, ...args],
      { cwd, env, timeout: 45000 },
      (error, stdout) => (error ? reject(new Error(`CLI ${args[0]} failed`)) : done(stdout)),
    )
    child.stdin.end()
  })

let web
async function launchWeb() {
  web = spawn(process.execPath, [entry, 'serve'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  return await new Promise((done, reject) => {
    let output = ''
    let errors = ''
    web.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    const timer = setTimeout(() => reject(new Error('Web readiness timeout')), 60000)
    web.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`Web exited before ready: ${errors.slice(0, 400)}`))
    })
    web.stdout.on('data', (chunk) => {
      output += String(chunk)
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\S*/)
      if (match) {
        clearTimeout(timer)
        done(match[0])
      }
    })
  })
}
async function stopWeb() {
  if (!web || web.exitCode !== null || web.signalCode !== null) return
  await new Promise((done) => {
    const child = web
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
    child.kill('SIGTERM')
  })
}
async function connectSdk() {
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
  for (let attempt = 0; attempt < 100 && !existsSync(owner.socketPath); attempt++)
    await new Promise((done) => setTimeout(done, 100))
  return {
    owner,
    client: createClient({
      transport: { kind: 'unix', path: owner.socketPath },
      auth: { kind: 'local' },
      journal: memoryJournal(),
    }),
  }
}

// ---- results -------------------------------------------------------------------------------------
const results = {
  steps: {},
  performance: {},
  seeding: {},
  environment: {},
  checks: [],
  failures: [],
  notes: [],
}
const step = (name, data) => {
  results.steps[name] = { ...(results.steps[name] ?? {}), ...data }
}
/** Hard assertion, or a recorded miss when running record-only against an older tree. */
function check(name, condition, detail) {
  const entry = { name, pass: Boolean(condition), ...(detail === undefined ? {} : { detail }) }
  results.checks.push(entry)
  console.log(
    `${entry.pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`,
  )
  if (!entry.pass) {
    results.failures.push(entry)
    if (!recordOnly) throw new assert.AssertionError({ message: `${name} ${JSON.stringify(detail ?? {})}` })
  }
}
const quantile = (values, q) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
}
const round = (value) => (value === null || value === undefined ? value : Math.round(value * 10) / 10)

// ---- frame log: only the JSON-RPC method and byte size are kept, never frame bodies -------------------
const frames = []
let socketCount = 0
function watchSocket(socket) {
  const index = ++socketCount
  const pending = new Map()
  const record = (direction, payload) => {
    const text = typeof payload === 'string' ? payload : payload.toString('utf8')
    const bytes = Buffer.byteLength(text)
    let messages
    try {
      const parsed = JSON.parse(text)
      messages = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      frames.push({ at: Date.now(), socket: index, direction, method: '(non-json)', bytes, response: false })
      return
    }
    for (const message of messages) {
      let method = typeof message?.method === 'string' ? message.method : undefined
      const response = method === undefined && message?.id !== undefined
      if (method && message.id !== undefined && direction === 'sent') pending.set(message.id, method)
      if (response) {
        method = pending.get(message.id) ?? '(unknown)'
        pending.delete(message.id)
      }
      frames.push({ at: Date.now(), socket: index, direction, method: method ?? '(none)', bytes, response })
    }
  }
  socket.on('framesent', ({ payload }) => record('sent', payload))
  socket.on('framereceived', ({ payload }) => record('received', payload))
}
const mark = () => frames.length
const slice = (from, to = frames.length) => frames.slice(from, to)
const sent = (list, method) =>
  list.filter((f) => f.direction === 'sent' && !f.response && f.method === method)
const notes = (list, method) =>
  list.filter((f) => f.direction === 'received' && !f.response && f.method === method)
const replies = (list, method) =>
  list.filter((f) => f.direction === 'received' && f.response && f.method === method)
const bytesOf = (list) => list.reduce((sum, f) => sum + f.bytes, 0)
/** Groups arrivals the way the engine's 50 ms leading/trailing debounce can at most split them. */
function windows50(list) {
  let count = 0
  let start = -Infinity
  for (const frame of list) {
    if (frame.at - start > 50) {
      count++
      start = frame.at
    }
  }
  return count
}
/**
 * Splits patch requests into those preceded by at least one new ledger event since the previous
 * patch request (a dirty signal) and the rest, which only an explicit page refresh can explain.
 */
function patchCauses(list) {
  let dirty = false
  let eventDriven = 0
  let other = 0
  for (const frame of list) {
    if (frame.direction === 'received' && !frame.response && frame.method === M.event) dirty = true
    if (frame.direction === 'sent' && !frame.response && frame.method === M.patch) {
      if (dirty) eventDriven++
      else other++
      dirty = false
    }
  }
  return { eventDriven, other }
}
function rpcSummary(list) {
  const methods = {}
  for (const frame of list) {
    const key = `${frame.direction === 'sent' ? '→' : '←'} ${frame.method}${frame.response ? ' (reply)' : ''}`
    methods[key] ??= { count: 0, bytes: 0 }
    methods[key].count++
    methods[key].bytes += frame.bytes
  }
  return methods
}
async function settle(page, quietMs = 1200, maxMs = 20000) {
  const started = Date.now()
  let seen = frames.length
  let quietSince = Date.now()
  while (Date.now() - started < maxMs) {
    await page.waitForTimeout(150)
    if (frames.length !== seen) {
      seen = frames.length
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= quietMs) return
  }
}

// In-page instrumentation: long tasks, transcript mutation times and arrival times of previews/events.
const instrument = () => {
  const acc = { longtasks: [], mutations: [], messages: [], frames: [], sampling: false }
  window.__projectionAcceptance = acc
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) acc.longtasks.push([entry.startTime, entry.duration])
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    acc.longtaskUnsupported = true
  }
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args)
      this.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        const head = event.data.slice(0, 200)
        if (head.includes('"method":"_agnes/v1/session.preview"')) acc.messages.push([performance.now(), 'p'])
        else if (head.includes('"method":"_agnes/v1/session.event"'))
          acc.messages.push([performance.now(), 'e'])
      })
    }
  }
  const frame = () => {
    if (acc.sampling) acc.frames.push(performance.now())
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  const observe = () => {
    const target = document.querySelector('#transcript')
    if (!target) {
      setTimeout(observe, 50)
      return
    }
    new MutationObserver(() => acc.mutations.push(performance.now())).observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe)
  else observe()
}
const perfWindow = async (page, from, to) =>
  page.evaluate(
    ([start, end]) => {
      const acc = window.__projectionAcceptance
      const within = (t) => t >= start && t <= end
      const longtasks = acc.longtasks.filter(([t]) => within(t))
      const mutations = acc.mutations.filter(within)
      const messages = acc.messages.filter(([t]) => within(t))
      const frames = acc.frames.filter(within)
      const latency = (kind) => {
        const out = []
        let m = 0
        for (const [t, k] of messages) {
          if (k !== kind) continue
          while (m < mutations.length && mutations[m] < t) m++
          if (m < mutations.length) out.push(mutations[m] - t)
        }
        return out
      }
      const gaps = (list) => list.slice(1).map((t, i) => t - list[i])
      return {
        durationMs: end - start,
        longtaskCount: longtasks.length,
        longtaskTotalMs: longtasks.reduce((s, [, d]) => s + d, 0),
        mutationCallbacks: mutations.length,
        mutationGaps: gaps(mutations),
        frameGaps: gaps(frames),
        previewLatency: latency('p'),
        eventLatency: latency('e'),
        previews: messages.filter(([, k]) => k === 'p').length,
        events: messages.filter(([, k]) => k === 'e').length,
        longtaskUnsupported: acc.longtaskUnsupported === true,
      }
    },
    [from, to],
  )
const summarizePerf = (raw) => ({
  durationMs: round(raw.durationMs),
  longtasks: { count: raw.longtaskCount, totalMs: round(raw.longtaskTotalMs) },
  mainThreadLongtaskShare: raw.durationMs > 0 ? round((raw.longtaskTotalMs / raw.durationMs) * 100) : null,
  repaint: {
    mutationCallbacks: raw.mutationCallbacks,
    medianGapMs: round(quantile(raw.mutationGaps, 0.5)),
    p90GapMs: round(quantile(raw.mutationGaps, 0.9)),
  },
  animationFrames: {
    count: raw.frameGaps.length + (raw.frameGaps.length ? 1 : 0),
    medianGapMs: round(quantile(raw.frameGaps, 0.5)),
    p90GapMs: round(quantile(raw.frameGaps, 0.9)),
    over50ms: raw.frameGaps.filter((g) => g > 50).length,
  },
  previewToScreenMs: {
    samples: raw.previewLatency.length,
    median: round(quantile(raw.previewLatency, 0.5)),
    p90: round(quantile(raw.previewLatency, 0.9)),
  },
  eventToScreenMs: {
    samples: raw.eventLatency.length,
    median: round(quantile(raw.eventLatency, 0.5)),
    p90: round(quantile(raw.eventLatency, 0.9)),
  },
  previews: raw.previews,
  events: raw.events,
  ...(raw.longtaskUnsupported ? { longtaskUnsupported: true } : {}),
})

/**
 * Runs one acceptance step. A thrown error ends the run, except in record-only mode, where the
 * error is recorded against the step and the remaining steps still run.
 */
async function stepBlock(name, body) {
  currentStep = name
  try {
    await body()
  } catch (error) {
    if (!recordOnly) throw error
    step(name, {
      error: String(error?.message ?? error)
        .split('\n')[0]
        .slice(0, 300),
    })
    results.failures.push({ name: `${name} did not complete`, pass: false })
    console.log(`FAIL ${name} did not complete`)
  }
}
// ---- run -----------------------------------------------------------------------------------------
const provider = await startProjectionProvider({ childFiles, bigChildFanOut: 50, bigChildRounds: 12 })
let browser
let sdk
const consoleErrors = []
const pageErrors = []
let currentStep = 'setup'
/** Errors grouped by step and by their first line, so a repeated warning shows once with a count. */
const groupErrors = (list) => {
  const groups = {}
  for (const { step, text } of list) {
    const key = `${step} | ${text.split('\n')[0].slice(0, 160)}`
    groups[key] = (groups[key] ?? 0) + 1
  }
  return groups
}
try {
  const launch = await launchWeb()
  sdk = await connectSdk()
  const firstGeneration = sdk.owner.generation
  const client = sdk.client
  const snapshot = await client.config.get()
  const verification = await client.config.test({
    providerId: 'deepseek',
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  })
  check('loopback provider verifies', verification.verified === true)
  const model = verification.models?.[0]?.id ?? provider.model
  await client.config.save({
    providerId: 'deepseek',
    baseUrl: provider.baseUrl,
    model,
    apiKey: provider.apiKey,
    expectedRevision: snapshot.revision,
  })
  await client.workspace.add(cwd)

  // Seed: the long session, then a short one to switch to.
  const seedStarted = Date.now()
  const long = await client.session.new({ cwd })
  const spawnEvery = Math.max(1, Math.floor(TURNS / CHILDREN))
  const bigAt = Math.max(1, TURNS - 8)
  const plan = { plain: 0, read: 0, spawnSmall: 0, spawnBig: 0 }
  const reasons = {}
  for (let turn = 1; turn <= TURNS; turn++) {
    let prompt
    if (turn === bigAt) {
      prompt = `PJ_SPAWN_BIG ${turn}`
      plan.spawnBig++
    } else if (turn % spawnEvery === 3 && plan.spawnSmall < CHILDREN - 1) {
      prompt = `PJ_SPAWN_SMALL ${turn}`
      plan.spawnSmall++
    } else if (turn % 10 === 7) {
      prompt = `PJ_READ ${turn}`
      plan.read++
    } else {
      prompt = `PJ_PLAIN ${turn}`
      plan.plain++
    }
    const result = await long.prompt(prompt)
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1
    if (turn % 100 === 0) console.log(`seeded ${turn}/${TURNS} turns`)
  }
  const other = await client.session.new({ cwd })
  for (let turn = 1; turn <= 5; turn++) await other.prompt(`PJ_PLAIN ${9000 + turn}`)
  const seeded = await long.projectUI(undefined, { surface: 'web' })
  const walk = (span) => [span, ...span.children.flatMap(walk)]
  const spans = seeded.turns.flatMap((turn) => (turn.trace ? walk(turn.trace) : []))
  const subagentSpans = spans.filter((span) => span.kind === 'subagent')
  const failedSpawns = seeded.nodes.filter(
    (node) => node.kind === 'tool' && node.name === 'subagent_spawn' && node.status === 'failed',
  )
  results.seeding = {
    turns: TURNS,
    plan,
    turnEndReasons: reasons,
    seconds: round((Date.now() - seedStarted) / 1000),
    fullProjection: {
      nodes: seeded.nodes.length,
      turns: seeded.turns.length,
      bytes: Buffer.byteLength(JSON.stringify(seeded)),
    },
    subagentSpans: subagentSpans.length,
    subagentSpansWithChild: subagentSpans.filter((span) => span.childSessionKey).length,
    embeddedChildSpans: subagentSpans.reduce((sum, span) => sum + walk(span).length - 1, 0),
    failedSpawnToolNodes: failedSpawns.length,
    failedSpawnResult: failedSpawns[0]?.resultPreview,
    providerCompletions: provider.completions,
  }
  console.log('SEEDED', JSON.stringify(results.seeding))

  browser = await chromium.launch({ headless: true })
  results.environment = {
    platform: `${platform()} ${release()} ${arch()}`,
    cpu: `${cpus()[0]?.model} x${cpus().length}`,
    memoryGiB: round(totalmem() / 2 ** 30),
    // Other load on the machine skews every timing below; recorded at browser start and at the end.
    loadAverageAtStart: loadavg().map(round),
    node: process.version,
    chromium: browser.version(),
    playwright: JSON.parse(await readFile(join(dirname(modulePath), 'package.json'), 'utf8')).version,
    recordOnly,
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(instrument)
  const page = await context.newPage()
  let socketRoute
  let dropConnections = false
  await page.routeWebSocket('**/*', (route) => {
    if (dropConnections) {
      void route.close({ code: 1012, reason: 'controlled transport interruption' })
      return
    }
    socketRoute = route
    route.connectToServer()
  })
  page.on('websocket', watchSocket)
  page.on('pageerror', (error) => pageErrors.push({ step: currentStep, text: error.message.slice(0, 300) }))
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ step: currentStep, text: message.text().slice(0, 300) })
  })
  const connection = () => page.locator('#connection').getAttribute('data-state')
  const statusText = () => page.locator('#status').innerText()
  const terminal = (text = '已完成') =>
    page.waitForFunction((label) => document.querySelector('#status')?.textContent === label, text, {
      timeout: 120000,
    })
  const send = async (text) => {
    await page.locator('#prompt').fill(text)
    await page.locator('#send').click()
  }
  const sessionUrl = (base, id) => {
    const url = new URL(base)
    url.searchParams.set('session', id)
    return url.href
  }
  const lastAssistantText = () =>
    page.evaluate(() => {
      const nodes = document.querySelectorAll('#transcript article.timeline-node.assistant .node-body')
      return nodes[nodes.length - 1]?.textContent ?? ''
    })

  let from = 0
  let list = []
  // 1. Open the long session.
  await stepBlock('1-open', async () => {
    from = mark()
    const openStarted = Date.now()
    await page.goto(sessionUrl(launch, long.id))
    await page.waitForFunction(() => document.querySelector('#connection')?.dataset.state === 'connected')
    await page.waitForFunction(
      (text) => document.querySelector('#transcript')?.textContent.includes(text),
      `Answer ${TURNS}:`,
      { timeout: 60000 },
    )
    const firstPaintMs = Date.now() - openStarted
    await settle(page)
    list = slice(from)
    const opening = replies(list, M.opening)
    step('1-open', {
      openings: sent(list, M.opening).length,
      fullProjectUI: sent(list, M.full).length,
      patches: sent(list, M.patch).length,
      historyPages: sent(list, M.history).length,
      openingReplyBytes: bytesOf(opening),
      acpSessionUpdates: { count: notes(list, M.update).length, bytes: bytesOf(notes(list, M.update)) },
      eventNotifications: notes(list, M.event).length,
      firstPaintMs,
      renderedNodes: await page.locator('#transcript article.timeline-node').count(),
      earlierButtonVisible: await page.locator('.transcript-earlier:not([hidden])').count(),
      rpc: rpcSummary(list),
    })
    await page.screenshot({ path: join(artifacts, '01-open-long.png'), animations: 'disabled' })
    check('1 opening exactly once', results.steps['1-open'].openings === 1, results.steps['1-open'].openings)
    check('1 session.projectUI never called', results.steps['1-open'].fullProjectUI === 0)
    check('1 no history replay on the event stream', results.steps['1-open'].eventNotifications === 0)
  })

  // 2. A new turn with a tool and an approval.
  await stepBlock('2-tool-approval', async () => {
    from = mark()
    const completionsBefore = provider.completions
    const perfStart2 = await page.evaluate(() => performance.now())
    await send('PJ_APPROVAL step two')
    await page.locator('#approval:not([hidden]) button').first().waitFor({ timeout: 60000 })
    await page.screenshot({ path: join(artifacts, '02-approval.png'), animations: 'disabled' })
    await page.locator('#approval button').first().click()
    await terminal()
    await page.waitForFunction(() =>
      document.querySelector('#transcript')?.textContent.includes('Approved command returned'),
    )
    await settle(page)
    const perfEnd2 = await page.evaluate(() => performance.now())
    list = slice(from)
    const events2 = notes(list, M.event)
    const segments2 = provider.completions - completionsBefore
    const patches2 = sent(list, M.patch).length
    // The page asks for one patch after the approval decision and one when the prompt call returns.
    const refreshes2 = 2
    step('2-tool-approval', {
      patches: patches2,
      eventNotifications: events2.length,
      eventBatches50ms: windows50(events2),
      streamSegments: segments2,
      refreshAllowance: refreshes2,
      reopenings: sent(list, M.opening).length,
      fullProjectUI: sent(list, M.full).length,
      patchReplyBytes: bytesOf(replies(list, M.patch)),
      toolCards: await page.locator('#transcript article.timeline-node.tool').count(),
      performance: summarizePerf(await perfWindow(page, perfStart2, perfEnd2)),
      rpc: rpcSummary(list),
    })
    await page.screenshot({ path: join(artifacts, '02-tool-approval-done.png'), animations: 'disabled' })
    const causes2 = patchCauses(list)
    step('2-tool-approval', { patchCauses: causes2 })
    check(
      '2 patches <= batches + stream segments (+ page refreshes)',
      patches2 <= windows50(events2) + segments2 + refreshes2,
      {
        patches: patches2,
        batches: windows50(events2),
        segments: segments2,
        refreshes: refreshes2,
      },
    )
    check('2 every patch follows new events or a page refresh', causes2.other <= refreshes2, causes2)
    check('2 no reopen', results.steps['2-tool-approval'].reopenings === 0)
    check('2 session.projectUI never called', results.steps['2-tool-approval'].fullProjectUI === 0)
  })

  // 3. A long stream (about 300 KB in 100-byte pieces).
  await stepBlock('3-long-stream', async () => {
    from = mark()
    const streamBytes = 300_000
    await page.evaluate(() => {
      window.__projectionAcceptance.sampling = true
    })
    const perfStart3 = await page.evaluate(() => performance.now())
    const streamStarted = Date.now()
    await send(`PJ_LONG bytes=${streamBytes} piece=100 delay=2`)
    const samples = []
    let midShot = false
    for (;;) {
      const status = await statusText()
      const text = await lastAssistantText()
      samples.push({ at: Date.now() - streamStarted, length: text.length })
      if (!midShot && text.length > 60_000) {
        midShot = true
        await page.screenshot({ path: join(artifacts, '03-long-stream-mid.png'), animations: 'disabled' })
      }
      if (status === '已完成' && text.includes('LONG_STREAM_END')) break
      if (Date.now() - streamStarted > 180_000) throw new Error('long stream did not finish')
      await page.waitForTimeout(250)
    }
    const streamDoneMs = Date.now() - streamStarted
    const perfEnd3 = await page.evaluate(() => performance.now())
    await page.evaluate(() => {
      window.__projectionAcceptance.sampling = false
    })
    await settle(page)
    list = slice(from)
    const lengths = samples.map((s) => s.length)
    const distinct = new Set(lengths.filter((l) => l > 0 && !Number.isNaN(l))).size
    const monotonic = lengths.every((l, i) => i === 0 || l >= lengths[i - 1])
    const events3 = notes(list, M.event)
    const patches3 = sent(list, M.patch).length
    const record3 = provider.streams.at(-1)
    step('3-long-stream', {
      providerBytes: record3?.bytes,
      providerPieces: record3?.pieces,
      providerStreamMs: record3?.endedAt ? record3.endedAt - record3.startedAt : undefined,
      wallMsUntilRendered: streamDoneMs,
      patches: patches3,
      eventNotifications: events3.length,
      eventBatches50ms: windows50(events3),
      previewNotifications: { count: notes(list, M.preview).length, bytes: bytesOf(notes(list, M.preview)) },
      keepAlivePatchesExpected: 0,
      reopenings: sent(list, M.opening).length,
      fullProjectUI: sent(list, M.full).length,
      progressiveSamples: samples.length,
      distinctVisibleLengths: distinct,
      monotonic,
      finalVisibleChars: lengths.at(-1),
      performance: summarizePerf(await perfWindow(page, perfStart3, perfEnd3)),
      rpc: rpcSummary(list),
    })
    await page.screenshot({ path: join(artifacts, '03-long-stream-done.png'), animations: 'disabled' })
    check('3 no reopen during the long stream', results.steps['3-long-stream'].reopenings === 0)
    check('3 session.projectUI never called', results.steps['3-long-stream'].fullProjectUI === 0)
    // Streamed text travels as previews, not ledger rows, so every patch here is due to a ledger event.
    const causes3 = patchCauses(list)
    step('3-long-stream', { patchCauses: causes3 })
    check('3 every patch follows new events or the prompt refresh', causes3.other <= 1, causes3)
    // The prompt refresh is the only non-event patch; each 50 ms burst of events may be split once more
    // by the leading/trailing debounce.
    check('3 patches stay within event batches', patches3 <= 2 * windows50(events3) + 1, {
      patches: patches3,
      batches: windows50(events3),
    })
    check('3 text renders progressively', distinct >= 5 && monotonic, { distinct, monotonic })
  })

  // 4. Switch to another session and back.
  await stepBlock('4-switch', async () => {
    from = mark()
    await page.locator(`button.session[data-session="${other.id}"]`).click()
    await page.waitForFunction(
      () => document.querySelector('#transcript')?.textContent.includes('Answer 9005:'),
      undefined,
      { timeout: 30000 },
    )
    await settle(page)
    const away = slice(from)
    const back = mark()
    await page.locator(`button.session[data-session="${long.id}"]`).click()
    await page.waitForFunction(
      () => document.querySelector('#transcript')?.textContent.includes('LONG_STREAM_END'),
      undefined,
      { timeout: 30000 },
    )
    await settle(page)
    list = slice(back)
    step('4-switch', {
      away: {
        openings: sent(away, M.opening).length,
        fullProjectUI: sent(away, M.full).length,
        patches: sent(away, M.patch).length,
        eventNotifications: notes(away, M.event).length,
      },
      back: {
        openings: sent(list, M.opening).length,
        fullProjectUI: sent(list, M.full).length,
        patches: sent(list, M.patch).length,
        eventNotifications: notes(list, M.event).length,
        openingReplyBytes: bytesOf(replies(list, M.opening)),
        acpSessionUpdates: { count: notes(list, M.update).length, bytes: bytesOf(notes(list, M.update)) },
      },
    })
    await page.screenshot({ path: join(artifacts, '04-switched-back.png'), animations: 'disabled' })
    check(
      '4 one opening per switch',
      sent(away, M.opening).length === 1 && sent(list, M.opening).length === 1,
    )
    check('4 session.projectUI never called', sent(away, M.full).length + sent(list, M.full).length === 0)
  })

  // 5. Reload.
  await stepBlock('5-reload', async () => {
    from = mark()
    const socketsBeforeReload = socketCount
    await page.reload()
    await page.waitForFunction(() => document.querySelector('#connection')?.dataset.state === 'connected')
    await page.waitForFunction(
      () => document.querySelector('#transcript')?.textContent.includes('LONG_STREAM_END'),
      undefined,
      {
        timeout: 60000,
      },
    )
    await settle(page)
    list = slice(from).filter((f) => f.socket > socketsBeforeReload)
    const firstOpening5 = list.findIndex((f) => f.direction === 'sent' && f.method === M.opening)
    step('5-reload', {
      openings: sent(list, M.opening).length,
      fullProjectUI: sent(list, M.full).length,
      patchesBeforeOpening: sent(list.slice(0, Math.max(firstOpening5, 0)), M.patch).length,
      eventNotifications: notes(list, M.event).length,
      acpSessionUpdates: { count: notes(list, M.update).length, bytes: bytesOf(notes(list, M.update)) },
    })
    check(
      '5 reload opens once without a full projection',
      sent(list, M.opening).length === 1 && sent(list, M.full).length === 0,
    )
  })

  // 6. Transport interruption (close code 1012).
  await stepBlock('6-reconnect-1012', async () => {
    from = mark()
    const socketsBeforeDrop = socketCount
    const connectionStates = []
    dropConnections = true
    await socketRoute.close({ code: 1012, reason: 'controlled transport interruption' })
    await page.waitForFunction(() => document.querySelector('#connection')?.dataset.state !== 'connected')
    connectionStates.push(await connection())
    await page.waitForTimeout(1500)
    dropConnections = false
    await page.waitForFunction(
      () => document.querySelector('#connection')?.dataset.state === 'connected',
      undefined,
      {
        timeout: 60000,
      },
    )
    await settle(page)
    list = slice(from)
    const reconnected = list.filter((f) => f.socket > socketsBeforeDrop)
    const firstOpening6 = reconnected.findIndex((f) => f.direction === 'sent' && f.method === M.opening)
    step('6-reconnect-1012', {
      stateWhileDown: connectionStates[0],
      socketsOpenedDuringRecovery: socketCount - socketsBeforeDrop,
      openings: sent(list, M.opening).length,
      fullProjectUI: sent(list, M.full).length,
      patchesBeforeReopen: sent(
        firstOpening6 < 0 ? reconnected : reconnected.slice(0, firstOpening6),
        M.patch,
      ).length,
      patchesOnDroppedSocket: sent(
        list.filter((f) => f.socket <= socketsBeforeDrop),
        M.patch,
      ).length,
      patchesAfterReopen: sent(firstOpening6 < 0 ? [] : reconnected.slice(firstOpening6), M.patch).length,
    })
    check(
      '6 opening exactly +1 after reconnect',
      sent(list, M.opening).length === 1,
      sent(list, M.opening).length,
    )
    check(
      '6 zero patches before the reopen',
      results.steps['6-reconnect-1012'].patchesBeforeReopen === 0 &&
        results.steps['6-reconnect-1012'].patchesOnDroppedSocket === 0,
    )
    check('6 session.projectUI never called', sent(list, M.full).length === 0)
    await page.screenshot({ path: join(artifacts, '06-reconnected.png'), animations: 'disabled' })
  })

  // 7. Daemon restart (new generation).
  await stepBlock('7-daemon-restart', async () => {
    from = mark()
    const socketsBeforeRestart = socketCount
    await sdk.client.close().catch(() => {})
    sdk = undefined
    await stopWeb()
    await command(['daemon', 'stop'])
    const relaunch = await launchWeb()
    sdk = await connectSdk()
    const secondGeneration = sdk.owner.generation
    let recoveredBy = 'page reconnect'
    try {
      await page.waitForFunction(
        () => document.querySelector('#connection')?.dataset.state === 'connected',
        undefined,
        {
          timeout: 20000,
        },
      )
      await page.waitForFunction(
        () => document.querySelector('#transcript')?.textContent.includes('LONG_STREAM_END'),
        undefined,
        {
          timeout: 30000,
        },
      )
    } catch {
      recoveredBy = 'navigation'
      await page.goto(sessionUrl(relaunch, long.id))
      await page.waitForFunction(() => document.querySelector('#connection')?.dataset.state === 'connected')
      await page.waitForFunction(
        () => document.querySelector('#transcript')?.textContent.includes('LONG_STREAM_END'),
        undefined,
        {
          timeout: 60000,
        },
      )
    }
    await settle(page)
    list = slice(from)
    const afterRestart = list.filter((f) => f.socket > socketsBeforeRestart)
    const firstOpening7 = afterRestart.findIndex((f) => f.direction === 'sent' && f.method === M.opening)
    step('7-daemon-restart', {
      generationChanged: firstGeneration !== secondGeneration,
      recoveredBy,
      openings: sent(list, M.opening).length,
      fullProjectUI: sent(list, M.full).length,
      patchesBeforeReopen: sent(
        firstOpening7 < 0 ? afterRestart : afterRestart.slice(0, firstOpening7),
        M.patch,
      ).length,
    })
    check('7 generation changed', firstGeneration !== secondGeneration)
    check(
      '7 one opening and no full projection after restart',
      sent(list, M.opening).length === 1 && sent(list, M.full).length === 0,
      {
        openings: sent(list, M.opening).length,
      },
    )
    check('7 zero patches before the reopen', results.steps['7-daemon-restart'].patchesBeforeReopen === 0)
    await page.screenshot({ path: join(artifacts, '07-after-daemon-restart.png'), animations: 'disabled' })
  })

  // 8. Trace panel.
  await stepBlock('8-trace', async () => {
    from = mark()
    const hasEarlier8 = (await page.locator('.transcript-earlier:not([hidden])').count()) > 0
    const traceClosedRows = await page.locator('#trace-panel .trace-row').count()
    await page.locator('#view-trace').click()
    await page.locator('#trace-panel .trace-row').first().waitFor({ timeout: 30000 })
    const trace = await page.evaluate(() => {
      const panel = document.querySelector('#trace-panel')
      const text = (selector) => [...panel.querySelectorAll(selector)].map((node) => node.textContent)
      const toolBars = [...panel.querySelectorAll('.trace-gantt-bar.lane-tool')].map((node) =>
        node.getAttribute('title'),
      )
      return {
        rows: panel.querySelectorAll('.trace-row').length,
        stats: text('.trace-stat'),
        partialMarker: panel.querySelectorAll('.trace-partial').length,
        truncationNotes: text('.trace-truncated'),
        loadEarlierButton: panel.querySelectorAll('.trace-load-earlier').length,
        toolBars: toolBars.length,
        subagentToolBars: toolBars.filter((title) => title?.startsWith('subagent_')).length,
        readBars: toolBars.filter((title) => title === 'read').length,
      }
    })
    const traceToolNodes = await page.evaluate(
      () => document.querySelectorAll('#transcript article.timeline-node.tool').length,
    )
    await page.screenshot({ path: join(artifacts, '08-trace-open.png'), animations: 'disabled' })
    await page.locator('#view-chat').click()
    await settle(page, 600)
    list = slice(from)
    step('8-trace', {
      rowsWhileClosed: traceClosedRows,
      hasEarlier: hasEarlier8,
      ...trace,
      transcriptToolCards: traceToolNodes,
      // Parent tool spans each have a tool card; any further tool bars come from embedded child trees.
      embeddedChildToolBars: trace.toolBars - traceToolNodes,
      fullProjectUI: sent(list, M.full).length,
      patches: sent(list, M.patch).length,
    })
    check('8 trace rows render and toggle without RPC', trace.rows > 0 && sent(list, M.full).length === 0)
    check(
      '8 partial-history marker follows whether earlier history exists',
      trace.partialMarker === (hasEarlier8 ? 1 : 0),
      {
        hasEarlier: hasEarlier8,
        marker: trace.partialMarker,
      },
    )
    // Child trees are only embedded when a child session was really created.
    if (results.seeding.subagentSpansWithChild > 0) {
      check('8 child task spans are embedded', trace.toolBars > traceToolNodes)
      check(
        '8 truncation marker present for the oversized child tree',
        trace.truncationNotes.length > 0,
        trace.truncationNotes,
      )
    } else {
      results.notes.push(
        'Step 8 child-task and truncation checks not run: no child session could be created (every subagent_spawn failed), so no child tree exists to embed or truncate.',
      )
      step('8-trace', { childChecks: 'not run: no child session exists' })
    }
  })

  // 9. Load earlier history up to the top.
  await stepBlock('9-load-earlier', async () => {
    from = mark()
    let pages = 0
    const loadStarted = Date.now()
    const perfStart9 = await page.evaluate(() => performance.now())
    // The reader scrolls up: the "load earlier" row entering the viewport is what asks for a page.
    // A direct click is only the fallback when a scroll did not trigger it.
    let scrollTriggered = 0
    let clickFallbacks = 0
    const renderedCount = () => page.locator('#transcript article.timeline-node').count()
    const grew = (count, timeout) =>
      page
        .waitForFunction(
          (before) =>
            document.querySelectorAll('#transcript article.timeline-node').length > before ||
            document.querySelector('.transcript-earlier')?.hidden,
          count,
          { timeout },
        )
        .then(
          () => true,
          () => false,
        )
    while (await page.locator('.transcript-earlier:not([hidden])').count()) {
      const before = await renderedCount()
      await page.evaluate(() =>
        document.querySelector('.transcript-earlier')?.scrollIntoView({ block: 'start' }),
      )
      if (await grew(before, 5000)) scrollTriggered++
      else {
        await page.evaluate(() => document.querySelector('.transcript-earlier button')?.click())
        if (!(await grew(before, 30000))) throw new Error('earlier history page did not arrive')
        clickFallbacks++
      }
      pages++
      if (pages > 200) throw new Error('earlier history did not reach the top')
    }
    await settle(page)
    const perfEnd9 = await page.evaluate(() => performance.now())
    list = slice(from)
    step('9-load-earlier', {
      pagesLoaded: pages,
      scrollTriggered,
      clickFallbacks,
      historyCalls: sent(list, M.history).length,
      historyReplyBytes: bytesOf(replies(list, M.history)),
      reopenings: sent(list, M.opening).length,
      fullProjectUI: sent(list, M.full).length,
      ms: Date.now() - loadStarted,
      renderedNodes: await page.locator('#transcript article.timeline-node').count(),
      firstUserText: await page
        .locator('#transcript article.timeline-node.user .node-body')
        .first()
        .textContent(),
      performance: summarizePerf(await perfWindow(page, perfStart9, perfEnd9)),
    })
    check('9 reaches the first turn', results.steps['9-load-earlier'].firstUserText === 'PJ_PLAIN 1')
    check(
      '9 history paging without reopen or full projection',
      sent(list, M.opening).length === 0 && sent(list, M.full).length === 0,
    )
    await page.locator('#transcript').evaluate((node) => {
      node.scrollTop = 0
    })
    await page.screenshot({ path: join(artifacts, '09-top-of-history.png'), animations: 'disabled' })
  })

  // Final comparison: the full Web projection from the SDK against the loaded DOM.
  await stepBlock('final-compare', async () => {
    const fresh = await sdk.client.session.load(long.id, { cwd })
    const full = await fresh.projectUI(undefined, { surface: 'web' })
    const conversation = (node) =>
      node.kind !== 'context' &&
      node.kind !== 'context-sections' &&
      (node.kind !== 'assistant' ||
        Boolean(node.text?.trim() || node.thinking?.trim() || node.lostChars !== undefined))
    const expected = full.nodes.filter(conversation)
    const dom = await page.evaluate(() =>
      [...document.querySelectorAll('#transcript article.timeline-node')].map((node) => ({
        id: node.dataset.nodeId,
        kind: node.dataset.nodeKind,
        text: node.querySelector(':scope .node-body')?.textContent ?? null,
      })),
    )
    // Markdown puts paragraphs in separate blocks whose text joins without a separator, so rendered
    // assistant text is compared with all whitespace removed; user text is plain and keeps word gaps.
    const squash = (value) => (value ?? '').replace(/\s+/g, ' ').trim()
    const bare = (value) => (value ?? '').replace(/\s+/g, '')
    const domById = new Map(dom.map((node) => [node.id, node]))
    const missing = expected.filter((node) => !domById.has(node.id)).map((node) => `${node.kind}:${node.id}`)
    const expectedIds = new Set(expected.map((node) => node.id))
    const extra = dom.filter((node) => !expectedIds.has(node.id)).map((node) => `${node.kind}:${node.id}`)
    const textMismatch = []
    for (const node of expected) {
      const shown = domById.get(node.id)
      if (!shown) continue
      if (shown.kind !== node.kind) textMismatch.push({ id: node.id, reason: 'kind' })
      else if (node.kind === 'user') {
        const want = node.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        if (squash(shown.text) !== squash(want)) textMismatch.push({ id: node.id, reason: 'user text' })
      } else if (node.kind === 'assistant' && bare(shown.text) !== bare(node.text)) {
        const a = bare(shown.text)
        const b = bare(node.text)
        let at = 0
        while (at < a.length && a[at] === b[at]) at++
        textMismatch.push({
          id: node.id,
          reason: 'assistant text',
          domChars: a.length,
          projectionChars: b.length,
          firstDifference: at,
          dom: a.slice(Math.max(0, at - 40), at + 40),
          projection: b.slice(Math.max(0, at - 40), at + 40),
        })
      }
    }
    const orderMatches = dom.map((node) => node.id).join() === expected.map((node) => node.id).join()
    step('final-compare', {
      expectedConversationNodes: expected.length,
      domNodes: dom.length,
      missing: missing.length,
      extra: extra.length,
      textMismatches: textMismatch.length,
      orderMatches,
      samples: { missing: missing.slice(0, 5), extra: extra.slice(0, 5), text: textMismatch.slice(0, 5) },
    })
    await fresh.detach().catch(() => {})
    check(
      'final DOM matches the full Web projection node by node',
      missing.length === 0 && extra.length === 0 && textMismatch.length === 0,
      {
        missing: missing.length,
        extra: extra.length,
        textMismatches: textMismatch.length,
      },
    )
  })

  results.environment.loadAverageAtEnd = loadavg().map(round)
  results.performance = {
    openFirstPaintMs: results.steps['1-open'].firstPaintMs,
    openingReplyBytes: results.steps['1-open'].openingReplyBytes,
    acpSessionUpdatesOnOpen: results.steps['1-open'].acpSessionUpdates,
    toolApprovalTurn: results.steps['2-tool-approval'].performance,
    longStream: results.steps['3-long-stream'].performance,
    loadEarlier: results.steps['9-load-earlier'].performance,
    rpcWholeRun: rpcSummary(frames),
  }
  step('errors', {
    pageErrors: pageErrors.length,
    consoleErrors: consoleErrors.length,
    pageErrorGroups: groupErrors(pageErrors),
    consoleErrorGroups: groupErrors(consoleErrors),
    consoleErrorSample: consoleErrors[0]?.text,
  })
  check('no page errors', pageErrors.length === 0, groupErrors(pageErrors))
  check('no console errors', consoleErrors.length === 0, groupErrors(consoleErrors))
} catch (error) {
  results.error = String(error?.stack ?? error).slice(0, 2000)
  const page = browser?.contexts()[0]?.pages()[0]
  if (page)
    await page.screenshot({ path: join(artifacts, 'failure.png'), animations: 'disabled' }).catch(() => {})
  process.exitCode = 1
} finally {
  results.errors ??= { pageErrors: groupErrors(pageErrors), consoleErrors: groupErrors(consoleErrors) }
  await writeFile(join(artifacts, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  await browser?.close().catch(() => {})
  await sdk?.client.close().catch(() => {})
  await stopWeb()
  await command(['daemon', 'stop']).catch(() => {})
  await provider.close()
  await rm(root, { recursive: true, force: true })
  console.log(
    `${results.failures.length === 0 && !results.error ? 'COMPLETE' : 'INCOMPLETE'} ${results.checks?.length ?? 0} checks, ${results.failures.length} failed; results ${join(artifacts, 'results.json')}`,
  )
  if (results.error) console.error(results.error)
}
