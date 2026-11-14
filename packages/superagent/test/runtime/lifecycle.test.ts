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
const setupTaken = () => new SetupError('sessionTaken', { session: ORCHESTRATOR }).problem
/** A refusal of every stored Superagent session for `reason`, standing in for the app's own. */
const refusingState = (reason: string): HookState => ({
  isSuperagentSession: (id) => id.startsWith('superagent:'),
  promptSections: () => ({ stable: [] }),
  guardTool: () => reason,
})
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
  /** What the hooks make of a session: not Superagent's, Superagent's but refused, or Superagent's and guarded. */
  const kindOf = (id: string) => {
    const state = hooks.get()
    if (!state.isSuperagentSession(id)) return 'inert'
    return state.guardTool({ sessionId: id, toolName: 'shell', input: {} }) === undefined ? 'real' : 'deny'
  }
  // The hooks' view of a Session while the reconcile reads it, and while it acts on it.
  const seenByReconcile: string[] = []
  const seenAtAct: string[] = []
  const adapter = fakeSessions(log, sessions)
  const control = fakeControl(log, sessions)
  const { state, dropPending } = adapter
  adapter.state = (id) => {
    seenByReconcile.push(kindOf(id))
    return state(id)
  }
  adapter.dropPending = (id, items) => {
    seenAtAct.push(`drop ${kindOf(id)}`)
    return dropPending(id, items)
  }
  const { sendNow } = control
  control.sendNow = (id, item) => {
    seenAtAct.push(`sendNow ${kindOf(id)}`)
    return sendNow(id, item)
  }
  const { assignmentInterrupted } = app.engine
  ;(app as { engine: typeof app.engine }).engine = {
    assignmentInterrupted(ticketId, assignmentId) {
      seenAtAct.push(`interrupted ${kindOf(workerKey(ticketId))}`)
      assignmentInterrupted(ticketId, assignmentId)
    },
  }
  const archive = vi.fn((_store: Store, _now: number) => ({ archived: 0 }))
  const deps: LifecycleDeps = {
    store,
    sessions: adapter,
    control,
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
  return { lifecycle: createLifecycle(deps), hooks, app, archive, seenByReconcile, seenAtAct }
}

