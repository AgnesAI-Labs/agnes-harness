// Runs a bench suite on the default loop and the Jev loop in one headless host and writes the
// per-turn records and the report. See bench/README.md for how to prepare a home and run it.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aggregate,
  callsPerInference,
  computeK,
  finalAnswer,
  LANES,
  loadSuite,
  orderLanes,
  presetName,
  renderReport,
  scoreTurn,
  turnMetrics,
  verdict,
} from './lib.mjs'
import {
  benchBundle,
  DEFAULT_PROFILE,
  discoverRoutes,
  prepareFakeHome,
  probesNeedPython,
  resolvePython,
  SetupError,
  writePythonShim,
} from './setup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', '..', 'cli')
const PROBE_TIMEOUT_MS = 60_000
const DRAIN_MS = 1_000
/** After a cancelled turn the prompt still has this long to settle before the cell is given up. */
const CANCEL_GRACE_MS = 30_000
const CLIP = 2_000

export const USAGE = `Usage:
  pnpm exec tsx packages/loop-jev/bench/run.mjs --suite <suite.json> --out <dir> --home <AGH home> [options]
  pnpm exec tsx packages/loop-jev/bench/run.mjs --suite <suite.json> --out <dir> --fake [options]

Where the routes come from (one of):
  --home <dir>            an AGH home whose Settings hold a Jev side-model account and a chat account
                          (or, in a home whose Settings hold no account, routes in its profile file)
  --fake                  a temporary home with a loopback stand-in for Jev and a scripted chat model;
                          checks the plumbing only and says nothing about either loop

Options:
  --lanes <a,b>           lanes to run: default, jev (default: default,jev)
  --reps <n>              repetitions; lanes alternate their order each repetition (default: 1)
  --scenario <id[,id]>    run only these scenarios
  --pilot                 baseline pilot: default lane only, one repetition; reports k
  --k <n>                 the k found by the pilot, for the inference-count gate (default: 1)
  --profile <name>        profile in the home (default: local-dev)
  --jev-route <route>     the Jev side-model route, when the home has several
  --jev-model <id>        a model on that route (default: the account's selected model)
  --chat-route <route>    the chat model route, when the home has several
  --chat-model <id>       a model on that route (default: the account's selected model)
  --python <path|name>    interpreter for the probes' python (default: BENCH_PYTHON, python3, python)
  --base-preset <name>    preset the per-cell presets extend (default: standard)
  --step-cap <n>          the Jev loop's step cap (default: 20)
  --turn-timeout-ms <n>   watchdog per turn (default: 600000)
  --dry-run               print the plan and write bundle.json without starting a host
  --help                  this text

Exit codes: 0 every cell ran, 1 a cell failed to run (error, timeout, dirty workspace), 2 bad
arguments or setup, 130 interrupted.`

// ---- arguments ----------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '--suite',
  '--out',
  '--home',
  '--lanes',
  '--reps',
  '--scenario',
  '--k',
  '--profile',
  '--jev-route',
  '--jev-model',
  '--chat-route',
  '--chat-model',
  '--python',
  '--base-preset',
  '--step-cap',
  '--turn-timeout-ms',
])
const BOOL_FLAGS = new Set(['--pilot', '--dry-run', '--fake', '--help'])

function positiveInt(value, flag) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new SetupError(`${flag} must be a positive integer`)
  return n
}

