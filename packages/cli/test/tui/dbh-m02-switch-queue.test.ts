// Deep Bug Hunt M-02 (adversarial-tester, group B). Assertions describe CORRECT behaviour:
// a failure on the unfixed code is the reproduction.
//
// Oracle: packages/cli-tui/src/app.ts applySwitch comment ("Reset turn-lifecycle state to exactly
// what a freshly-constructed TuiApp looks like") and submit()'s comment (the local queue stands in
// for the daemon's per-session followUp queue). A turn and its queued follow-ups belong to the
// session they were typed into; nothing typed against s1 may be dispatched to / cancel s2.
// Product decision (2026-09-17): while this client's own turn or queued prompts are pending, /new,
// /resume, /rewind and the session picker refuse to switch instead of re-homing that work.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampFor } from '@agnes/ai/testkit'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { type RequestBody, rpcError } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { runSlash } from '../../src/tui/commands.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { FakeEndpoint } from '../fake-endpoint.js'
import { screenOf } from './harness.js'

const SID = (n: number) => `agnes:local:default:cli:dm:s${n}`
const OTHER = 'agnes:local:default:cli:session:other'
const REFUSED = 'Turn or queued prompt pending'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function hold() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { gate, release }
}

function gatedEndpoint(opts: { holdOpen?: boolean; refuseT2?: boolean } = {}) {
  let sessions = 0
  let s1Prompts = 0
  const turn = hold()
  const opening = hold()
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', async () => {
      const sessionId = SID(++sessions)
      // The first session/new is the app's own session; later ones come from /new.
      if (opts.holdOpen && sessions > 1) await opening.gate
      return { sessionId }
    })
    .on('session/load', async () => {
      if (opts.holdOpen) await opening.gate
      return {}
    })
    .on('_agnes/v1/session.list', () => ({
      items: [
        {
          sessionId: SID(1),
          createdAt: '2026-09-17T02:00:00Z',
          lastSeq: 0,
          generation: 1,
          preset: 'standard',
        },
        {
          sessionId: OTHER,
          createdAt: '2026-09-16T02:00:00Z',
          lastSeq: 0,
          generation: 1,
          preset: 'standard',
          title: 'Other work',
        },
      ],
    }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', (params) => ({
      sessionId: (params as { sessionId: string }).sessionId,
      upto: 0,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [],
    }))
    .on('session/prompt', async (params) => {
      const p = params as { sessionId: string; prompt: Array<{ text?: string }> }
      // Only the very first prompt on s1 is held open: it is the "turn in flight".
      if (p.sessionId === SID(1) && ++s1Prompts === 1) await turn.gate
      // Refused before it is recorded, so the TUI keeps it queued and retries (M-08).
      if (opts.refuseT2 && p.prompt[0]?.text === 't2') throw rpcError('SESSION_BUSY', {})
      return { stopReason: 'end_turn' }
    })
  const count = (method: string) => endpoint.calls.filter((call) => call.method === method).length
  const prompts = () =>
    endpoint.calls
      .filter((call) => call.method === 'session/prompt')
      .map((call) => {
        const p = call.params as { sessionId: string; prompt: Array<{ type: string; text?: string }> }
        return { sessionId: p.sessionId, text: p.prompt.map((b) => b.text ?? '').join('') }
      })
  const cancels = () =>
    endpoint.calls
      .filter((call) => call.method === 'session/cancel')
      .map((call) => (call.params as { sessionId: string }).sessionId)
  return { endpoint, release: turn.release, releaseOpen: opening.release, count, prompts, cancels }
}