describe('enable', () => {
  it('returns from start() first, refuses the sessions while it writes and checks the environment, starts the app and reads them, and guards them before it acts', async () => {
    sessions.set(ORCHESTRATOR, { running: false, pending: [], jobs: 0 })
    store.tickets.save(
      runningTicket('T', { state: 'ended' }, { ended: { at: AT, by: 'human', outcome: 'stopped' } }),
    )
    const { lifecycle, hooks, seenByReconcile } = setup()
    await lifecycle.start()
    expect(log, 'nothing ran before start() returned').toEqual([])
    expect(lifecycle.status().state).toBe('starting')
    // From the start, the store's Superagent sessions are refused with a reason; the owner's own are not touched.
    for (const id of [ORCHESTRATOR, workerKey('T'), `${workerKey('T')}/01CHILD`])
      expect(hooks.get().guardTool({ sessionId: id, toolName: 'shell', input: {} }), id).toMatch(
        /Superagent is starting/,
      )
    expect(hooks.get().isSuperagentSession('owner-session')).toBe(false)
    await lifecycle.settled()
    expect(log.slice(0, 5)).toEqual([
      'environment',
      // The agent HOME and the shims sit where the daemon's launch environment names them.
      'write /state/home /state/worker-bin /state/home/.config/gh',
      'verify /state/home /state/worker-bin agent-bot',
      'createApp',
      'app.start',
    ])
    expect(seenByReconcile, 'the reconcile reads while the sessions are refused').toEqual(['deny'])
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

    const { lifecycle, seenByReconcile, seenAtAct } = setup()
    await lifecycle.start()
    await lifecycle.settled()
    // The guarded snapshot is in place after the reads and before any session is acted on.
    expect(seenByReconcile).toEqual(['deny', 'deny', 'deny', 'deny'])
    expect(seenAtAct).toEqual(['drop real', 'interrupted real', 'sendNow real', 'sendNow real'])
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
    // Superagent's sessions stay refused, with the setup problem as the reason; the owner's are not touched.
    expect(hooks.get().guardTool({ sessionId: ORCHESTRATOR, toolName: 'shell', input: {} })).toMatch(
      /Superagent is not set up: The GitHub Source names no repository/,
    )
    expect(hooks.get().isSuperagentSession('owner-session')).toBe(false)
    expect(archive).not.toHaveBeenCalled()
    await lifecycle.stop('disable')
    expect(log).toEqual(['environment'])
    expect(lifecycle.status()).toEqual({ state: 'stopped' })
  })

  it('reports a failed self-check, opens no session and keeps refusing the existing ones', async () => {
    store.tickets.save(runningTicket('T'))
    const { lifecycle, hooks } = setup({
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
    // An existing worker session cannot be used while the daemon may act as the operator.
    expect(hooks.get().guardTool({ sessionId: workerKey('T'), toolName: 'shell', input: {} })).toMatch(
      /Superagent cannot start: gh acts as @operator, not the agent account @agent-bot/,
    )
    expect(
      hooks.get().guardTool({ sessionId: 'owner-session', toolName: 'shell', input: {} }),
    ).toBeUndefined()
    expect(hooks.get().isSuperagentSession('owner-session')).toBe(false)
  })

  it('reports a started app that waits for setup, reconciles nothing until it is set up, and reconciles once a recheck has set it up', async () => {
    // A session with a queued input and no assignment to restart: its reconcile runs the input.
    sessions.set(workerKey('A'), { running: false, pending: [{ itemId: 'q1' }], jobs: 0 })
    let problem: ReturnType<typeof setupTaken> | undefined = setupTaken()
    const refusals: string[] = []
    const { lifecycle, app, hooks } = setup({
      startingState: () => {
        refusals.push('starting')
        return refusingState('starting')
      },
      refusingState: (reason) => {
        refusals.push(reason)
        return refusingState(reason)
      },
    })
    Object.assign(app, {
      setupProblem: () => problem,
      reconfigure: async () => {
        log.push('app.reconfigure')
        problem = undefined
      },
    })
    await lifecycle.start()
    await lifecycle.settled()
    expect(lifecycle.status()).toEqual({ state: 'setupFailed', problem })
    expect(log, 'no session was read or resumed').not.toContain(`state ${workerKey('A')}`)
    expect(refusals.at(-1)).toMatch(/^Superagent cannot start: A session superagent:orchestrator exists/)
    expect(hooks.get().guardTool({ sessionId: workerKey('A'), toolName: 'shell', input: {} })).toMatch(
      /cannot start/,
    )

    lifecycle.recheck()
    expect(refusals.at(-1), 'refused as starting again at once').toBe('starting')
    await lifecycle.settled()
    expect(
      log.filter((line) => line === 'app.start'),
      'the app starts once',
    ).toHaveLength(1)
    expect(log).toContain('app.reconfigure')
    expect(log).toContain(`sendNow ${workerKey('A')} q1`)
    expect(lifecycle.status()).toEqual({ state: 'running' })
  })

  it('runs a start that waited for setup again on a recheck, from the agent environment on, and ignores a recheck while it starts', async () => {
    let unset = true
    const { lifecycle } = setup({
      environment: async () => {
        log.push('environment')
        if (unset) throw new SetupError('repositoryUnset')
        return plan
      },
    })
    await lifecycle.start()
    await lifecycle.settled()
    expect(lifecycle.status().state).toBe('setupRequired')
    unset = false
    lifecycle.recheck()
    lifecycle.recheck()
    await lifecycle.settled()
    expect(log.filter((line) => line === 'environment')).toHaveLength(2)
    expect(log.filter((line) => line === 'app.start')).toHaveLength(1)
    expect(lifecycle.status()).toEqual({ state: 'running' })
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
    // The first cancel returns a steer to the inbox; it is dropped as well.
    let handedBack = false
    sessions.set(workerKey('A'), {
      running: true,
      pending: [{ itemId: 'q1', commandId: 'superagent:m-1' }],
      jobs: 2,
      onCancel: () => {
        if (!handedBack)
          sessions.get(workerKey('A'))!.pending.push({ itemId: 's1', commandId: 'superagent:m-2' })
        handedBack = true
      },
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
      // Another pass: the returned steer is dropped, and the turn and jobs are stopped again.
      `state ${workerKey('A')}`,
      `drop ${workerKey('A')} s1`,
      `cancel ${workerKey('A')}`,
      `kill ${workerKey('A')}`,
      // The last pass finds the session quiet, and a last sweep finds no job the turn started winding down.
      `state ${workerKey('A')}`,
      `kill ${workerKey('A')}`,
      'app.drain',
    ])
    expect(sessions.get(workerKey('A'))).toMatchObject({ running: false, pending: [], jobs: 0 })
    expect(store.get(KV.runtime.paused)).toEqual({
      at: AT,
      reason: 'disable',
      assignments: [{ ticketId: 'A', assignmentId: 'a-A' }],
      // Every session was stopped and confirmed quiet.
      stop: { ms: expect.any(Number), sessions: 1, unstopped: [] },
    })
    expect(hooks.get().isSuperagentSession(workerKey('A'))).toBe(false)
    expect(lifecycle.status()).toEqual({ state: 'stopped' })

    // Afterwards: no poll, no send, no archive run, nothing at all.
    app.poll()
    const runs = archive.mock.calls.length
    vi.advanceTimersByTime(3 * DAY)
    expect(app.polls).toBe(1)
    expect(archive.mock.calls.length).toBe(runs)
    expect(log).toHaveLength(12)
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
      `state ${ORCHESTRATOR}`,
      `kill ${ORCHESTRATOR}`,
      'app.drain',
    ])
    expect(sessions.get(ORCHESTRATOR)!.pending).toEqual([{ itemId: 'o1', commandId: 'superagent:m' }])
  })

  it('stops a turn the follow-up runner starts from a steer the cancel handed back, and a parked turn', async () => {
    let cancels = 0
    sessions.set(workerKey('A'), {
      running: true,
      pending: [],
      jobs: 1,
      // The first cancel hands a steer back, which the daemon starts at once as a new turn with a new job.
      onCancel: () => {
        cancels++
        if (cancels === 1) Object.assign(sessions.get(workerKey('A'))!, { running: true, jobs: 1 })
      },
    })
    // A turn parked on an approval reads as not running; it is cancelled all the same.
    sessions.set(workerKey('P'), { running: false, pending: [], jobs: 0 })
    const { lifecycle } = setup()
    await lifecycle.start()
    await lifecycle.settled()
    log.length = 0
    await lifecycle.stop('disable')
    expect(sessions.get(workerKey('A'))).toMatchObject({ running: false, pending: [], jobs: 0 })
    expect(log.filter((line) => line === `cancel ${workerKey('A')}`)).toHaveLength(2)
    // Two passes, then the last sweep.
    expect(log.filter((line) => line === `kill ${workerKey('A')}`)).toHaveLength(3)
    expect(log).toContain(`cancel ${workerKey('P')}`)
  })

  it('gives up on a session that keeps running when the budget ends, after a last sweep, and says so', async () => {
    sessions.set(workerKey('A'), {
      running: true,
      pending: [],
      jobs: 0,
      onCancel: () => {
        sessions.get(workerKey('A'))!.running = true
      },
    })
    const warnings: string[] = []
    const { lifecycle } = setup({ log: { warn: (text) => warnings.push(text) }, stopBudgetMs: 800 })
    await lifecycle.start()
    await lifecycle.settled()
    log.length = 0
    const began = Date.now()
    await lifecycle.stop('disable')
    // Passes a pause apart for the whole budget, not a fixed count.
    expect(Date.now() - began).toBeGreaterThanOrEqual(500)
    expect(log.filter((line) => line === `cancel ${workerKey('A')}`).length).toBeGreaterThanOrEqual(3)
    expect(log.filter((line) => line.startsWith('state ')).length).toBeLessThanOrEqual(6)
    expect(log.slice(-2)).toEqual([`kill ${workerKey('A')}`, 'app.drain'])
    expect(warnings.join('\n')).toContain(`${workerKey('A')} is still running`)
    expect(store.get(KV.runtime.paused)?.stop, 'the pause names the session it could not stop').toMatchObject(
      {
        sessions: 1,
        unstopped: [workerKey('A')],
      },
    )
    expect(lifecycle.status()).toEqual({ state: 'stopped' })
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

  it("kills a session's jobs while its cancel waits for a command that holds the turn up, and counts it stopped", async () => {
    // The turn runs a command (a job). Its cancel returns only once that command ended, which it does when killed.
    sessions.set(workerKey('A'), { running: true, pending: [], jobs: 1 })
    let release: () => void = () => {}
    const commandEnded = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = fakeSessions(log, sessions)
    adapter.cancel = async (id) => {
      log.push(`cancel ${id}`)
      await commandEnded
      sessions.get(id)!.running = false
    }
    const control = fakeControl(log, sessions)
    const { lifecycle } = setup({
      sessions: adapter,
      control: {
        ...control,
        killAgentJobs: async (id) => {
          const killed = await control.killAgentJobs(id)
          release()
          return killed
        },
      },
    })
    await lifecycle.start()
    await lifecycle.settled()
    log.length = 0
    await lifecycle.stop('disable')
    expect(log.slice(1, 4)).toEqual([
      `state ${workerKey('A')}`,
      `cancel ${workerKey('A')}`,
      `kill ${workerKey('A')}`,
    ])
    expect(sessions.get(workerKey('A'))).toMatchObject({ running: false, jobs: 0 })
    expect(store.get(KV.runtime.paused)?.stop).toMatchObject({ sessions: 1, unstopped: [] })
  })

  it('waits out a slow cancel within the budget and kills a job the turn started while it wound down', async () => {
    // The turn runs a command. Killed, it stops at once and the session reads not running, but core's cancel
    // returns only once the turn wound down, 600 ms later, and the wind-down starts one more job as it ends.
    sessions.set(workerKey('A'), { running: true, pending: [], jobs: 1 })
    const adapter = fakeSessions(log, sessions)
    let windDown: () => void = () => {}
    adapter.cancel = async (id) => {
      log.push(`cancel ${id}`)
      sessions.get(id)!.running = false
      await new Promise<void>((resolve) => {
        windDown = resolve
      })
    }
    // The wind-down ends while a state read is in flight: the read answers from before it.
    const { state } = adapter
    const began = Date.now()
    adapter.state = async (id) => {
      const read = await state(id)
      if (Date.now() - began >= 600 && sessions.get(id)!.jobs === 0) {
        sessions.get(id)!.jobs = 1
        windDown()
      }
      return read
    }
    const warnings: string[] = []
    const { lifecycle } = setup({ sessions: adapter, log: { warn: (text) => warnings.push(text) } })
    await lifecycle.start()
    await lifecycle.settled()
    log.length = 0
    await lifecycle.stop('disable')
    const ms = Date.now() - began
    expect(sessions.get(workerKey('A'))).toMatchObject({ running: false, jobs: 0 })
    expect(store.get(KV.runtime.paused)?.stop).toMatchObject({ sessions: 1, unstopped: [] })
    expect(warnings).toEqual([])
    expect(ms).toBeGreaterThanOrEqual(600)
    expect(ms).toBeLessThan(4_000)
  })

  it('pauses between passes when the cancel returns at once, so a job that takes a moment to exit is waited for', async () => {
    // A background job that exits 200 ms after its kill; the idle turn's cancel returns at once.
    sessions.set(workerKey('A'), { running: false, pending: [], jobs: 1 })
    const control = fakeControl(log, sessions)
    const { lifecycle } = setup({
      control: {
        ...control,
        killAgentJobs: async (id) => {
          log.push(`kill ${id}`)
          const session = sessions.get(id)!
          const killed = session.jobs
          if (killed) setTimeout(() => (session.jobs = 0), 200)
          return killed
        },
      },
    })
    await lifecycle.start()
    await lifecycle.settled()
    log.length = 0
    await lifecycle.stop('disable')
    expect(store.get(KV.runtime.paused)?.stop).toMatchObject({ sessions: 1, unstopped: [] })
    expect(log.filter((line) => line === `state ${workerKey('A')}`).length).toBeLessThanOrEqual(4)
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