export function parseCli(argv) {
  const raw = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (BOOL_FLAGS.has(flag)) raw[flag] = true
    else if (VALUE_FLAGS.has(flag)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new SetupError(`${flag} needs a value`)
      raw[flag] = value
    } else throw new SetupError(`unknown option ${flag}`)
  }
  if (raw['--help']) return { help: true }
  if (!raw['--suite']) throw new SetupError('--suite is required')
  if (!raw['--out']) throw new SetupError('--out is required')
  if (!raw['--fake'] === !raw['--home']) throw new SetupError('pass exactly one of --home and --fake')
  const lanes = (raw['--lanes'] ?? 'default,jev').split(',').filter(Boolean)
  if (lanes.length === 0 || new Set(lanes).size !== lanes.length || lanes.some((l) => !(l in LANES)))
    throw new SetupError('--lanes takes distinct names from: default, jev')
  const k = raw['--k'] === undefined ? 1 : Number(raw['--k'])
  if (!Number.isFinite(k) || k < 1) throw new SetupError('--k must be a number of at least 1')
  const pilot = raw['--pilot'] === true
  return {
    help: false,
    suite: resolve(raw['--suite']),
    out: resolve(raw['--out']),
    home: raw['--home'] === undefined ? undefined : resolve(raw['--home']),
    fake: raw['--fake'] === true,
    dryRun: raw['--dry-run'] === true,
    pilot,
    lanes: pilot ? ['default'] : lanes,
    reps: pilot ? 1 : positiveInt(raw['--reps'] ?? '1', '--reps'),
    scenarios: raw['--scenario']?.split(',').filter(Boolean),
    k,
    profile: raw['--profile'] ?? DEFAULT_PROFILE,
    jevRoute: raw['--jev-route'],
    jevModel: raw['--jev-model'],
    chatRoute: raw['--chat-route'],
    chatModel: raw['--chat-model'],
    python: raw['--python'],
    basePreset: raw['--base-preset'] ?? 'standard',
    stepCap: positiveInt(raw['--step-cap'] ?? '20', '--step-cap'),
    turnTimeoutMs: positiveInt(raw['--turn-timeout-ms'] ?? '600000', '--turn-timeout-ms'),
  }
}

// ---- the plan -----------------------------------------------------------------------------

function planCells(suite, lanes, reps) {
  const cells = []
  for (let rep = 0; rep < reps; rep++)
    for (const lane of orderLanes(lanes, rep))
      for (const scenario of suite.scenarios)
        cells.push({ scenario, lane, rep, preset: presetName(scenario.id, lane, rep) })
  return cells
}

const cellName = (c) => `${c.scenario.id}.${c.lane}.r${c.rep + 1}`

function checkPython(suite, o) {
  if (!probesNeedPython(suite)) return undefined
  const python = resolvePython({ flag: o.python, env: process.env })
  if (!python)
    throw new SetupError(
      'the probes call python, and no interpreter was found: set BENCH_PYTHON or pass --python (python3 and python are not on PATH)',
    )
  const text = JSON.stringify(suite)
  if (/fastapi|pytest/.test(text)) {
    const r = spawnSync(python.path, ['-c', 'import fastapi, httpx, pytest'], { encoding: 'utf8' })
    if (r.status !== 0)
      throw new SetupError(
        `the probes need fastapi, httpx and pytest, which ${python.path} cannot import: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`,
      )
  }
  return python
}

// ---- one session --------------------------------------------------------------------------

/** Collects every event of a session in arrival order and wakes waiters as rows arrive. */
function collect(session) {
  const events = []
  const waiters = new Set()
  let stopped = false
  const iterator = session.events()[Symbol.asyncIterator]()
  const done = (async () => {
    for (;;) {
      const row = await iterator.next()
      if (row.done || stopped) break
      const e = row.value
      events.push({ seq: e.seq, type: e.type, lane: e.lane ?? null, ts: e.ts, data: e.data })
      for (const wake of waiters) wake()
    }
  })().catch(() => undefined)
  return {
    events,
    /** Resolves true once `test()` holds, false after `ms`. */
    until(test, ms) {
      if (test()) return Promise.resolve(true)
      return new Promise((resolveWait) => {
        const wake = () => {
          if (!test()) return
          clearTimeout(timer)
          waiters.delete(wake)
          resolveWait(true)
        }
        const timer = setTimeout(() => {
          waiters.delete(wake)
          resolveWait(test())
        }, ms)
        waiters.add(wake)
      })
    },
    async stop() {
      stopped = true
      await iterator.return?.()
      await done
    },
  }
}

const mainLane = (e) => !e.lane || e.lane === 'main'
const clip = (text) => (text.length > CLIP ? `${text.slice(0, CLIP)}…` : text)

