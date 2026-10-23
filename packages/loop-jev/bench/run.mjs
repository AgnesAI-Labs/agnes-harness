// Runs a bench suite on the default loop and the Jev loop in one headless host and writes the
// per-turn records and the report. See bench/README.md for how to prepare a home and run it.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureJevLoopInstalled } from './install.mjs'
import {
  aggregate,
  callsPerInference,
  computeK,
  decideStats,
  finalAnswer,
  LANES,
  loadSuite,
  orderLanes,
  presetName,
  renderReport,
  scoreTurn,
  sessionBalance,
  toolSchemaCheck,
  turnMetrics,
  turnWindow,
  verdict,
} from './lib.mjs'
import {
  benchBundle,
  DEFAULT_PROFILE,
  discoverRoutes,
  gitAncestor,
  PROFILES,
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
  --k-from <report.json>  take k from a pilot's report.json instead
  --profile <name>        profile in the home: local-dev or enterprise (default: local-dev)
  --jev-route <route>     the Jev side-model route, when the home has several
  --jev-model <id>        a model on that route (default: the account's selected model)
  --chat-route <route>    the chat model route, when the home has several
  --chat-model <id>       a model on that route (default: the account's selected model)
  --python <path|name>    interpreter for the probes' python (default: BENCH_PYTHON, python3, python)
  --base-preset <name>    preset the per-cell presets extend (default: standard)
  --step-cap <n>          the Jev loop's step cap (default: 20)
  --turn-timeout-ms <n>   watchdog per turn (default: 600000)
  --dry-run               print the plan and write bundle.json without starting a host
  --rescore <out dir>     recompute the report of a finished run from its events and records
                          into --out (a new directory); needs no home, key, network or Python
  --help                  this text

Workspaces are made in the system temp directory (TMPDIR) and copied to <out>/workspaces.

Exit codes: 0 every cell ran, 1 a cell failed to run (error, timeout, dirty workspace) or the lanes
sent different tool schemas (not comparable), 2 bad arguments or setup, 130 interrupted.`

// ---- arguments ----------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '--suite',
  '--out',
  '--home',
  '--lanes',
  '--reps',
  '--scenario',
  '--k',
  '--k-from',
  '--profile',
  '--jev-route',
  '--jev-model',
  '--chat-route',
  '--chat-model',
  '--python',
  '--base-preset',
  '--step-cap',
  '--turn-timeout-ms',
  '--rescore',
])
const BOOL_FLAGS = new Set(['--pilot', '--dry-run', '--fake', '--help'])

/** An error's message, plus the `data` a JSON-RPC rejection carries (its reason is only there). */
function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  const data = error.data
  return data && typeof data === 'object' ? `${error.message} ${JSON.stringify(data)}` : error.message
}

function positiveInt(value, flag) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new SetupError(`${flag} must be a positive integer`)
  return n
}

/** k for the inference-count gate: `--k`, or the `pilot.k` of a pilot's report.json, else 1. */
function readK(raw) {
  if (raw['--k'] !== undefined) {
    const k = Number(raw['--k'])
    if (!Number.isFinite(k) || k < 1) throw new SetupError('--k must be a number of at least 1')
    return { k, kSource: '--k' }
  }
  if (raw['--k-from'] !== undefined) {
    const path = resolve(raw['--k-from'])
    let k
    try {
      k = JSON.parse(readFileSync(path, 'utf8'))?.pilot?.k
    } catch (error) {
      throw new SetupError(
        `--k-from ${path} cannot be read: ${error instanceof Error ? error.message : error}`,
      )
    }
    if (typeof k !== 'number' || !Number.isFinite(k) || k < 1)
      throw new SetupError(`--k-from ${path} is not a pilot report (no pilot.k of at least 1)`)
    return { k, kSource: `pilot report ${path}` }
  }
  return { k: 1, kSource: 'default (no pilot k given)' }
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
  if (raw['--rescore'] !== undefined) {
    if (!raw['--out']) throw new SetupError('--out is required')
    if (raw['--k'] !== undefined && raw['--k-from'] !== undefined)
      throw new SetupError('pass at most one of --k and --k-from')
    const given = raw['--k'] !== undefined || raw['--k-from'] !== undefined
    return {
      help: false,
      rescore: resolve(raw['--rescore']),
      out: resolve(raw['--out']),
      ...(given ? readK(raw) : {}),
    }
  }
  if (!raw['--suite']) throw new SetupError('--suite is required')
  if (!raw['--out']) throw new SetupError('--out is required')
  if (!raw['--fake'] === !raw['--home']) throw new SetupError('pass exactly one of --home and --fake')
  const lanes = (raw['--lanes'] ?? 'default,jev').split(',').filter(Boolean)
  if (lanes.length === 0 || new Set(lanes).size !== lanes.length || lanes.some((l) => !(l in LANES)))
    throw new SetupError('--lanes takes distinct names from: default, jev')
  if (raw['--k'] !== undefined && raw['--k-from'] !== undefined)
    throw new SetupError('pass at most one of --k and --k-from')
  const { k, kSource } = readK(raw)
  const profile = raw['--profile'] ?? DEFAULT_PROFILE
  if (!PROFILES.includes(profile))
    throw new SetupError(
      `--profile must be one of ${PROFILES.join(', ')}: the host layers a profile over the built-in template of the same name`,
    )
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
    kSource,
    profile,
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

export function writeTurnFiles(workspace, files) {
  for (const file of files ?? []) {
    const target = resolve(workspace, file.name)
    const local = relative(workspace, target)
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error(`inject file ${file.name} leaves the workspace`)
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
function metricsOf(events, price, jevRoute) {
  const metrics = turnMetrics(
    events.filter((e) => !isTitleRow(e)),
    price,
    { jevRoute },
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
  steps: 0,
  tools,
})

/**
 * Runs every turn of one (scenario, lane, repetition) in a fresh session, in a fresh workspace under
 * the system temp directory. Afterwards the workspace is copied to `<out>/workspaces/<cell>` for
 * inspection and the temp one is removed.
 */
async function runCell(ctx, cell) {
  const workspace = realpathSync(mkdtempSync(join(ctx.workBase, 'agnes-bench-')))
  const kept = join(ctx.out, 'workspaces', cellName(cell))
  try {
    const repo = gitAncestor(workspace)
    if (repo) throw new Error(`workspace ${workspace} is inside the git work tree ${repo}`)
    return await runCellIn(ctx, cell, workspace, kept)
  } finally {
    try {
      mkdirSync(dirname(kept), { recursive: true })
      rmSync(kept, { recursive: true, force: true })
      cpSync(workspace, kept, { recursive: true })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
}

async function runCellIn(ctx, cell, workspace, kept) {
  const { client, host, routes, out, probeEnv, price, state } = ctx
  const { scenario, lane, rep } = cell
  const base = { scenario: scenario.id, category: scenario.category, lane, rep, workspace, kept }
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
  // The seq of the last event any earlier turn's window took. The session's own `lastServerSeq`
  // advances only on attach, so it cannot mark where a turn begins.
  let cursor = session.lastServerSeq
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
        result.error = `cell failed in turn ${index + 1}: ${describeError(error)}`
        result.records.push(notRun(cell, index, result.error, result.tools))
        result.turnEvents.push([])
      }
    }
  } finally {
    offPermission()
    try {
      // This bench owns the embedded Host and its temporary sessions. Closing producers before
      // the collector lets post-turn features settle their cost rows before the report is cut.
      const owned = host.kernel.get(session.id)
      if (!owned) result.problems.push(`bench session ${session.id} is unavailable at shutdown`)
      else {
        await owned.close()
        if (!(await stream.until(() => (stream.events.at(-1)?.seq ?? 0) >= owned.lastSeq, DRAIN_MS)))
          result.problems.push(`bench session ${session.id} did not drain its final ledger watermark`)
      }
    } catch (error) {
      result.problems.push(`session close failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await stream.stop()
      await session.detach().catch(() => undefined)
    }
    // Side calls on other routes are counted over the whole session: a host feature may call the
    // chat model after a turn has ended, outside every turn's slice of events.
    result.otherSideCalls = metricsOf(stream.events, price, routes.jev?.route ?? null).otherSideCalls
    result.sessionCheck = {
      cell: cellName(cell),
      ...sessionBalance(stream.events, result.records, routes.jev?.route ?? null),
    }
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
    const fromSeq = cursor
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
    const target = turnResult?.lastSeq ?? stream.events.at(-1)?.seq ?? fromSeq
    const isEnd = (e) => e.seq > fromSeq && e.type === 'turn/end' && mainLane(e)
    await stream.until(
      () => stream.events.some(isEnd) && (stream.events.at(-1)?.seq ?? 0) >= target,
      DRAIN_MS,
    )
    // This turn's window: from its own turn/start to its own turn/end. Rows the host writes between
    // turns (a session title, a reply suggestion) belong to no turn.
    const { start, end, lower, upper, events } = turnWindow(
      stream.events,
      fromSeq,
      Math.max(target, stream.events.at(-1)?.seq ?? fromSeq),
    )
    cursor = Math.max(cursor, upper)
    const endReason = timedOut ? 'timeout' : (end?.data?.reason ?? turnResult?.reason ?? 'failed')
    const probes = []
    for (const probe of turn.bash ?? []) probes.push(await runProbe(probe.command, workspace, probeEnv))
    const answer = finalAnswer(events, lower)
    const record = {
      ...base,
      turn: index,
      sessionId: session.id,
      endReason,
      ...(end?.data && typeof end.data === 'object' ? { end: end.data } : {}),
      answer: clip(answer),
      probes: probes.map((p) => ({ exit: p.exit, output: clip(p.output) })),
      score: scoreTurn({ turn, answer, endReason, probes }),
      metrics: metricsOf(events, price, routes.jev?.route ?? null),
      ...(lane === 'jev' ? { jevDecide: decideStats(events) } : {}),
      wallMs: start && end ? Date.parse(end.ts) - Date.parse(start.ts) : null,
      steps: events.filter((e) => e.type === 'step/start' && mainLane(e)).length,
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

/** The first request's tool schema hash of a cell that ran, for comparing the lanes. */
const schemaEntry = (cell, r) => ({
  scenario: cell.scenario.id,
  lane: cell.lane,
  rep: cell.rep,
  hash: firstOf(r.turnEvents.flat(), 'request/header')?.data?.tool_schema_hash ?? null,
})

/** The tool schema check over the cells that ran, as flags and the verdict's validity. */
function schemaCheck(cells, results) {
  const check = toolSchemaCheck(
    cells.flatMap((cell, i) => (results[i] ? [schemaEntry(cell, results[i])] : [])),
  )
  const pair = (p) =>
    `${p.scenario} rep ${p.rep + 1} (${Object.entries(p.hashes)
      .map(([l, h]) => `${l} ${h ?? 'none'}`)
      .join(', ')})`
  const flags = [
    ...check.mismatches.map((p) => `tool_schema_hash differs between lanes: ${pair(p)}`),
    ...check.unchecked.map((p) => `tool_schema_hash not compared, a lane sent no request: ${pair(p)}`),
  ]
  const reason = check.mismatches.length
    ? 'the lanes sent different tool schemas (tool_schema_hash)'
    : check.compared === 0
      ? 'no scenario ran on both lanes with a request to compare tool schemas'
      : undefined
  return { ...check, flags, reason }
}

/** Per-cell checks, reported only: isolated prompt caches, cell errors and problems. */
function cellChecks(cells, results) {
  const flags = []
  cells.forEach((cell, i) => {
    const r = results[i]
    if (!r) return
    const events = r.turnEvents[0] ?? []
    const first = firstOf(events, 'cost/ledger', (e) => e.data?.purpose === 'inference')
    const cacheRead = first?.data?.tokens?.cacheRead ?? 0
    if (cacheRead > r.toolTokens)
      flags.push(
        `${cellName(cell)}: first request read ${cacheRead} cached tokens, more than the tool section (about ${r.toolTokens})`,
      )
    for (const problem of [...(r.problems ?? []), ...(r.error ? [r.error] : [])])
      flags.push(`${cellName(cell)}: ${problem}`)
  })
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
  const decide = { byStatus: {}, latencyMs: 0, maxLatencyMs: 0, failedLatencyMs: 0 }
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
    const d = r.jevDecide
    if (!d) continue
    for (const [k, v] of Object.entries(d.byStatus)) decide.byStatus[k] = (decide.byStatus[k] ?? 0) + v
    decide.latencyMs += d.latencyMs
    decide.maxLatencyMs = Math.max(decide.maxLatencyMs, d.maxLatencyMs)
    decide.failedLatencyMs += d.failedLatencyMs
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
    `- Jev calls by status: ${fmt(decide.byStatus)}; latency total ${seconds(decide.latencyMs)}, largest ${seconds(decide.maxLatencyMs)}; time in calls that did not answer ${seconds(decide.failedLatencyMs)}`,
    '',
  ]
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

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

/**
 * Per lane: side-call rows on routes other than the Jev route, over each whole session. They are
 * kept out of the Jev counts, the cost and the gates; this section is the only place they show.
 */
function otherSideCalls(cells, results) {
  const lanes = {}
  for (const [i, cell] of cells.entries()) {
    const o = results[i]?.otherSideCalls
    if (!o) continue
    lanes[cell.lane] ??= { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usdMicros: 0 }
    const lane = lanes[cell.lane]
    lane.count += o.count
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) lane[key] += o.tokens[key]
    lane.usdMicros += o.usdMicros
  }
  return lanes
}

function otherSection(lanes) {
  const rows = Object.entries(lanes).map(
    ([lane, s]) =>
      `- ${lane}: ${s.count} rows; tokens input ${s.input}, output ${s.output}, cache read ${s.cacheRead}, cache write ${s.cacheWrite}; cost $${(s.usdMicros / 1e6).toFixed(6)}`,
  )
  return rows.length
    ? [
        '## Other side calls',
        '',
        'Side calls on routes other than the Jev route; not part of any gate.',
        '',
        ...rows,
        '',
      ]
    : []
}

function writeOutputs(ctx, cells, results) {
  const records = results.flatMap((r) => r?.records ?? [])
  const turns = results.flatMap((r) => r?.turnEvents ?? [])
  const totals = aggregate(records)
  const compare = ctx.o.lanes.length > 1 ? schemaCheck(cells, results) : undefined
  const other = otherSideCalls(cells, results)
  const sessionChecks = results.flatMap((r) => (r?.sessionCheck ? [r.sessionCheck] : []))
  const unbalanced = sessionChecks.filter((c) => !c.ok)
  const flags = [
    ...unbalanced.map(
      (c) =>
        `${c.cell}: per-turn counts do not add up to the session ledger (inference ${c.turnInference} of ${c.inferenceRows} rows, Jev side calls ${c.turnJevSideCalls} of ${c.jevSideCallRows} rows)`,
    ),
    ...(compare?.flags ?? []),
    ...Object.entries(other)
      .filter(([, s]) => s.count > 0)
      .map(
        ([lane, s]) =>
          `${lane}: ${s.count} side calls on routes other than the Jev route (kept out of the gates)`,
      ),
    ...cellChecks(cells, results),
    ...turnFlags(records),
    ...[...ctx.missingPrices].map((m) => `cost missing catalogue price: ${m} (counted as 0)`),
    ...(ctx.extraFlags ?? []),
  ]
  const pilot = ctx.o.pilot
    ? {
        ...computeK([{ events: turns.flat() }]),
        callsPerInference: callsPerInference(turns.map((events) => ({ events }))),
      }
    : undefined
  // The gates mean something only when both lanes ran with the same tool schema.
  const gates =
    pilot || !compare
      ? undefined
      : compare.valid
        ? { ...verdict(totals, ctx.o.k), valid: true }
        : { passGate: false, callGate: false, costGate: false, valid: false, reason: compare.reason }
  const report = {
    suite: ctx.suite.suite,
    generatedAt: new Date().toISOString(),
    fake: ctx.o.fake,
    lanes: ctx.o.lanes,
    reps: ctx.o.reps,
    routes: { source: ctx.routes.source, jev: ctx.routes.jev, chat: ctx.routes.chat },
    ...(pilot ? { pilot } : { k: ctx.o.k, kSource: ctx.o.kSource, verdict: gates ?? null }),
    ...(ctx.stopped ? { stopped: ctx.stopped } : {}),
    totals,
    ...(ctx.rescoredFrom ? { rescoredFrom: ctx.rescoredFrom } : {}),
    otherSideCalls: other,
    sessionChecks,
    countsAddUp: unbalanced.length === 0,
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
    ...(pilot ? [] : [`- k = ${ctx.o.k} (${ctx.o.kSource})`]),
    ...(ctx.stopped ? [`- stopped early: ${ctx.stopped}`] : []),
    ...(ctx.rescoredFrom ? [`- rescored from the events of ${ctx.rescoredFrom}`] : []),
    '',
    ...jevSection(records),
    ...cacheSection(results, cells),
    ...otherSection(other),
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
    ...(gates?.valid ? { verdict: gates, k: ctx.o.k } : {}),
    records,
  })
  const headline = [
    ...(unbalanced.length
      ? [
          `> **COUNTS DO NOT ADD UP: in ${unbalanced.length} session(s) the per-turn counts differ from the session's ledger rows; the numbers below are not reliable. See Checks.**\n\n`,
        ]
      : []),
    ...(gates && !gates.valid
      ? [`> **NOT COMPARABLE: ${gates.reason}. No gate is judged; see Checks.**\n\n`]
      : []),
  ].join('')
  writeFileSync(join(ctx.o.out, 'report.md'), `${headline}${md}\n${extra.join('\n')}`)
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

// ---- rescore ------------------------------------------------------------------------------

const readLines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))