async function withApp(
  e: ReturnType<typeof gatedEndpoint>,
  body: (app: TuiApp, term: FakeTerminal) => Promise<void>,
) {
  const client = createClient({ transport: { kind: 'inproc', endpoint: e.endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    await body(app, term)
  } finally {
    await app?.stop()
    await client.close()
    await e.endpoint.close()
  }
}

async function startTurn(e: ReturnType<typeof gatedEndpoint>, app: TuiApp, term: FakeTerminal) {
  term.feed('t1')
  term.feed('\r')
  await vi.waitFor(() => expect(e.prompts()).toHaveLength(1))
  expect(app.busy).toBe(true)
}

const screen = async (term: FakeTerminal) => (await screenOf(term, 80, 24)).join('\n')

async function scenario(opts: { switchSession: boolean; ctrlC: boolean }) {
  const e = gatedEndpoint()
  let seen = { prompts: e.prompts(), cancels: e.cancels() }
  await withApp(e, async (app, term) => {
    await startTurn(e, app, term)
    term.feed('t2')
    term.feed('\r') // queued locally behind t1
    // The editor's own entry for a slash line; it settles once the switch is applied or refused.
    if (opts.switchSession) await app.command('/new')
    if (opts.ctrlC) {
      term.feed('\x03')
      await vi.waitFor(() => expect(e.cancels().length).toBeGreaterThanOrEqual(1))
    }
    e.release()
    await vi.waitFor(() => expect(e.prompts().length).toBeGreaterThanOrEqual(2))
    await vi.waitFor(() => expect(app.busy).toBe(false))
    await sleep(200)
    seen = { prompts: e.prompts(), cancels: e.cancels() }
  })
  return seen
}

it('[control] without a session switch, Ctrl-C and the queued prompt both target s1', async () => {
  const seen = await scenario({ switchSession: false, ctrlC: true })
  expect(seen.cancels).toEqual([SID(1)])
  expect(seen.prompts).toEqual([
    { sessionId: SID(1), text: 't1' },
    { sessionId: SID(1), text: 't2' },
  ])
})

it('[M-02a] Ctrl-C after /new while the s1 turn is in flight cancels that turn, not a new session', async () => {
  const seen = await scenario({ switchSession: true, ctrlC: true })
  expect(seen.cancels, JSON.stringify(seen)).toEqual([SID(1)])
})

it('[M-02b] a prompt queued against s1 is sent to s1, not to a session created by /new', async () => {
  const seen = await scenario({ switchSession: true, ctrlC: false })
  expect(seen.prompts, JSON.stringify(seen)).toEqual([
    { sessionId: SID(1), text: 't1' },
    { sessionId: SID(1), text: 't2' },
  ])
})

it('[M-02] /new during the turn says why it stays put, opens nothing, and switches once idle', async () => {
  const e = gatedEndpoint()
  await withApp(e, async (app, term) => {
    await startTurn(e, app, term)
    const before = e.endpoint.calls.length
    for (const line of ['/new', `/resume ${OTHER}`, '/rewind 1']) {
      await app.command(line)
      expect(app.session.id, line).toBe(SID(1))
    }
    await vi.waitFor(async () => expect(await screen(term)).toContain(REFUSED))
    // No session was created, listed, loaded or forked: only the open turn's projection keeps polling.
    const opened = e.endpoint.calls.slice(before).filter((call) => !call.method.includes('projectUI'))
    expect(opened.map((call) => call.method)).toEqual([])
    e.release()
    await vi.waitFor(() => expect(app.busy).toBe(false))
    await app.command('/new')
    expect(app.session.id).toBe(SID(2))
  })
})

it('[M-02] the picker still opens during the turn, but a choice is refused before it loads', async () => {
  const e = gatedEndpoint()
  await withApp(e, async (app, term) => {
    await startTurn(e, app, term)
    term.feed('/resume')
    term.feed('\r')
    await vi.waitFor(async () => expect(await screen(term)).toContain('Other work'))
    term.feed('\r')
    await vi.waitFor(async () => expect(await screen(term)).toContain(REFUSED))
    expect(app.session.id).toBe(SID(1))
    expect(e.count('session/load')).toBe(0)
    e.release()
  })
})

it('[M-02c] a prompt submitted while /new waits on the daemon keeps the TUI on s1', async () => {
  const e = gatedEndpoint({ holdOpen: true })
  await withApp(e, async (app, term) => {
    const switching = app.command('/new')
    await vi.waitFor(() => expect(e.count('session/new')).toBe(2))
    await startTurn(e, app, term)
    e.releaseOpen()
    await switching
    expect(app.session.id).toBe(SID(1))
    await vi.waitFor(async () => expect(await screen(term)).toContain(REFUSED))
    term.feed('\x03')
    await vi.waitFor(() => expect(e.cancels()).toEqual([SID(1)]))
    e.release()
  })
})

it('[M-02c] a prompt submitted while a picked session loads keeps the TUI on s1', async () => {
  const e = gatedEndpoint({ holdOpen: true })
  await withApp(e, async (app, term) => {
    term.feed('/resume')
    term.feed('\r')
    await vi.waitFor(async () => expect(await screen(term)).toContain('Other work'))
    term.feed('\r')
    await vi.waitFor(() => expect(e.count('session/load')).toBe(1))
    await startTurn(e, app, term)
    e.releaseOpen()
    await vi.waitFor(async () => expect(await screen(term)).toContain(REFUSED))
    expect(app.session.id).toBe(SID(1))
    expect(await screen(term)).not.toContain('Resumed')
    e.release()
  })
})

it('[M-02d] a queued prompt the daemon keeps refusing still holds the switch while no turn runs', async () => {
  const e = gatedEndpoint({ refuseT2: true })
  await withApp(e, async (app, term) => {
    await startTurn(e, app, term)
    term.feed('t2')
    term.feed('\r')
    e.release()
    await vi.waitFor(() =>
      expect(e.prompts().filter((p) => p.text === 't2').length).toBeGreaterThanOrEqual(1),
    )
    await app.command('/new')
    expect(app.session.id).toBe(SID(1))
    expect(e.count('session/new')).toBe(1)
    await sleep(250)
    expect(e.prompts().filter((p) => p.sessionId !== SID(1))).toEqual([])
  })
})

it('[preserve] an idle session picker choice still switches and reports it', async () => {
  const e = gatedEndpoint()
  await withApp(e, async (app, term) => {
    term.feed('/resume')
    term.feed('\r')
    await vi.waitFor(async () => expect(await screen(term)).toContain('Other work'))
    term.feed('\r')
    await vi.waitFor(() => expect(app.session.id).toBe(OTHER))
    await vi.waitFor(async () => expect(await screen(term)).toContain(`Resumed ${OTHER}`))
  })
})

it('[preserve] commands that do not switch sessions still run during the turn', async () => {
  const e = gatedEndpoint()
  await withApp(e, async (app, term) => {
    await startTurn(e, app, term)
    expect((await runSlash(app, '/help')).text).toContain('/new')
    e.release()
  })
})

// Second, independent dynamic source: real SDK + local daemon endpoint + core + test host, with a
// provider whose first inference is slow and abortable. Observation is the durable ledger projection
// of each session, not RPC call records.
function countingProvider(firstDelayMs: number, onCall: (n: number) => void) {
  let calls = 0
  return {
    models: () => [],
    async *infer(req: RequestBody, opts: { signal: AbortSignal; toolNames: string[] }) {
      const n = ++calls
      onCall(n)
      yield {
        type: 'sent' as const,
        stamp: stampFor(req),
      }
      if (n === 1 && !opts.signal.aborted)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, firstDelayMs)
          opts.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      if (opts.signal.aborted) {
        yield {
          type: 'error' as const,
          reason: 'aborted' as const,
          code: 'ABORTED' as const,
          message: 'aborted',
          retryable: false,
        }
        return
      }
      yield { type: 'text_delta' as const, delta: `reply ${n}` }
      yield { type: 'done' as const, reason: 'stop' as const }
    },
  }
}

async function realScenario(switchSession: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dbh-m02-real-'))
  let started = 0
  const { host } = await createTestHost({
    dataDir: dir,
    provider: countingProvider(1_500, (n) => {
      started = n
    }),
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  // /new opens the fresh session at process.cwd(); the test host only trusts its dataDir.
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const s1 = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session: s1, term, header: 'Agnes' })
    await app.start()
    term.feed('t1')
    term.feed('\r')
    await vi.waitFor(() => expect(started).toBe(1))
    term.feed('t2')
    term.feed('\r')
    if (switchSession) await app.command('/new')
    const s2 = app.session
    // Let the slow s1 turn finish on its own and the queue drain.
    await vi.waitFor(() => expect(started).toBe(2), { timeout: 6_000 })
    await vi.waitFor(() => expect(app?.busy).toBe(false), { timeout: 6_000 })
    const users = async (s: typeof s1) =>
      (await s.projectUI()).nodes
        .filter((node) => node.kind === 'user')
        .flatMap((node) => (node.kind === 'user' ? node.content : []))
        .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    return { s1: await users(s1), s2: s2.id === s1.id ? [] : await users(s2), s1Id: s1.id, s2Id: s2.id }
  } finally {
    cwd.mockRestore()
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

it('[control/real] without a switch the queued prompt lands in s1 ledger', async () => {
  const seen = await realScenario(false)
  expect(seen.s1).toEqual(['t1', 't2'])
}, 15_000)

it('[M-02b/real] a prompt queued against s1 lands in the s1 ledger, not in a /new session', async () => {
  const seen = await realScenario(true)
  expect(seen.s2, JSON.stringify(seen)).not.toContain('t2')
  expect(seen.s1, JSON.stringify(seen)).toEqual(['t1', 't2'])
}, 15_000)