function runProbe(command, cwd, env) {
  return new Promise((resolveProbe) => {
    const child = spawn(command, { cwd, shell: '/bin/bash', env })
    let output = ''
    child.stdout.on('data', (b) => {
      output += b
    })
    child.stderr.on('data', (b) => {
      output += b
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveProbe({ exit: null, output: `${output}${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveProbe({ exit: code, output })
    })
  })
}

function writeTurnFiles(workspace, files) {
  for (const file of files ?? []) {
    const target = resolve(workspace, file.name)
    if (!target.startsWith(`${workspace}/`)) throw new Error(`inject file ${file.name} leaves the workspace`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
  }
}

const isTitleRow = (e) => e.type === 'cost/ledger' && e.data?.purpose === 'title'

/**
 * Turn counters without the session-title request: the host names every new session with one
 * background call to the chat model, the same on both lanes, and it is neither inference nor a
 * Jev call. Its rows are still counted under `purposes.title`.
 */
function metricsOf(events, price) {
  const metrics = turnMetrics(
    events.filter((e) => !isTitleRow(e)),
    price,
  )
  const titles = events.filter(isTitleRow).length
  if (titles) metrics.purposes.title = titles
  return metrics
}

/** The record of a turn that never ran, so a broken cell still counts its turns as failures. */
const notRun = (cell, index, error, tools = []) => ({
  scenario: cell.scenario.id,
  category: cell.scenario.category,
  lane: cell.lane,
  rep: cell.rep,
  turn: index,
  endReason: 'not-run',
  error,
  score: scoreTurn({
    turn: cell.scenario.turns[index],
    answer: '',
    endReason: 'not-run',
    probes: [],
  }),
  metrics: turnMetrics([]),
  wallMs: null,
  tools,
})

/** Runs every turn of one (scenario, lane, repetition) in a fresh session and workspace. */
async function runCell(ctx, cell) {
  const { client, routes, out, probeEnv, price, state } = ctx
  const { scenario, lane, rep } = cell
  const base = { scenario: scenario.id, category: scenario.category, lane, rep }
  mkdirSync(join(out, 'workspaces'), { recursive: true })
  const workspace = mkdtempSync(join(out, 'workspaces', `${cellName(cell)}-`))
  const generation = scenario.category === 'generation'
  if (generation) writeFileSync(join(workspace, '.gitkeep'), '')
  await client.workspace.add(workspace)
  const session = await client.createSession({
    cwd: workspace,
    sessionKey: `bench:${randomUUID()}`,
    preset: cell.preset,
    loop: LANES[lane],
  })
  await session.setModel({ slot: 'primary', route: routes.chat.route, model: routes.chat.model })
  const offPermission = session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
  await session.attach({ filter: { acpUpdates: false } })
  const stream = collect(session)
  // `error` stops the cell (its remaining turns are recorded as not run); `problems` do not.
  const result = { records: [], turnEvents: [], error: undefined, problems: [], tools: [], toolTokens: 0 }
  try {
    const listed = (await session.tools()).tools
    result.tools = listed.map((t) => t.name).sort()
    result.toolTokens = Math.ceil(Buffer.byteLength(JSON.stringify(listed)) / 3)
    const expected = generation ? ['.gitkeep'] : []
    const present = readdirSync(workspace).sort()
    if (present.join('/') !== expected.join('/'))
      result.error = `workspace-not-empty: ${present.filter((n) => !expected.includes(n)).join(', ')}`
    for (const [index, turn] of scenario.turns.entries()) {
      try {
        await runTurn(index, turn)
      } catch (error) {
        result.error = `cell failed in turn ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        result.records.push(notRun(cell, index, result.error, result.tools))
        result.turnEvents.push([])
      }
    }
  } finally {
    offPermission()
    await stream.stop()
    await session.detach().catch(() => undefined)
    mkdirSync(join(out, 'events'), { recursive: true })
    writeFileSync(
      join(out, 'events', `${cellName(cell)}.jsonl`),
      stream.events.map((e) => JSON.stringify(e)).join('\n') + (stream.events.length ? '\n' : ''),
    )
  }
  return result

  async function runTurn(index, turn) {
    if (result.error || state.interrupted) {
      result.records.push(notRun(cell, index, result.error ?? 'interrupted', result.tools))
      result.turnEvents.push([])
      return
    }
    writeTurnFiles(workspace, turn.inject_files)
    const fromSeq = session.lastServerSeq
    const abort = new AbortController()
    state.abort = abort
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, ctx.turnTimeoutMs)
    let turnResult
    let promptError
    const prompt = session.prompt(turn.goal, { signal: abort.signal }).then(
      (r) => {
        turnResult = r
      },
      (e) => {
        promptError = e
      },
    )
    await Promise.race([
      prompt,
      new Promise((r) => abort.signal.addEventListener('abort', r, { once: true })),
    ])
    if (abort.signal.aborted) await Promise.race([prompt, new Promise((r) => setTimeout(r, CANCEL_GRACE_MS))])
    clearTimeout(watchdog)
    state.abort = undefined
    const settled = turnResult !== undefined || promptError !== undefined
    const target = turnResult?.lastSeq ?? session.lastServerSeq
    const isEnd = (e) => e.seq > fromSeq && e.type === 'turn/end' && mainLane(e)
    await stream.until(
      () => stream.events.some(isEnd) && (stream.events.at(-1)?.seq ?? 0) >= target,
      DRAIN_MS,
    )
    const end = stream.events.find(isEnd)
    const upTo = end ? Math.max(end.seq, target) : target
    const events = stream.events.filter((e) => e.seq > fromSeq && e.seq <= upTo)
    const start = events.find((e) => e.type === 'turn/start' && mainLane(e))
    const endReason = timedOut ? 'timeout' : (end?.data?.reason ?? turnResult?.reason ?? 'failed')
    const probes = []
    for (const probe of turn.bash ?? []) probes.push(await runProbe(probe.command, workspace, probeEnv))
    const answer = finalAnswer(events, fromSeq)
    const record = {
      ...base,
      turn: index,
      sessionId: session.id,
      workspace,
      endReason,
      ...(end?.data && typeof end.data === 'object' ? { end: end.data } : {}),
      answer: clip(answer),
      probes: probes.map((p) => ({ exit: p.exit, output: clip(p.output) })),
      score: scoreTurn({ turn, answer, endReason, probes }),
      metrics: metricsOf(events, price),
      wallMs: start && end ? Date.parse(end.ts) - Date.parse(start.ts) : null,
      tools: result.tools,
      ...(promptError
        ? { error: promptError instanceof Error ? promptError.message : String(promptError) }
        : {}),
    }
    result.records.push(record)
    result.turnEvents.push(events)
    if (timedOut) result.problems.push(`timeout after ${ctx.turnTimeoutMs} ms in turn ${index + 1}`)
    if (!settled) result.error = `turn ${index + 1} did not settle after it was cancelled`
  }
}

// ---- checks and report --------------------------------------------------------------------

const jevName = (jev) => (jev ? `${jev.route}/${jev.model}` : 'not used')
const firstOf = (events, type, test = () => true) => events.find((e) => e.type === type && test(e))

/** Pre-run checks, reported only: the same tool schema on both lanes, isolated prompt caches. */
function cellChecks(cells, results) {
  const flags = []
  const byKey = new Map()
  cells.forEach((cell, i) => {
    const r = results[i]
    if (!r) return
    const events = r.turnEvents[0] ?? []
    const hash = firstOf(events, 'request/header')?.data?.tool_schema_hash
    const key = `${cell.scenario.id}|${cell.rep}`
    byKey.set(key, [...(byKey.get(key) ?? []), { lane: cell.lane, hash }])
    const first = firstOf(events, 'cost/ledger', (e) => e.data?.purpose === 'inference')
    const cacheRead = first?.data?.tokens?.cacheRead ?? 0
    if (cacheRead > r.toolTokens)
      flags.push(
        `${cellName(cell)}: first request read ${cacheRead} cached tokens, more than the tool section (about ${r.toolTokens})`,
      )
    for (const problem of [...(r.problems ?? []), ...(r.error ? [r.error] : [])])
      flags.push(`${cellName(cell)}: ${problem}`)
  })
  for (const [key, lanes] of byKey) {
    const hashes = new Set(lanes.map((l) => l.hash))
    if (lanes.length > 1 && hashes.size > 1)
      flags.push(
        `${key.replace('|', ' rep ')}: tool_schema_hash differs between lanes (${lanes.map((l) => `${l.lane} ${l.hash ?? 'none'}`).join(', ')})`,
      )
  }
  return flags
}

function turnFlags(records) {
  const flags = []
  for (const r of records) {
    const at = `${r.scenario}.${r.lane}.r${r.rep + 1} turn ${r.turn + 1}`
    if (!r.metrics.reconciled)
      flags.push(
        `${at}: inference rows (${r.metrics.inference}) differ from Jev model attempts (${r.metrics.jev.llmAttempts})`,
      )
    if (r.metrics.jev.droppedEvents > 0)
      flags.push(`${at}: ${r.metrics.jev.droppedEvents} Jev telemetry events were dropped`)
    if (/NO_PROGRESS_LIMIT/.test(JSON.stringify(r.end ?? {})))
      flags.push(`${at}: ended at the no-progress limit`)
  }
  return flags
}

function jevSection(records) {
  const rows = records.filter((r) => r.lane === 'jev')
  if (rows.length === 0) return []
  const sum = { steps: 0, llmAttempts: 0, noCall: 0, droppedCalls: 0, directSuccess: 0, sideCall: 0 }
  const byRoute = {}
  const failed = {}
  for (const r of rows) {
    const j = r.metrics.jev
    sum.steps += j.steps
    sum.llmAttempts += j.llmAttempts
    sum.noCall += j.noCall
    sum.droppedCalls += j.droppedCalls
    sum.directSuccess += j.directSuccess
    sum.sideCall += r.metrics.sideCall
    for (const [k, v] of Object.entries(j.byRoute)) byRoute[k] = (byRoute[k] ?? 0) + v
    for (const [k, v] of Object.entries(j.decisionFailed)) failed[k] = (failed[k] ?? 0) + v
  }
  const fmt = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || '-'
  return [
    '## Jev lane',
    '',
    `- steps: ${sum.steps}; Jev calls (side-call rows): ${sum.sideCall}`,
    `- steps by route: ${fmt(byRoute)}`,
    `- model attempts: ${sum.llmAttempts}; no call: ${sum.noCall}; dropped calls: ${sum.droppedCalls}`,
    `- direct steps that succeeded: ${sum.directSuccess}`,
    `- decision failures: ${fmt(failed)}`,
    '',
  ]
}

/**
 * Per lane, over the requests of each session in order: how often the tool schema hash changed
 * from one request to the next, and how often the prompt prefix hash stayed the same.
 */
function cacheSection(results, cells) {
  const lanes = {}
  cells.forEach((cell, i) => {
    const records = results[i]?.records ?? []
    const tools = records.flatMap((r) => r.metrics.toolSchemaHashes)
    const prefixes = records.flatMap((r) => r.metrics.promptPrefixHashes)
    lanes[cell.lane] ??= { requests: 0, hashes: new Set(), switches: 0, kept: 0, pairs: 0 }
    const lane = lanes[cell.lane]
    lane.requests += tools.length
    for (const hash of tools) lane.hashes.add(hash)
    for (let n = 1; n < tools.length; n++) if (tools[n] !== tools[n - 1]) lane.switches++
    for (let n = 1; n < prefixes.length; n++) {
      lane.pairs++
      if (prefixes[n] === prefixes[n - 1]) lane.kept++
    }
  })
  const rows = Object.entries(lanes).map(
    ([lane, s]) =>
      `- ${lane}: ${s.requests} requests, ${s.hashes.size} tool schema hashes, ${s.switches} switches within a session; prompt prefix kept ${s.kept}/${s.pairs}`,
  )
  return rows.length ? ['## Cache contract', '', ...rows, ''] : []
}

function writeOutputs(ctx, cells, results) {
  const records = results.flatMap((r) => r?.records ?? [])
  const turns = results.flatMap((r) => r?.turnEvents ?? [])
  const totals = aggregate(records)
  const flags = [
    ...cellChecks(cells, results),
    ...turnFlags(records),
    ...[...ctx.missingPrices].map((m) => `cost missing catalogue price: ${m} (counted as 0)`),
  ]
  const pilot = ctx.o.pilot
    ? {
        ...computeK([{ events: turns.flat() }]),
        callsPerInference: callsPerInference(turns.map((events) => ({ events }))),
      }
    : undefined
  const gates = pilot ? undefined : verdict(totals, ctx.o.k)
  const report = {
    suite: ctx.suite.suite,
    generatedAt: new Date().toISOString(),
    fake: ctx.o.fake,
    lanes: ctx.o.lanes,
    reps: ctx.o.reps,
    routes: { source: ctx.routes.source, jev: ctx.routes.jev, chat: ctx.routes.chat },
    ...(pilot ? { pilot } : { k: ctx.o.k, verdict: gates }),
    totals,
    flags,
    interrupted: ctx.state.interrupted,
  }
  writeFileSync(
    join(ctx.o.out, 'records.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
  )
  writeFileSync(join(ctx.o.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const extra = [
    '## Setup',
    '',
    `- chat model: ${ctx.routes.chat.route}/${ctx.routes.chat.model}; Jev: ${jevName(ctx.routes.jev)} (routes from ${ctx.routes.source}${ctx.o.fake ? ', fake endpoints' : ''})`,
    `- lanes ${ctx.o.lanes.join(', ')}; repetitions ${ctx.o.reps}${ctx.state.interrupted ? '; INTERRUPTED' : ''}`,
    '',
    ...jevSection(records),
    ...cacheSection(results, cells),
    ...(pilot
      ? [
          '## Pilot',
          '',
          `k = ${pilot.k} (mutable calls ${pilot.mutableCalls} / tool-using inference requests ${pilot.toolInferences})`,
          '',
          ...Object.entries(pilot.callsPerInference).map(([k, v]) => `- ${k}: ${v}`),
          '',
        ]
      : []),
    '## Checks',
    '',
    ...(flags.length ? flags.map((f) => `- ${f}`) : ['- none']),
    '',
  ]
  const md = renderReport({
    suite: ctx.suite.suite,
    totals,
    ...(gates ? { verdict: gates, k: ctx.o.k } : {}),
    records,
  })
  writeFileSync(join(ctx.o.out, 'report.md'), `${md}\n${extra.join('\n')}`)
  return report
}

// ---- main ---------------------------------------------------------------------------------

function loadPlan(o) {
  const suite = loadSuite(o.suite)
  if (o.scenarios) {
    const unknown = o.scenarios.filter((id) => !suite.scenarios.some((s) => s.id === id))
    if (unknown.length) throw new SetupError(`unknown scenario ${unknown.join(', ')}`)
    suite.scenarios = suite.scenarios.filter((s) => o.scenarios.includes(s.id))
  }
  return suite
}

export async function main(argv) {
  const o = parseCli(argv)
  if (o.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const suite = loadPlan(o)
  const python = checkPython(suite, o)
  const root = join(o.out, 'root')
  mkdirSync(root, { recursive: true })
  const agnesVersion = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version
  if (o.fake) {
    // The fake endpoints are on loopback; a proxy set on the machine would sit in between.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'])
      delete process.env[key]
    process.env.NO_PROXY = '127.0.0.1,localhost'
  }
  const fake = o.fake ? await prepareFakeHome(o.out) : undefined
  if (fake) o.profile = fake.profile
  try {
    const home = fake?.home ?? o.home
    const routes = await discoverRoutes({
      ...o,
      home,
      cwd: root,
      agnesVersion,
      needJev: o.lanes.includes('jev'),
    })
    const bundle = benchBundle({
      suite,
      lanes: o.lanes,
      reps: o.reps,
      stepCap: o.stepCap,
      basePreset: o.basePreset,
      jev: routes.jev,
    })
    const bundlePath = join(o.out, 'bundle.json')
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`)
    const cells = planCells(suite, o.lanes, o.reps)
    const log = (line) => process.stdout.write(`${line}\n`)
    log(
      `routes from ${routes.source}: chat route ${routes.chat.route} model ${routes.chat.model}; jev ${routes.jev ? `route ${routes.jev.route} model ${routes.jev.model}` : 'not used'}`,
    )
    if (python) log(`probe python: ${python.path} (from ${python.from})`)
    for (const c of cells)
      log(
        `cell ${cellName(c)}: scenario ${c.scenario.id}, lane ${c.lane}, rep ${c.rep + 1}, preset ${c.preset}, ${bundle.presets[c.preset].model.system_prompt.personaPrefix}`,
      )
    log(`home ${home}; bundle ${bundlePath}; startup directory ${root}`)
    if (o.dryRun) return 0

    const shim = python ? writePythonShim(join(o.out, 'shim'), python.path) : undefined
    const probeEnv = {
      ...process.env,
      ...(shim ? { PATH: `${shim}${delimiter}${process.env.PATH ?? ''}` } : {}),
    }
    const missingPrices = new Set()
    const price = (row) => {
      const cost = routes.prices.get(`${row.route}/${row.model}`)
      if (!cost) {
        missingPrices.add(`${row.route ?? '?'}/${row.model ?? '?'}`)
        return 0
      }
      const t = row.tokens ?? {}
      return (
        (t.input ?? 0) * cost.input +
        (t.output ?? 0) * cost.output +
        (t.cacheRead ?? 0) * cost.cacheRead +
        (t.cacheWrite ?? 0) * cost.cacheWrite
      )
    }
    const state = { interrupted: false, abort: undefined }
    const onSignal = () => {
      state.interrupted = true
      state.abort?.abort()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    const { initializeHomeLocked } = await import('@agnes/host')
    const { bootHeadless } = await import(join(CLI, 'src', 'boot', 'headless.ts'))
    const { parseArgs } = await import(join(CLI, 'src', 'args.ts'))
    await initializeHomeLocked(home, o.profile)
    const bootAbort = new AbortController()
    const booted = await bootHeadless(
      {
        bundle: bundlePath,
        args: parseArgs(['--profile', o.profile, '--cwd', root, '--standalone']),
        signal: bootAbort.signal,
      },
      { env: { ...process.env, AGH_HOME: home }, home, cwd: root, agnesVersion, log: () => {} },
    )
    const ctx = {
      o,
      suite,
      routes,
      client: booted.client,
      out: o.out,
      probeEnv,
      price,
      missingPrices,
      state,
      turnTimeoutMs: o.turnTimeoutMs,
    }
    const results = []
    try {
      for (const [i, cell] of cells.entries()) {
        if (state.interrupted) break
        try {
          results[i] = await runCell(ctx, cell)
        } catch (error) {
          const message = `cell failed: ${error instanceof Error ? error.message : String(error)}`
          results[i] = {
            records: cell.scenario.turns.map((_, index) => notRun(cell, index, message)),
            turnEvents: cell.scenario.turns.map(() => []),
            problems: [],
            tools: [],
            toolTokens: 0,
            error: message,
          }
        }
        const r = results[i]
        const passed = r.records.filter((x) => x.score.pass).length
        log(
          `[${i + 1}/${cells.length}] ${cellName(cell)}: ${passed}/${r.records.length} turns passed${r.error ? `; ${r.error}` : ''}`,
        )
      }
      const report = writeOutputs(ctx, cells, results)
      log(`report ${join(o.out, 'report.md')}; ${report.flags.length} flags`)
    } finally {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      await booted.close()
    }
    if (state.interrupted) return 130
    return results.some((r) => r?.error || r?.problems.length) ? 1 : 0
  } finally {
    await fake?.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof SetupError) {
        process.stderr.write(`bench: ${error.message}\n`)
        process.exit(2)
      }
      process.stderr.write(
        `bench: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      )
      process.exit(1)
    },
  )
}