/**
 * Recomputes a finished run from its own files: every per-turn metric from the saved session events
 * with the turn windows of this version, the session checks, the pilot's k or the gates. Probe results,
 * answers and checks are kept from `records.jsonl`; only whether a turn completed is read again from
 * its own `turn/end`. Needs no home, key, network or Python, and writes only into `--out`.
 */
async function rescore(o) {
  const src = o.rescore
  if (resolve(o.out) === src)
    throw new SetupError('--out must be a new directory, not the one being rescored')
  if (existsSync(join(o.out, 'report.json'))) throw new SetupError(`${o.out} already holds a report`)
  for (const name of ['report.json', 'records.jsonl', 'events'])
    if (!existsSync(join(src, name))) throw new SetupError(`${src} has no ${name}; it is not a bench output`)
  const original = JSON.parse(readFileSync(join(src, 'report.json'), 'utf8'))
  const routes = original.routes
  const jevRoute = routes?.jev?.route ?? null
  const pilot = original.pilot !== undefined
  const k = o.k ?? original.k ?? 1
  const kSource =
    o.kSource ??
    (original.kSource ? `${original.kSource}, as in the original report` : 'default (no pilot k given)')
  const missingPrices = new Set()
  const price = (row) => {
    missingPrices.add(`${row.route ?? '?'}/${row.model ?? '?'}`)
    return 0
  }
  const byCell = new Map()
  for (const record of readLines(join(src, 'records.jsonl'))) {
    const key = `${record.scenario}.${record.lane}.r${record.rep + 1}`
    byCell.set(key, [...(byCell.get(key) ?? []), record])
  }
  const cells = []
  const results = []
  for (const [key, list] of byCell) {
    const first = list[0]
    const cell = {
      scenario: { id: first.scenario, category: first.category },
      lane: first.lane,
      rep: first.rep,
    }
    const file = join(src, 'events', `${key}.jsonl`)
    const events = existsSync(file) ? readLines(file) : []
    const result = { records: [], turnEvents: [], error: undefined, problems: [], toolTokens: Infinity }
    if (!existsSync(file)) result.error = `no events file ${key}.jsonl`
    let cursor = 0
    for (const r of [...list].sort((a, b) => a.turn - b.turn)) {
      if (r.endReason === 'not-run') {
        result.records.push(r)
        result.turnEvents.push([])
        if (r.error && r.error !== 'interrupted') result.error ??= r.error
        continue
      }
      const w = turnWindow(events, cursor)
      cursor = w.upper
      const endReason = r.endReason === 'timeout' ? 'timeout' : (w.end?.data?.reason ?? r.endReason)
      const completed = endReason === 'completed'
      result.records.push({
        ...r,
        endReason,
        ...(w.end?.data ? { end: w.end.data } : {}),
        score: { ...r.score, completed, pass: r.score.probesPass && r.score.answerPass && completed },
        metrics: metricsOf(w.events, price, jevRoute),
        ...(r.lane === 'jev' ? { jevDecide: decideStats(w.events) } : {}),
        wallMs: w.start && w.end ? Date.parse(w.end.ts) - Date.parse(w.start.ts) : null,
        steps: w.events.filter((e) => e.type === 'step/start' && mainLane(e)).length,
      })
      result.turnEvents.push(w.events)
      if (endReason === 'timeout') result.problems.push(`timeout in turn ${r.turn + 1}`)
    }
    result.otherSideCalls = metricsOf(events, price, jevRoute).otherSideCalls
    result.sessionCheck = { cell: key, ...sessionBalance(events, result.records, jevRoute) }
    cells.push(cell)
    results.push(result)
  }
  mkdirSync(o.out, { recursive: true })
  const ctx = {
    o: {
      out: o.out,
      lanes: original.lanes,
      reps: original.reps,
      pilot,
      fake: original.fake === true,
      k,
      kSource,
    },
    suite: { suite: original.suite },
    routes,
    missingPrices,
    state: { interrupted: original.interrupted === true },
    stopped: original.stopped,
    rescoredFrom: src,
    // The tool definitions are not saved, so the cache-read check is carried over: the first turn's
    // window, which it reads, did not depend on the window logic.
    extraFlags: (original.flags ?? []).filter((f) => f.includes('cached tokens')),
  }
  const report = writeOutputs(ctx, cells, results)
  process.stdout.write(
    `rescored ${cells.length} sessions from ${src}; report ${join(o.out, 'report.md')}; ${report.flags.length} flags\n`,
  )
  if (!report.countsAddUp) return 1
  if (report.verdict && !report.verdict.valid) return 1
  return 0
}

