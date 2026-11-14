import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store } from '../../src/app/store.js'
import { childEnvironment } from '../../src/app/subprocess.js'
import type { Thread } from '../../src/core/index.js'
import { KV } from '../../src/kv.js'
import { createHookStateCell, type HookState } from '../../src/runtime/hook-state.js'
import { DATABASE_FILE } from '../../src/runtime/index.js'
import { createLifecycle, type LifecycleDeps, sessionsOnly } from '../../src/runtime/lifecycle.js'
import { SetupError } from '../../src/setup.js'
import {
  AT,
  type FakeSession,
  fakeApp,
  fakeControl,
  fakeSessions,
  later,
  ORCHESTRATOR,
  runningTicket,
  workerKey,
} from './lifecycle-fakes.js'

const DAY = 24 * 3600_000
let directory: string
let store: Store
let log: string[]
let sessions: Map<string, FakeSession>
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sa-lifecycle-'))
  store = openStore(join(directory, DATABASE_FILE))
  log = []
  sessions = new Map()
})
afterEach(() => {
  vi.useRealTimers()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const plan = {
  stateDir: '/state',
  account: { login: 'agent-bot', email: 'a@example.invalid', blocked: [] },
}
function setup(overrides: { [K in keyof LifecycleDeps]?: LifecycleDeps[K] | undefined } = {}) {
  const hooks = createHookStateCell()
  const app = fakeApp(log, () => [...sessions.keys()])
  const seenByReconcile: boolean[] = []
  const adapter = fakeSessions(log, sessions)
  const state = adapter.state
  // Whether the hooks already saw a Session as Superagent's while the reconcile read it.
  adapter.state = (id) => {
    seenByReconcile.push(hooks.get().isSuperagentSession(id))
    return state(id)
  }
  const archive = vi.fn((_store: Store, _now: number) => ({ archived: 0 }))
  const deps: LifecycleDeps = {
    store,
    sessions: adapter,
    control: fakeControl(log, sessions),
    hooks,
    hookState: sessionsOnly,
    environment: async () => {
      log.push('environment')
      return plan
    },
    createApp: () => {
      log.push('createApp')
      return app
    },
    writeEnvironment: async (home, shims, cfg) => {
      log.push(`write ${home} ${shims} ${cfg.ghConfigDir}`)
    },
    verifyEnvironment: async (home, shims, cfg) => {
      log.push(`verify ${home} ${shims} ${cfg.login}`)
    },
    archive,
    now: () => Date.parse(AT),
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete (deps as unknown as Record<string, unknown>)[name]
    else (deps as unknown as Record<string, unknown>)[name] = value
  }
  return { lifecycle: createLifecycle(deps), hooks, app, archive, seenByReconcile }
}

describe('enable', () => {
  it('returns from start() first, then writes and checks the environment, starts the app, reconciles and only then registers the sessions', async () => {
    sessions.set(ORCHESTRATOR, { running: false, pending: [], jobs: 0 })
    const { lifecycle, hooks, seenByReconcile } = setup()
    await lifecycle.start()
    expect(log, 'nothing ran before start() returned').toEqual([])
    expect(lifecycle.status().state).toBe('starting')
    await lifecycle.settled()
    expect(log.slice(0, 5)).toEqual([
      'environment',
      // The agent HOME and the shims sit where the daemon's launch environment names them.
      'write /state/home /state/worker-bin /state/home/.config/gh',
      'verify /state/home /state/worker-bin agent-bot',
      'createApp',
      'app.start',
    ])
    expect(seenByReconcile, 'the hooks saw no Superagent session during the reconcile').toEqual([false])
    expect(hooks.get().isSuperagentSession(ORCHESTRATOR)).toBe(true)
    expect(hooks.get().isSuperagentSession(`${ORCHESTRATOR}/01CHILD`), 'a child session is one too').toBe(
      true,
    )
    expect(hooks.get().isSuperagentSession('superagent:worker:owner-made')).toBe(false)
    expect(lifecycle.status()).toEqual({ state: 'running' })
    // The runtime's own commands run with the agent HOME and gh configuration until it stops.
    expect(childEnvironment()).toMatchObject({ HOME: '/state/home', GH_CONFIG_DIR: '/state/home/.config/gh' })
    await lifecycle.stop('shutdown')
    expect(childEnvironment().HOME).toBe(process.env.HOME)
  })

  it('reconciles by the real session state: a running turn is left alone, an aborted one is re-dispatched once after its superseded inputs are dropped, a queued input resumes once', async () => {
    // A: its turn still runs — nothing is re-dispatched or sent again.
    store.tickets.save(runningTicket('A'))
    sessions.set(workerKey('A'), {
      running: true,
      pending: [{ itemId: 'a1', commandId: 'superagent:m-a' }],
      jobs: 1,
    })
    // B: its turn was aborted mid-work; the input queued behind it is superseded by the re-dispatch, the owner's is not.
    store.tickets.save(
      runningTicket('B', { deliveredAt: later(5), report: { state: 'progress', summary: '', at: later(1) } }),
    )
    sessions.set(workerKey('B'), {
      running: false,
      pending: [
        { itemId: 'b1', commandId: 'superagent:m-b' },
        { itemId: 'b2', commandId: 'owner-typed' },
      ],
      jobs: 0,
    })
    // C: it had reported waiting and nothing reached it since; its queued input only needs to run.
    store.tickets.save(
      runningTicket('C', { deliveredAt: later(1), report: { state: 'waiting', summary: '', at: later(2) } }),
    )
    sessions.set(workerKey('C'), {
      running: false,
      pending: [
        { itemId: 'c1', commandId: 'superagent:m-c1' },
        { itemId: 'c2', commandId: 'superagent:m-c2' },
      ],
      jobs: 0,
    })
    // The main Session: an input queued before the restart.
    sessions.set(ORCHESTRATOR, {
      running: false,
      pending: [{ itemId: 'o1', commandId: 'superagent:m-o' }],
      jobs: 0,
    })
    store.set(KV.runtime.paused, {
      at: AT,
      reason: 'disable',
      assignments: [{ ticketId: 'B', assignmentId: 'a-B' }],
    })

    const { lifecycle } = setup()
    await lifecycle.start()
    await lifecycle.settled()
    const reconcile = log.filter(
      (line) => !line.startsWith('state') && log.indexOf(line) > log.indexOf('app.start'),
    )
    expect(reconcile).toEqual([
      'drop superagent:worker:B b1',
      'interrupted B a-B',
      'sendNow superagent:worker:C c1',
      'sendNow superagent:orchestrator o1',
    ])
    expect(sessions.get(workerKey('B'))!.pending.map((item) => item.itemId)).toEqual(['b2'])
    expect(store.get(KV.runtime.paused), 'the pause ends with the reconcile').toBeUndefined()
  })

  it('reports setup required and opens no session when the configuration is incomplete', async () => {
    sessions.set(ORCHESTRATOR, { running: false, pending: [], jobs: 0 })
    const { lifecycle, hooks, archive } = setup({
      environment: async () => {
        log.push('environment')
        throw new SetupError('repositoryUnset')
      },
    })
    await lifecycle.start()
    await lifecycle.settled()
    expect(log).toEqual(['environment'])
    expect(lifecycle.status()).toMatchObject({ state: 'setupRequired', problem: { code: 'repositoryUnset' } })
    expect(hooks.get().isSuperagentSession(ORCHESTRATOR)).toBe(false)
    expect(archive).not.toHaveBeenCalled()
    await lifecycle.stop('disable')
    expect(log).toEqual(['environment'])
    expect(lifecycle.status()).toEqual({ state: 'stopped' })
  })

  it('reports a failed self-check and opens no session', async () => {
    const { lifecycle } = setup({
      verifyEnvironment: async () => {
        throw new SetupError('agentLoginMismatch', { account: 'operator', login: 'agent-bot' })
      },
    })
    await lifecycle.start()
    await lifecycle.settled()
    expect(lifecycle.status()).toMatchObject({
      state: 'setupFailed',
      problem: { code: 'agentLoginMismatch' },
    })
    expect(log).not.toContain('createApp')
  })

  it('starts from an empty database and never reads a DSH Superagent database beside it', async () => {
    const legacyPath = join(directory, 'orchestrator.sqlite')
    const legacy = openStore(legacyPath)
    legacy.tickets.save(runningTicket('DSH-1'))
    legacy.close()
    const digest = () => createHash('sha256').update(readFileSync(legacyPath)).digest('hex')
    const before = digest()
    const { lifecycle } = setup()
    await lifecycle.start()
    await lifecycle.settled()
    expect(lifecycle.status()).toEqual({ state: 'running' })
    expect(store.tickets.list()).toEqual([])
    expect(log.filter((line) => /interrupted|sendNow|drop/.test(line))).toEqual([])
    expect(digest()).toBe(before)
  })
})

describe('disable', () => {
  it('mid-turn: stops polling and sending first, drops pending inputs, cancels the turn and kills agent jobs, records the pause, then clears the hooks', async () => {
    store.tickets.save(runningTicket('A'))
    // The cancel returns a steer to the inbox; it is dropped as well.
    sessions.set(workerKey('A'), {
      running: true,
      pending: [{ itemId: 'q1', commandId: 'superagent:m-1' }],
      jobs: 2,
      onCancel: () =>
        sessions.get(workerKey('A'))!.pending.push({ itemId: 's1', commandId: 'superagent:m-2' }),
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { lifecycle, hooks, app, archive } = setup()
    await lifecycle.start()
    await lifecycle.settled()
    app.poll()
    expect(app.polls).toBe(1)
    log.length = 0

    await lifecycle.stop('disable')
    expect(log).toEqual([
      'app.stopSignal disable',
      `state ${workerKey('A')}`,
      `drop ${workerKey('A')} q1`,
      `cancel ${workerKey('A')}`,
      `kill ${workerKey('A')}`,
      `state ${workerKey('A')}`,
      `drop ${workerKey('A')} s1`,
      'app.drain',
    ])
    expect(sessions.get(workerKey('A'))).toMatchObject({ running: false, pending: [], jobs: 0 })
    expect(store.get(KV.runtime.paused)).toEqual({
      at: AT,
      reason: 'disable',
      assignments: [{ ticketId: 'A', assignmentId: 'a-A' }],
    })
    expect(hooks.get().isSuperagentSession(workerKey('A'))).toBe(false)
    expect(lifecycle.status()).toEqual({ state: 'stopped' })

    // Afterwards: no poll, no send, no archive run, nothing at all.
    app.poll()
    const runs = archive.mock.calls.length
    vi.advanceTimersByTime(3 * DAY)
    expect(app.polls).toBe(1)
    expect(archive.mock.calls.length).toBe(runs)
    expect(log).toHaveLength(8)
  })

  it('drops the queued inputs of every session, which stay untaken in the store and are re-delivered after enable', async () => {
    const ticket = runningTicket(
      'A',
      { deliveredAt: later(3), report: { state: 'waiting', summary: '', at: later(1) } },
      {
        inputs: [
          { id: 'in-1', kind: 'trigger', triggerId: 't1', at: later(2), readAt: null, deliveredTo: 'a-A' },
        ],
      },
    )
    store.tickets.save(ticket)
    sessions.set(workerKey('A'), {
      running: false,
      pending: [{ itemId: 'q1', commandId: 'superagent:in-1' }],
      jobs: 0,
    })
    sessions.set(ORCHESTRATOR, { running: false, pending: [{ itemId: 'o1' }, { itemId: 'o2' }], jobs: 0 })
    const first = setup()
    // Nothing queued runs while the runtime starts: the reconcile resumes only what it does not re-dispatch.
    await first.lifecycle.start()
    await first.lifecycle.settled()
    sessions.get(ORCHESTRATOR)!.running = false
    sessions.get(ORCHESTRATOR)!.pending = [{ itemId: 'o3' }]
    sessions.get(workerKey('A'))!.pending = [{ itemId: 'q2', commandId: 'superagent:in-1' }]
    await first.lifecycle.stop('generation')
    expect([...sessions.values()].map((session) => session.pending)).toEqual([[], []])
    // An owner opening the session on the web finds nothing queued that would run it by itself, and the store
    // still holds the input as delivered to the running assignment but never taken.
    expect(store.tickets.get('A')!.inputs[0]).toMatchObject({ readAt: null, deliveredTo: 'a-A' })

    log.length = 0
    const second = setup()
    await second.lifecycle.start()
    await second.lifecycle.settled()
    // The worker was busy with the dropped input, so the Engine re-dispatches it with that input put back.
    expect(log.filter((line) => /interrupted|sendNow|drop/.test(line))).toEqual(['interrupted A a-A'])
  })

  it('on a daemon shutdown cancels turns and kills jobs but keeps queued inputs for the restart to resume', async () => {
    sessions.set(ORCHESTRATOR, {
      running: true,
      pending: [{ itemId: 'o1', commandId: 'superagent:m' }],
      jobs: 1,
    })
    const { lifecycle } = setup()
    await lifecycle.start()
    await lifecycle.settled()
    log.length = 0
    await lifecycle.stop('shutdown')
    expect(log).toEqual([
      'app.stopSignal shutdown',
      `state ${ORCHESTRATOR}`,
      `cancel ${ORCHESTRATOR}`,
      `kill ${ORCHESTRATOR}`,
      'app.drain',
    ])
    expect(sessions.get(ORCHESTRATOR)!.pending).toEqual([{ itemId: 'o1', commandId: 'superagent:m' }])
  })

  it('during a start stops it before it opens anything', async () => {
    let release: () => void = () => {}
    const { lifecycle, hooks } = setup({
      environment: async () => {
        log.push('environment')
        await new Promise<void>((resolve) => (release = resolve))
        return plan
      },
    })
    await lifecycle.start()
    await vi.waitFor(() => expect(log).toEqual(['environment']))
    const stopped = lifecycle.stop('disable')
    release()
    await stopped
    expect(log).toEqual(['environment'])
    expect(hooks.get().isSuperagentSession(ORCHESTRATOR)).toBe(false)
    expect(lifecycle.status()).toEqual({ state: 'stopped' })
  })

  it('keeps going when one session cannot be stopped', async () => {
    sessions.set(workerKey('A'), { running: true, pending: [], jobs: 0 })
    sessions.set(workerKey('B'), { running: true, pending: [], jobs: 0 })
    const warnings: string[] = []
    const control = fakeControl(log, sessions)
    const { lifecycle } = setup({
      log: { warn: (message) => warnings.push(message) },
      control: {
        ...control,
        killAgentJobs: async (id) => {
          if (id === workerKey('A')) throw new Error('daemon unavailable')
          return control.killAgentJobs(id)
        },
      },
    })
    await lifecycle.start()
    await lifecycle.settled()
    await lifecycle.stop('disable')
    expect(log).toContain(`cancel ${workerKey('B')}`)
    expect(log).toContain(`kill ${workerKey('B')}`)
    expect(warnings.join('\n')).toContain('daemon unavailable')
    expect(lifecycle.status()).toEqual({ state: 'stopped' })
  })
})

describe('upkeep', () => {
  it("keeps an ended ticket's workspace and session until retention archives its conversation", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const ago = (days: number) => new Date(Date.parse(AT) - days * DAY).toISOString()
    const thread = (id: string, lastAt: string, ticketId: string): Thread => ({
      key: `github:${id}`,
      ref: { source: 'github', id },
      createdAt: lastAt,
      lastAt,
      subscriptions: [ticketId],
      correlated: [],
      pending: [],
      meta: {},
    })
    const ended = (id: string, days: number) =>
      runningTicket(
        id,
        { state: 'ended' },
        { ended: { at: ago(days), by: 'executor', outcome: 'completed' } },
      )
    // E ended 5 days ago: a person may still reply on its thread and resume it in the same session and directory.
    store.tickets.save(ended('E', 5))
    store.threads.save(thread('e', ago(5), 'E'))
    // R ended 20 days ago and its thread went quiet with it: retention archives the conversation, which retires R.
    store.tickets.save(ended('R', 20))
    store.threads.save(thread('r', ago(20), 'R'))
    // P ended 20 days ago, but a person wrote on its thread two days ago: the conversation stays, and so does P.
    store.tickets.save(ended('P', 20))
    store.threads.save(thread('p', ago(2), 'P'))
    store.tickets.save(runningTicket('O'))
    sessions.set(workerKey('E'), { running: false, pending: [], jobs: 0 })
    let now = Date.parse(AT)
    const { lifecycle } = setup({ archive: undefined, now: () => now })
    await lifecycle.start()
    await lifecycle.settled()
    const removals = () => log.filter((line) => line.startsWith('removeWorkspaces'))
    expect(removals()).toEqual(['removeWorkspaces /work/R'])
    expect(store.threads.get('github:e'), 'the ended ticket keeps its thread').toBeDefined()

    // Ending a ticket removes nothing.
    await lifecycle.ticketEnded('E')
    store.tickets.save({ ...store.tickets.get('O')!, ended: { at: AT, by: 'human', outcome: 'stopped' } })
    await lifecycle.ticketEnded('O')
    expect(removals()).toEqual(['removeWorkspaces /work/R'])

    // Ten days on, the daily pass archives E's conversation, quiet for 15 days, and only then retires E's workspace
    // and session; P's conversation (quiet for 12 days) and O (ended 10 days ago) stay.
    now += 10 * DAY
    vi.advanceTimersByTime(DAY)
    await vi.waitFor(() => expect(removals()).toHaveLength(2))
    expect(removals()[1]).toBe('removeWorkspaces /work/E')
    expect(store.threads.get('github:e')).toBeUndefined()
    expect(store.threads.get('github:p'), 'a conversation with recent activity is kept').toBeDefined()
    await lifecycle.stop('shutdown')
  })

  it('archives expired records on start and then once a day while running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let now = Date.parse(AT)
    const { lifecycle, archive } = setup({ now: () => now })
    await lifecycle.start()
    await lifecycle.settled()
    expect(archive.mock.calls).toEqual([[store, Date.parse(AT)]])
    now += DAY
    vi.advanceTimersByTime(DAY - 1)
    expect(archive).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(archive).toHaveBeenCalledTimes(2)
    expect(archive.mock.calls[1]).toEqual([store, Date.parse(AT) + DAY])
    vi.advanceTimersByTime(DAY)
    expect(archive).toHaveBeenCalledTimes(3)
    await lifecycle.stop('disable')
    vi.advanceTimersByTime(5 * DAY)
    expect(archive).toHaveBeenCalledTimes(3)
  })

  it('archives with the store retention rules by default', async () => {
    const { lifecycle } = setup({ archive: undefined })
    await lifecycle.start()
    await lifecycle.settled()
    // The retention tables exist once an archive pass ran.
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_archive'")
      .all()
      .map((row) => String(row.name))
    expect(tables.sort()).toEqual(['decision_archive', 'thread_archive', 'trigger_archive'])
    await lifecycle.stop('shutdown')
  })
})

describe('the hooks snapshot', () => {
  it('counts only the registered sessions and their children as Superagent sessions', () => {
    const state: HookState = sessionsOnly(new Set(['superagent:worker:T']))
    expect(state.isSuperagentSession('superagent:worker:T')).toBe(true)
    expect(state.isSuperagentSession('superagent:worker:T/01ABC/01DEF')).toBe(true)
    expect(state.isSuperagentSession('superagent:worker:T2')).toBe(false)
    expect(
      state.guardTool({ sessionId: 'superagent:worker:T', toolName: 'shell', input: {} }),
    ).toBeUndefined()
    expect(state.promptSections('superagent:worker:T')).toEqual({ stable: [] })
  })
})
