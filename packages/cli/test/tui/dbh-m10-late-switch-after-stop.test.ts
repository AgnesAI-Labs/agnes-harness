// Deep Bug Hunt M-10 (adversarial-tester, group B). Assertions describe CORRECT behaviour:
// a failure on the current code is the reproduction.
//
// Oracle: TuiApp.stop() semantics (app.ts stop: clears timers, unsubscribes, stops the projection --
// nothing of the app may keep running afterwards) and packages/cli/src/bin.ts ("Node leaves with this
// code once the loop is empty"): after the TUI has stopped and the client is closed, no projection
// may be (re)opened and no timer may keep the event loop alive.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient, type Session } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { FakeEndpoint } from '../fake-endpoint.js'

const SID1 = 'agnes:local:default:cli:dm:m10-s1'
const SID2 = 'agnes:local:default:cli:dm:m10-s2'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const opening = (sessionId: string) => ({
  timeline: { sessionId, upto: 0, generation: 1, opState: null, turns: [], nodes: [] },
  history: { hasEarlier: false, startIndex: 0, totalNodes: 0 },
})

function lateEndpoint(late: boolean) {
  let news = 0
  let releaseSecondNew!: () => void
  const secondNew = new Promise<void>((r) => {
    releaseSecondNew = r
  })
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', async () => {
      if (++news === 1) return { sessionId: SID1 }
      if (late) await secondNew
      return { sessionId: SID2 }
    })
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    // The late /new answer lands while the CLI is detaching the old session during shutdown.
    .on('_agnes/v1/session.detach', () => {
      releaseSecondNew()
      return {}
    })
    .on('_agnes/v1/session.projectUIOpening', (params) => {
      const { sessionId } = params as { sessionId: string }
      if (sessionId === SID2 && late) return new Promise(() => {}) // never answers before close
      return opening(sessionId)
    })
  return { endpoint, news: () => news }
}

async function scenario(late: boolean) {
  const { endpoint, news } = lateEndpoint(late)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  const session = await client.session.new({ cwd: '/tmp' })
  // Counts every projectUIOpening attempt made through the real SDK Session, including attempts the
  // closed client rejects locally without reaching the endpoint.
  const proto = Object.getPrototypeOf(session) as Session
  const spy = vi.spyOn(proto, 'projectUIOpening')
  try {
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    term.feed('/new')
    term.feed('\r')
    await vi.waitFor(() => expect(news()).toBe(2))
    if (!late) await vi.waitFor(() => expect(app?.session.id).toBe(SID2))
    // Same order as packages/cli/src/modes/tui.ts finally + bin.ts shutdown.
    const current = app.session
    await app.stop()
    const attemptsAtStop = spy.mock.contexts.filter((s) => (s as Session).id === SID2).length
    await current.detach()
    await sleep(20)
    await client.close()
    await endpoint.close()
    await sleep(1_600)
    const internals = app as unknown as { projection: { openingRetry?: unknown }; o: { session: Session } }
    return {
      s2AttemptsAfterStop:
        spy.mock.contexts.filter((s) => (s as Session).id === SID2).length - attemptsAtStop,
      sessionAfterStop: internals.o.session.id,
      retryTimerArmed: internals.projection.openingRetry !== undefined,
    }
  } finally {
    await app?.stop()
    // Hygiene only (after observation): stop a projection the late switch installed after stop(), so
    // its retry timer does not outlive this test inside the vitest worker.
    await (app as unknown as { projection?: { stop(): Promise<void> } } | undefined)?.projection?.stop()
    spy.mockRestore()
    await client.close()
    await endpoint.close()
  }
}

it('[control] /new completing before quit: no projection attempt or timer after stop', async () => {
  const seen = await scenario(false)
  // Preserved: a switch that completed before quit still switched.
  expect(seen, JSON.stringify(seen)).toMatchObject({
    s2AttemptsAfterStop: 0,
    sessionAfterStop: SID2,
    retryTimerArmed: false,
  })
}, 10_000)

it('[M-10] a /new answer arriving during shutdown must not open a projection or arm a retry timer after stop', async () => {
  const seen = await scenario(true)
  expect(seen, JSON.stringify(seen)).toMatchObject({
    s2AttemptsAfterStop: 0,
    sessionAfterStop: SID1,
    retryTimerArmed: false,
  })
}, 10_000)