export async function main(argv) {
  const o = parseCli(argv)
  if (o.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (o.rescore) return rescore(o)
  const suite = loadPlan(o)
  const python = checkPython(suite, o)
  // Workspaces and the startup directory live under the system temp directory, never under --out:
  // inside a repository, a session would load that repository's instruction files on both lanes
  // and its auto-approved tools could reach the repository.
  const workBase = realpathSync(tmpdir())
  const repo = gitAncestor(workBase)
  if (repo)
    throw new SetupError(
      `the temp directory ${workBase} is inside the git work tree ${repo}; point TMPDIR at a directory outside any repository`,
    )
  if (o.lanes.includes('jev') && o.reps > 1 && !o.pilot && o.kSource.startsWith('default'))
    process.stderr.write(
      'bench: warning: no --k or --k-from given; the inference-count gate uses k = 1. Run the pilot first and pass --k-from <pilot report.json>.\n',
    )
  mkdirSync(o.out, { recursive: true })
  const root = mkdtempSync(join(workBase, 'agnes-bench-root-'))
  const agnesVersion = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version
  if (o.fake) {
    // The fake endpoints are on loopback; a proxy set on the machine would sit in between.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'])
      delete process.env[key]
    process.env.NO_PROXY = '127.0.0.1,localhost'
  }
  let fake
  try {
    fake = o.fake ? await prepareFakeHome(o.out) : undefined
    if (fake) o.profile = fake.profile
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
    log(
      `home ${home}; bundle ${bundlePath}; workspaces under ${workBase}, kept in ${join(o.out, 'workspaces')}`,
    )
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
    const { bootHeadless } = await import(pathToFileURL(join(CLI, 'src', 'boot', 'headless.ts')).href)
    const { parseArgs } = await import(pathToFileURL(join(CLI, 'src', 'args.ts')).href)
    await initializeHomeLocked(home, o.profile)
    // The Jev loop is an optional bundled package: install it into the home the way the Market does.
    if (await ensureJevLoopInstalled({ home, profile: o.profile, agnesVersion, cwd: root }))
      log(`installed and enabled @agnes/jev-loop in ${home}`)
    // The host reads user-wide instruction files from AGH_HOME; the bench home holds none.
    process.env.AGH_HOME = home
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
      host: booted.host,
      out: o.out,
      workBase,
      stopped: undefined,
      probeEnv,
      price,
      missingPrices,
      state,
      turnTimeoutMs: o.turnTimeoutMs,
    }
    const results = []
    let report
    try {
      for (const [i, cell] of cells.entries()) {
        if (state.interrupted) break
        try {
          results[i] = await runCell(ctx, cell)
        } catch (error) {
          const message = `cell failed: ${describeError(error)}`
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
        // Stop as soon as one scenario has run on both lanes with different tool schemas: no
        // later cell could make the two lanes comparable again.
        if (o.lanes.length > 1 && schemaCheck(cells, results).mismatches.length) {
          ctx.stopped = 'the lanes sent different tool schemas; the remaining cells were not run'
          log(`bench: ${ctx.stopped}`)
          break
        }
      }
      report = writeOutputs(ctx, cells, results)
      log(`report ${join(o.out, 'report.md')}; ${report.flags.length} flags`)
    } finally {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      await booted.close()
    }
    if (state.interrupted) return 130
    if (report.verdict && !report.verdict.valid) return 1
    if (!report.countsAddUp) return 1
    return results.some((r) => r?.error || r?.problems.length) ? 1 : 0
  } finally {
    await fake?.close()
    rmSync(root, { recursive: true, force: true })
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