it('[M-10b] stop() landing while a switch waits for the old projection to stop: the switch is abandoned', async () => {
  const { endpoint, news } = lateEndpoint(false)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const proto = Object.getPrototypeOf(session) as Session
  const spy = vi.spyOn(proto, 'projectUIOpening')
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  const internals = app as unknown as { projection: { stop(): Promise<void> } }
  try {
    await app.start()
    // Hold the old projection's stop, which applySwitch awaits before it swaps sessions.
    const old = internals.projection
    const realStop = old.stop.bind(old)
    let stopCalls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    old.stop = async () => {
      stopCalls++
      await gate
      await realStop()
    }
    term.feed('/new')
    term.feed('\r')
    await vi.waitFor(() => expect({ news: news(), stopCalls }).toEqual({ news: 2, stopCalls: 1 }))
    const stopping = app.stop()
    release()
    await stopping
    await sleep(50)
    const s2Attempts = spy.mock.contexts.filter((s) => (s as Session).id === SID2).length
    expect({ session: app.session.id, s2Attempts }).toEqual({ session: SID1, s2Attempts: 0 })
  } finally {
    await app.stop()
    // Hygiene only: stop a projection a late switch installed after stop().
    await internals.projection.stop()
    spy.mockRestore()
    await client.close()
    await endpoint.close()
  }
}, 10_000)

// Second, independent dynamic source: a real child Node process (tsx) runs the same shutdown order and
// the observable is whether the process exits by itself once teardown is done (bin.ts relies on the
// event loop draining). The parent kills it after a bounded wait.
const ROOT = resolve(import.meta.dirname, '../../../..')
const CHILD = `
import { createClient } from '${ROOT}/packages/sdk/src/index.node.ts'
import { TuiApp, FakeTerminal } from '${ROOT}/packages/cli-tui/src/index.ts'
import { FakeEndpoint } from '${ROOT}/packages/cli/test/fake-endpoint.ts'
const late = process.argv[2] === 'late'
const SID1 = '${SID1}', SID2 = '${SID2}'
let news = 0, release
const secondNew = new Promise((r) => { release = r })
const ep = new FakeEndpoint()
  .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, _meta: { agnes: { agnesVersion: '0' } } }))
  .on('session/new', async () => { if (++news === 1) return { sessionId: SID1 }; if (late) await secondNew; return { sessionId: SID2 } })
  .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
  .on('_agnes/v1/session.detach', () => { release(); return {} })
  .on('_agnes/v1/session.projectUIOpening', (p) => (p.sessionId === SID2 && late) ? new Promise(() => {}) :
    ({ timeline: { sessionId: p.sessionId, upto: 0, generation: 1, opState: null, turns: [], nodes: [] }, history: { hasEarlier: false, startIndex: 0, totalNodes: 0 } }))
const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
const session = await client.session.new({ cwd: '/tmp' })
const term = new FakeTerminal({ columns: 80, rows: 24 })
const app = new TuiApp({ session, term, header: 'Agnes' })
await app.start()
term.feed('/new'); term.feed('\\r')
while (news < 2) await new Promise((r) => setImmediate(r))
if (!late) while (app.session.id !== SID2) await new Promise((r) => setImmediate(r))
const current = app.session
await app.stop()
await current.detach()
await new Promise((r) => setImmediate(r))
await client.close()
await ep.close()
const t0 = Date.now()
process.stderr.write('TEARDOWN_DONE\\n')
process.on('exit', (code) => process.stderr.write('EXITED ' + JSON.stringify({ code, afterTeardownMs: Date.now() - t0 }) + '\\n'))
`

function runChild(mode: 'late' | 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'dbh-m10-child-'))
  try {
    const script = join(dir, 'child.mts')
    writeFileSync(script, CHILD)
    const started = Date.now()
    const r = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, script, mode],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 8_000,
        killSignal: 'SIGKILL',
      },
    )
    const exited = r.stderr.split('\n').find((l) => l.startsWith('EXITED '))
    return {
      status: r.status,
      signal: r.signal,
      wallMs: Date.now() - started,
      teardownDone: r.stderr.includes('TEARDOWN_DONE'),
      exited: exited ? JSON.parse(exited.slice('EXITED '.length)) : null,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

it('[control/process] normal /new then quit: the process exits on its own after teardown', () => {
  const seen = runChild('normal')
  expect(seen.teardownDone, JSON.stringify(seen)).toBe(true)
  expect(seen, JSON.stringify(seen)).toMatchObject({ status: 0, signal: null })
}, 30_000)

it('[M-10/process] late /new during shutdown: the process must still exit on its own after teardown', () => {
  const seen = runChild('late')
  expect(seen.teardownDone, JSON.stringify(seen)).toBe(true)
  expect(seen, JSON.stringify(seen)).toMatchObject({ status: 0, signal: null })
}, 30_000)
