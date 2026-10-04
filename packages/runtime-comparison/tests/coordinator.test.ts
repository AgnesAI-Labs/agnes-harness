import { readFileSync } from 'node:fs'
import type { ComparisonPreparedConfiguration } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ComparisonCoordinator } from '../src/coordinator.js'
import type {
  ComparisonPorts,
  ComparisonRecord,
  Receipt,
  SessionObservation,
  Side,
  TerminalCause,
} from '../src/ports.js'
import { ComparisonError } from '../src/state.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const done: SessionObservation = {
  phase: 'idle',
  lastSeq: 9,
  settled: true,
  terminalCause: 'finished',
}
const legacySettled: SessionObservation = { phase: 'idle', lastSeq: 9, settled: true }
const cancelledObservation: SessionObservation = { ...legacySettled, terminalCause: 'cancelled' }
const params = {
  requestId: 'compare',
  cwd: '/source',
  left: { runtime: 'native' },
  right: { runtime: 'jevloop' },
}
const content = [{ type: 'text' as const, text: 'same input' }]
type Snapshot = Awaited<ReturnType<ComparisonCoordinator['get']>>
function terminalCauses(snapshot: Snapshot, round = 0): { side: Side; cause: TerminalCause }[] {
  const projected = snapshot.rounds[round]
  if (projected === undefined) throw new Error('Expected projected comparison round')
  return projected.terminalCauses
}
function fixture() {
  const records = new Map<string, ComparisonRecord>()
  const calls: string[] = []
  const observations = new Map<string, { receipt?: Receipt; state?: SessionObservation }>()
  const ports: ComparisonPorts = {
    store: {
      async read(id) {
        const record = records.get(id)
        return record === undefined ? undefined : structuredClone(record)
      },
      async compareAndSwap(id, expected, next) {
        if ((records.get(id)?.revision ?? null) !== expected) return false
        records.set(id, structuredClone(next))
        return true
      },
    },
    workspaces: {
      async prepare() {
        calls.push('snapshot')
        return {
          id: 'baseline',
          digest: 'a'.repeat(64),
          policyHash: 'b'.repeat(64),
          roots: { left: '/left', right: '/right' },
          labels: { left: 'Left copy', right: 'Right copy' },
        }
      },
      async release() {
        calls.push('release')
      },
    },
    sessions: {
      async create(input) {
        calls.push(`create:${input.side}:${input.cwd}`)
        return {
          side: input.side,
          sessionId: input.side,
          runtime: { id: input.runtime, version: '1' },
          workspaceLabel: input.cwd,
          phase: 'idle',
          lastSeq: 0,
        }
      },
      async enqueue(input) {
        calls.push(`enqueue:${input.side}:${input.inputId}`)
        return { status: 'accepted', seq: 1 }
      },
      async run(input) {
        calls.push(`run:${input.sessionId}:${input.inputId}`)
        return done
      },
      async cancel(input) {
        calls.push(`cancel:${input.sessionId}:${input.inputId}`)
      },
      async close(input) {
        calls.push(`close:${input.side}`)
        return { exited: true }
      },
      async inspect(input) {
        calls.push(`inspect:${input.sessionId}`)
        return observations.get(input.sessionId) ?? {}
      },
    },
  }
  return { ports, records, calls, observations, coordinator: new ComparisonCoordinator(ports) }
}

describe('durable comparison coordination', () => {
  it.each([
    [
      'workspace',
      new ComparisonError('WORKSPACE_SOURCE_CHANGED', '/private/source changed'),
      'WORKSPACE_SOURCE_CHANGED',
    ],
    [
      'workspace',
      new ComparisonError('WORKSPACE_SNAPSHOT_LIMIT', '/private/oversized'),
      'WORKSPACE_SNAPSHOT_LIMIT',
    ],
    [
      'workspace',
      Object.assign(new Error('/private/forged'), { code: 'WORKSPACE_READ_DENIED' }),
      'COMPARISON_CREATE_FAILED',
    ],
    [
      'workspace',
      new ComparisonError('WORKSPACE_PRIVATE_UNKNOWN', '/private/unknown'),
      'COMPARISON_CREATE_FAILED',
    ],
    [
      'session',
      new ComparisonError('COMPARISON_ISOLATION_REQUIRED', '/private/policy'),
      'COMPARISON_ISOLATION_REQUIRED',
    ],
    [
      'session',
      new ComparisonError('COMPARISON_WRITABLE_OVERLAP', '/private/shared'),
      'COMPARISON_WRITABLE_OVERLAP',
    ],
    [
      'session',
      new ComparisonError('COMPARISON_PREPARATION_BUSY', '/private/owner'),
      'COMPARISON_PREPARATION_BUSY',
    ],
  ])(
    'persists only safe creation refusal codes through cleanup and cold reads (%s, %s)',
    async (stage, cause, code) => {
      const f = fixture()
      const reject = async () => {
        throw cause
      }
      if (stage === 'workspace') f.ports.workspaces.prepare = reject
      else f.ports.sessions.create = reject
      const close = f.ports.sessions.close
      f.ports.sessions.close = async (input) => {
        expect(f.records.get('compare')?.error?.code).toBe(code)
        return close(input)
      }
      const first = await f.coordinator.create(params).catch((error: unknown) => error)
      expect(first).toMatchObject({ code })
      expect((first as Error).message).not.toContain('/private/')
      expect(f.records.get('compare')?.cleanup).toEqual({ exited: ['left', 'right'], released: true })
      const calls = [...f.calls]
      // A cold coordinator must retain the code without replaying preparation or exposing stored prose.
      const storedError = f.records.get('compare')?.error
      if (!storedError) throw new Error('Missing persisted creation error')
      storedError.message = '/private/stored-error'
      const cold = new ComparisonCoordinator(f.ports)
      for (const operation of [() => cold.get('compare'), () => cold.create(params)]) {
        const error = await operation().catch((failure: unknown) => failure)
        expect(error).toMatchObject({ code, message: (first as Error).message })
      }
      expect(f.calls).toEqual(calls)
    },
  )

  it.each([
    ['runtime-publication-pending', 'runtime-publication-pending'],
    ['configuration-changed', 'configuration-changed'],
    ['prepared-source-invalid', 'prepared-source-invalid'],
    ['resource-admission-busy', 'resource-admission-busy'],
    ['resource-admission-draining', 'resource-admission-draining'],
    ['resource-recovery-required', 'resource-recovery-required'],
    ['private-error-content', 'unknown'],
  ])('refuses configuration admission without exposing raw errors (%s)', async (reason, expected) => {
    const f = fixture()
    const created = await f.coordinator.create(params)
    f.ports.sessions.admit = async () => {
      throw Object.assign(new Error('private-error-content'), { reason, detail: { credential: 'private' } })
    }
    await expect(
      f.coordinator.submit({ id: created.id, inputId: 'not-admitted', content }),
    ).rejects.toMatchObject({
      code: 'COMPARISON_NOT_READY',
      rejectedInput: { id: created.id, inputId: 'not-admitted', admissionReason: expected },
    })
    expect((await f.coordinator.get(created.id)).rounds).toEqual([])
    expect(f.calls.filter((call) => call.startsWith('enqueue:') || call.startsWith('run:'))).toEqual([])
  })

  it('retains uncertain owners and dispatches neither lane when the common check loses its reply', async () => {
    const f = fixture()
    const created = await f.coordinator.create(params)
    f.ports.sessions.admit = async (input) => ({
      enqueue: (side) => f.ports.sessions.enqueue({ ...input, side, sessionId: input.lanes[side].sessionId }),
      ready: async () => {
        throw new Error('common barrier reply lost')
      },
      run: (side) => f.ports.sessions.run({ inputId: input.inputId, sessionId: input.lanes[side].sessionId }),
      release: async () => {
        throw new Error('queued input remains held')
      },
    })
    const submitted = await f.coordinator.submit({ id: created.id, inputId: 'held', content })
    expect(submitted.rounds[0]?.acceptances.map((value) => value.status)).toEqual(['accepted', 'accepted'])
    expect(f.records.get(created.id)?.rounds[0]?.runs).toMatchObject({
      left: { status: 'unknown' },
      right: { status: 'unknown' },
    })
    await f.coordinator.submit({ id: created.id, inputId: 'held', content })
    expect(f.calls.filter((call) => call.startsWith('enqueue:'))).toEqual([
      'enqueue:left:held',
      'enqueue:right:held',
    ])
    expect(f.calls.filter((call) => call.startsWith('run:'))).toEqual([])
  })

  it.each([
    ['known mismatch', 'a'.repeat(64), 'b'.repeat(64), false],
    ['known equal', 'a'.repeat(64), 'a'.repeat(64), true],
    ['explicit unknown', 'a'.repeat(64), null, true],
    ['legacy omission', undefined, 'a'.repeat(64), true],
  ] as const)('handles mounted creation evidence: %s', async (_name, left, right, ready) => {
    const f = fixture()
    const captured = JSON.parse(
      readFileSync(
        new URL('../../protocol/test/fixtures/comparison-prepared-real.json', import.meta.url),
        'utf8',
      ),
    ) as { events: { data: { configuration: ComparisonPreparedConfiguration } }[] }
    const baseline = captured.events[0]?.data.configuration
    if (!baseline) throw new Error('Missing captured preparation configuration')
    const create = f.ports.sessions.create
    f.ports.sessions.create = async (input) => {
      const lane = await create(input)
      const configuration = structuredClone(baseline)
      configuration.runtime = lane.runtime
      const mounted = input.side === 'left' ? left : right
      if (mounted !== undefined) configuration.fingerprints.mounted = mounted
      return {
        ...lane,
        lastSeq: 4,
        prepared: {
          sessionId: lane.sessionId,
          sourceSeq: 4,
          sourceDigest: 'c'.repeat(64),
          configuration,
        },
      }
    }
    if (ready) {
      expect((await f.coordinator.create(params)).phase).toBe('ready')
      expect(f.calls).not.toContain('release')
    } else {
      await expect(f.coordinator.create(params)).rejects.toMatchObject({ code: 'COMPARISON_CREATE_FAILED' })
      expect(f.records.get('compare')?.creation).toBe('failed')
      expect(f.calls).toContain('release')
    }
    expect(f.calls.some((call) => /^(enqueue|run):/.test(call))).toBe(false)
  })
  it('freezes before two independent sessions, preserves creation identity and keeps get read-only', async () => {
    const f = fixture()
    const first = await f.coordinator.create(params)
    expect(first.phase).toBe('ready')
    expect(first.permissionMode).toBe('workspace')
    expect(first.lanes.map((lane) => lane.workspaceLabel)).toEqual(['Left copy', 'Right copy'])
    expect(f.calls).toEqual(['snapshot', 'create:left:/left', 'create:right:/right'])
    expect(await f.coordinator.create({ ...params, isolation: 'snapshot' })).toEqual(first)
    await expect(f.coordinator.create({ ...params, cwd: '/different' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    })
    const count = f.calls.length
    expect(await f.coordinator.get('compare')).toEqual(first)
    expect(f.calls).toHaveLength(count)
  })

  it('waits for late preparations and closes both on failure before releasing the baseline', async () => {
    const f = fixture()
    const late = deferred<void>()
    const close = f.ports.sessions.close
    f.ports.sessions.close = async (input) => {
      const record = f.records.get('compare')!
      expect(record.creation).toBe('failed')
      expect(record.retirement).toEqual({ state: 'releasing', epoch: record.revision })
      return close(input)
    }
    f.ports.sessions.create = async (input) => {
      f.records.get('compare')!.retirement = { state: 'full', epoch: 0 }
      if (input.side === 'left') throw new Error('failed creation')
      await late.promise
      f.calls.push('late-created')
      return {
        side: 'right',
        sessionId: 'right',
        runtime: { id: 'jevloop', version: '1' },
        workspaceLabel: '',
        phase: 'idle',
        lastSeq: 0,
      }
    }
    const creating = f.coordinator.create(params)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.calls).not.toContain('release')
    late.resolve()
    await expect(creating).rejects.toMatchObject({ code: 'COMPARISON_CREATE_FAILED' })
    expect(f.calls.slice(-4)).toEqual(['late-created', 'close:left', 'close:right', 'release'])
    expect(f.records.get('compare')?.cleanup).toEqual({ exited: ['left', 'right'], released: true })
    await expect(f.coordinator.create(params)).rejects.toMatchObject({ code: 'COMPARISON_CREATE_FAILED' })
  })

  it.each(['releasing', 'released', 'removing', 'removed'] as const)(
    'refuses new admission after %s without touching session execution or history',
    async (state) => {
      const f = fixture()
      await f.coordinator.create(params)
      const record = f.records.get('compare')!
      record.retirement = { state, epoch: ++record.revision }
      const before = structuredClone(record)
      const calls = [...f.calls]
      await expect(f.coordinator.submit({ id: 'compare', inputId: 'later', content })).rejects.toMatchObject({
        code: 'COMPARISON_RETIRED',
        rejectedInput: { id: 'compare', inputId: 'later' },
      })
      if (state === 'removed') {
        await expect(f.coordinator.create(params)).rejects.toMatchObject({ code: 'COMPARISON_REMOVED' })
        await expect(f.coordinator.get('compare')).rejects.toMatchObject({ code: 'COMPARISON_REMOVED' })
        await expect(f.coordinator.reconcile('compare')).rejects.toMatchObject({ code: 'COMPARISON_REMOVED' })
      } else {
        expect((await f.coordinator.get('compare')).id).toBe('compare')
        expect((await f.coordinator.reconcile('compare')).id).toBe('compare')
      }
      expect(f.calls).toEqual(calls)
      expect(f.records.get('compare')).toEqual(before)
    },
  )

  it('retains resources if either exit is unknown and refuses worktree or aliased roots', async () => {
    const f = fixture()
    await expect(f.coordinator.create({ ...params, isolation: 'worktree' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_ISOLATION',
    })
    f.ports.sessions.create = async () => {
      throw new Error('creation')
    }
    f.ports.sessions.close = async (input) => ({ exited: input.side === 'left' })
    await expect(f.coordinator.create(params)).rejects.toThrow()
    expect(f.calls).not.toContain('release')
    expect(f.records.get('compare')?.cleanup).toEqual({ exited: ['left'], released: false })
    const alias = fixture()
    const prepare = alias.ports.workspaces.prepare
    alias.ports.workspaces.prepare = async (input) => ({
      ...(await prepare(input)),
      roots: { left: '/left', right: '/left' },
    })
    await expect(alias.coordinator.create(params)).rejects.toMatchObject({ code: 'COMPARISON_CREATE_FAILED' })
    expect(alias.calls.some((call) => call.startsWith('create:'))).toBe(false)
  })

  it('durably accepts both before concurrent runs, returns without settlement and continues a second round', async () => {
    const f = fixture()
    const gates = { left: deferred<SessionObservation>(), right: deferred<SessionObservation>() }
    const started = { left: deferred<void>(), right: deferred<void>() }
    f.ports.sessions.run = async (input) => {
      const round = f.records.get('compare')!.rounds.at(-1)!
      expect(Object.values(round.acceptances).map((receipt) => receipt.status)).toEqual([
        'accepted',
        'accepted',
      ])
      f.calls.push(`run:${input.sessionId}`)
      started[input.sessionId as Side].resolve()
      return gates[input.sessionId as Side].promise
    }
    await f.coordinator.create(params)
    const submitted = await f.coordinator.submit({ id: 'compare', inputId: 'one', content })
    expect(submitted.rounds[0]?.acceptances.map((item) => item.status)).toEqual(['accepted', 'accepted'])
    await Promise.all([started.left.promise, started.right.promise])
    expect(f.calls).toContain('run:left')
    expect(f.calls).toContain('run:right')
    expect((await f.coordinator.get('compare')).phase).toBe('running')
    gates.left.resolve({ phase: 'failed', lastSeq: 6, settled: true, terminalCause: 'failed' })
    gates.right.resolve(done)
    await f.coordinator.drain()
    const firstRound = await f.coordinator.get('compare')
    expect(firstRound.phase).toBe('partial')
    expect(firstRound.rounds[0]?.settledSides).toEqual(['left', 'right'])
    expect(terminalCauses(firstRound)).toEqual([
      { side: 'left', cause: 'failed' },
      { side: 'right', cause: 'finished' },
    ])
    expect(f.calls.some((call) => call.startsWith('cancel:'))).toBe(false)
    await f.coordinator.submit({ id: 'compare', inputId: 'two', content, permissionMode: 'view' })
    await f.coordinator.drain()
    const secondRound = await f.coordinator.get('compare')
    expect(secondRound.permissionMode).toBe('view')
    expect(secondRound.rounds.map((round) => round.permissionMode)).toEqual(['workspace', 'view'])
    // An omitted-mode retry binds to its original round, not the newer default.
    expect((await f.coordinator.submit({ id: 'compare', inputId: 'one', content })).rounds).toHaveLength(2)
    expect(f.calls.filter((call) => call.startsWith('create:'))).toHaveLength(2)
  })

  it('reserves input once under competing coordinators and rejects identity/payload conflicts', async () => {
    const f = fixture()
    await f.coordinator.create(params)
    const second = new ComparisonCoordinator(f.ports)
    await Promise.all([
      f.coordinator.submit({ id: 'compare', inputId: 'one', content }),
      second.submit({ id: 'compare', inputId: 'one', content }),
    ])
    await Promise.all([f.coordinator.drain(), second.drain()])
    expect(f.calls.filter((call) => call.startsWith('enqueue:'))).toHaveLength(2)
    await expect(
      second.submit({ id: 'compare', inputId: 'one', content: [{ type: 'text', text: 'changed' }] }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(
      second.submit({ id: 'compare', inputId: 'one', content, permissionMode: 'full' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(
      (await second.submit({ id: 'compare', inputId: 'one', content, permissionMode: 'workspace' })).rounds,
    ).toHaveLength(1)
  })

  it('records unknown enqueue without retry, runs the accepted peer, and reconciles only ledger evidence', async () => {
    const f = fixture()
    f.ports.sessions.enqueue = async (input) => {
      f.calls.push(`enqueue:${input.side}`)
      if (input.side === 'left') throw new Error('lost receipt')
      return { status: 'accepted', seq: 1 }
    }
    await f.coordinator.create(params)
    const result = await f.coordinator.submit({ id: 'compare', inputId: 'one', content })
    expect(result.rounds[0]?.acceptances.map((item) => item.status)).toEqual(['unknown', 'accepted'])
    await f.coordinator.drain()
    expect(f.calls).toContain('run:right:one')
    expect(f.calls).not.toContain('run:left:one')
    const restarted = new ComparisonCoordinator(f.ports)
    await restarted.submit({ id: 'compare', inputId: 'one', content })
    f.observations.set('left', {
      receipt: { status: 'accepted', seq: 1 },
      state: { ...done, terminalCause: 'finished' },
    })
    const reconciled = await restarted.reconcile('compare')
    expect(reconciled.phase).toBe('completed')
    expect(terminalCauses(reconciled)).toEqual([
      { side: 'left', cause: 'finished' },
      { side: 'right', cause: 'finished' },
    ])
    expect(f.calls.filter((call) => call.startsWith('enqueue:'))).toHaveLength(2)
    expect(f.calls.filter((call) => call.startsWith('run:'))).toHaveLength(1)
  })

  it('keeps waiting unsettled through refresh and scopes cancellation to the selected lane/input', async () => {
    const f = fixture()
    f.ports.sessions.run = async () => ({ phase: 'waiting', lastSeq: 3, settled: false })
    await f.coordinator.create(params)
    await f.coordinator.submit({ id: 'compare', inputId: 'one', content })
    await f.coordinator.drain()
    expect((await f.coordinator.get('compare')).rounds[0]?.settledSides).toEqual([])
    await f.coordinator.cancel({ id: 'compare', side: 'left' })
    expect(f.calls).toContain('cancel:left:one')
    expect(f.calls).not.toContain('cancel:right:one')
    await expect(f.coordinator.submit({ id: 'compare', inputId: 'two', content })).rejects.toMatchObject({
      code: 'COMPARISON_BUSY',
      rejectedInput: { id: 'compare', inputId: 'two' },
    })
    f.observations.set('left', { state: cancelledObservation })
    f.observations.set('right', { state: done })
    const reconciled = await new ComparisonCoordinator(f.ports).reconcile('compare')
    expect(reconciled.phase).toBe('partial')
    expect(terminalCauses(reconciled)).toEqual([
      { side: 'left', cause: 'cancelled' },
      { side: 'right', cause: 'finished' },
    ])
  })

  it('keeps a cancellation race scoped and records the acknowledged lane as cancelled', async () => {
    const f = fixture()
    const left = deferred<SessionObservation>()
    const leftStarted = deferred<void>()
    f.ports.sessions.run = async (input) => {
      if (input.sessionId === 'left') {
        leftStarted.resolve()
        return left.promise
      }
      return done
    }
    await f.coordinator.create(params)
    await f.coordinator.submit({ id: 'compare', inputId: 'one', content })
    await leftStarted.promise
    await f.coordinator.cancel({ id: 'compare', side: 'left' })
    left.resolve(cancelledObservation)
    await f.coordinator.drain()
    const settled = await f.coordinator.get('compare')
    expect(settled.phase).toBe('partial')
    expect(terminalCauses(settled)).toEqual([
      { side: 'left', cause: 'cancelled' },
      { side: 'right', cause: 'finished' },
    ])
    expect(f.calls).toContain('cancel:left:one')
    expect(f.calls).not.toContain('cancel:right:one')
  })

  it('does not let a late cancellation acknowledgement rewrite an already finished lane', async () => {
    const f = fixture()
    await f.coordinator.create(params)
    await f.coordinator.submit({ id: 'compare', inputId: 'one', content })
    await f.coordinator.drain()
    f.ports.sessions.cancel = async (input) => {
      f.calls.push(`cancel:${input.sessionId}:${input.inputId}`)
      return legacySettled
    }
    const afterCancel = await f.coordinator.cancel({ id: 'compare', side: 'left' })
    expect(afterCancel.phase).toBe('completed')
    expect(terminalCauses(afterCancel)).toEqual([
      { side: 'left', cause: 'finished' },
      { side: 'right', cause: 'finished' },
    ])
    expect(f.calls).toContain('cancel:left:one')
    expect(f.calls).not.toContain('cancel:right:one')
  })

  it('keeps a new running round phase when exact cancellation observes an older completed input', async () => {
    const f = fixture()
    await f.coordinator.create(params)
    await f.coordinator.submit({ id: 'compare', inputId: 'old', content })
    await f.coordinator.drain()
    const finish = deferred<SessionObservation>()
    f.ports.sessions.run = async () => finish.promise
    await f.coordinator.submit({ id: 'compare', inputId: 'new', content })
    f.ports.sessions.cancel = async () => ({ ...done, lastSeq: 10 })
    try {
      const cancelled = await f.coordinator.cancel({ id: 'compare', inputId: 'old' })
      expect(cancelled.lanes.map((lane) => lane.phase)).toEqual(['running', 'running'])
      expect(cancelled.phase).toBe('running')
      expect(cancelled.rounds[0]?.terminalCauses).toEqual([
        { side: 'left', cause: 'finished' },
        { side: 'right', cause: 'finished' },
      ])
      expect(cancelled.rounds[1]?.settledSides).toEqual([])
    } finally {
      finish.resolve({ ...done, lastSeq: 11 })
      await f.coordinator.drain()
    }
  })

  it('projects legacy settled journal rows without causes as unknown and never invents success', async () => {
    const f = fixture()
    await f.coordinator.create(params)
    await f.coordinator.submit({ id: 'compare', inputId: 'one', content })
    await f.coordinator.drain()
    const stored = f.records.get('compare')
    const legacyRound = stored?.rounds[0]
    if (legacyRound === undefined) throw new Error('Expected persisted comparison round')
    delete legacyRound.runs.left.terminalCause
    delete legacyRound.runs.right.terminalCause
    const restored = await new ComparisonCoordinator(f.ports).reconcile('compare')
    expect(restored.phase).toBe('partial')
    expect(restored.rounds[0]?.settledSides).toEqual(['left', 'right'])
    expect(terminalCauses(restored)).toEqual([
      { side: 'left', cause: 'unknown' },
      { side: 'right', cause: 'unknown' },
    ])
    expect(f.calls.filter((call) => call.startsWith('inspect:'))).toHaveLength(0)
  })

  it.each([new Error('disk failure'), new ComparisonError('COMPARISON_BUSY', 'CAS failed')])(
    'does not attest refusal or dispatch when acceptance persistence fails: $message',
    async (failure) => {
      const f = fixture()
      await f.coordinator.create(params)
      const cas = f.ports.store.compareAndSwap
      f.ports.store.compareAndSwap = async (id, expected, next) => {
        if (next.rounds.some((round) => round.acceptances.left.status === 'accepted')) throw failure
        return cas(id, expected, next)
      }
      await expect(f.coordinator.submit({ id: 'compare', inputId: 'one', content })).rejects.toBe(failure)
      expect((failure as ComparisonError).rejectedInput).toBeUndefined()
      expect(f.calls.some((call) => call.startsWith('run:'))).toBe(false)
      expect(f.records.get('compare')?.rounds[0]?.acceptances.left.status).toBe('unknown')
    },
  )

  it('permanently fences an exact pending input before a late acquisition can reserve its round', async () => {
    const f = fixture()
    await f.coordinator.create(params)
    const acquired = deferred<void>()
    const proceed = deferred<void>()
    let released = false
    f.ports.sessions.admit = async () => {
      acquired.resolve()
      await proceed.promise
      return {
        enqueue: async () => {
          throw new Error('must not enqueue')
        },
        ready: async () => {},
        run: async () => done,
        release: async () => {
          released = true
        },
      }
    }
    f.ports.sessions.cancel = async () => cancelledObservation
    const submitting = f.coordinator.submit({ id: 'compare', inputId: 'pending', content })
    await acquired.promise
    await f.coordinator.cancel({ id: 'compare', inputId: 'pending', side: 'left' })
    proceed.resolve()
    await expect(submitting).rejects.toMatchObject({ code: 'COMPARISON_NOT_READY' })
    expect(released).toBe(true)
    expect(f.records.get('compare')?.rounds).toEqual([])
    expect((await f.coordinator.get('compare')).inputCancellations).toEqual([
      { inputId: 'pending', states: [{ side: 'left', status: 'acknowledged' }] },
    ])
    const reopened = new ComparisonCoordinator(f.ports)
    await expect(reopened.submit({ id: 'compare', inputId: 'pending', content })).rejects.toMatchObject({
      code: 'COMPARISON_NOT_READY',
    })
    expect(f.calls.some((call) => call.startsWith('enqueue:') || call.startsWith('run:'))).toBe(false)
  })

  it.each(['transport', 'unsettled', 'missing'] as const)(
    'retains exact input fencing when %s cleanup is unconfirmed',
    async (failure) => {
      const f = fixture()
      await f.coordinator.create(params)
      f.ports.sessions.cancel = async () => {
        if (failure === 'transport') throw new Error('transport lost')
        if (failure === 'missing') return undefined
        return { phase: 'waiting', lastSeq: 0, settled: false }
      }
      const cancelled = await f.coordinator.cancel({ id: 'compare', inputId: 'unconfirmed', side: 'left' })
      expect(cancelled.inputCancellations).toEqual([
        { inputId: 'unconfirmed', states: [{ side: 'left', status: 'unknown' }] },
      ])
      expect(cancelled.rounds).toEqual([])
      await expect(
        new ComparisonCoordinator(f.ports).submit({ id: 'compare', inputId: 'unconfirmed', content }),
      ).rejects.toMatchObject({ code: 'COMPARISON_NOT_READY' })
      f.ports.sessions.cancel = async () => cancelledObservation
      const confirmed = await f.coordinator.cancel({ id: 'compare', inputId: 'unconfirmed', side: 'left' })
      expect(confirmed.inputCancellations?.[0]?.states).toEqual([{ side: 'left', status: 'acknowledged' }])
      f.ports.sessions.cancel = async () => {
        throw new Error('owner later unavailable')
      }
      expect(
        (await f.coordinator.cancel({ id: 'compare', inputId: 'unconfirmed', side: 'left' }))
          .inputCancellations,
      ).toEqual(confirmed.inputCancellations)
    },
  )

  it('preserves confirmed queued-input cancellation when late admission receipts arrive', async () => {
    const f = fixture()
    const admitted = deferred<void>()
    const release = deferred<void>()
    let sides = 0
    f.ports.sessions.enqueue = async () => {
      if (++sides === 2) admitted.resolve()
      await release.promise
      return { status: 'accepted', seq: 1 }
    }
    f.ports.sessions.cancel = async () => cancelledObservation
    await f.coordinator.create(params)
    const pending = f.coordinator.submit({ id: 'compare', inputId: 'one', content })
    await admitted.promise
    const cancelled = await f.coordinator.cancel({ id: 'compare' })
    expect(cancelled.phase).toBe('cancelled')
    expect(cancelled.rounds[0]?.settledSides).toEqual(['left', 'right'])
    expect(terminalCauses(cancelled)).toEqual([
      { side: 'left', cause: 'cancelled' },
      { side: 'right', cause: 'cancelled' },
    ])
    await expect(f.coordinator.submit({ id: 'compare', inputId: 'two', content })).rejects.toMatchObject({
      code: 'COMPARISON_BUSY',
    })
    release.resolve()
    await pending
    await f.coordinator.drain()
    expect((await f.coordinator.get('compare')).phase).toBe('cancelled')
    expect(f.calls.some((call) => call.startsWith('run:'))).toBe(false)
    await f.coordinator.submit({ id: 'compare', inputId: 'two', content })
    await f.coordinator.drain()
    expect((await f.coordinator.get('compare')).rounds).toHaveLength(2)
  })

  it('confirms elapsed from monotonic time and keeps wall drift out of the duration', async () => {
    const f = fixture()
    let phase: 'start' | 'finish' = 'start'
    let entered = 0
    let releaseBoth!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    f.ports.clock = {
      now: () => Date.parse(phase === 'start' ? '2026-10-03T00:00:00.000Z' : '2026-10-03T00:01:00.000Z'),
      monotonic: () => (phase === 'start' ? 1_000 : 1_025.9),
    }
    f.ports.sessions.run = async () => {
      if (++entered === 2) releaseBoth()
      await bothEntered
      phase = 'finish'
      return { ...done, lastSeq: 40 }
    }
    const coordinator = new ComparisonCoordinator(f.ports)
    await coordinator.create(params)
    await coordinator.submit({ id: 'compare', inputId: 'one', content })
    await coordinator.drain()
    const runs = f.records.get('compare')?.rounds[0]?.runs
    expect(runs?.left.timing).toEqual({
      startedAt: '2026-10-03T00:00:00.000Z',
      finishedAt: '2026-10-03T00:01:00.000Z',
      elapsedMs: 25,
      terminalConfirmed: true,
    })
    expect(runs?.right.timing).toEqual(runs?.left.timing)
    expect(runs?.left.terminalSeq).toBe(40)
    expect(runs?.right.terminalSeq).toBe(40)
  })

  it('keeps elapsed null when the run throws and does not recreate it on reconcile', async () => {
    const f = fixture()
    f.ports.clock = {
      now: () => Date.parse('2026-10-03T00:00:00.000Z'),
      monotonic: () => 1_000,
    }
    f.ports.sessions.run = async () => {
      throw new Error('transport down')
    }
    const coordinator = new ComparisonCoordinator(f.ports)
    await coordinator.create(params)
    await coordinator.submit({ id: 'compare', inputId: 'one', content })
    await coordinator.drain()
    const failed = f.records.get('compare')?.rounds[0]?.runs.left
    expect(failed?.status).toBe('unknown')
    expect(failed?.timing).toEqual({
      startedAt: '2026-10-03T00:00:00.000Z',
      finishedAt: null,
      elapsedMs: null,
      terminalConfirmed: false,
    })
    expect(failed?.terminalSeq).toBeUndefined()
    f.observations.set('left', {
      state: { phase: 'idle', lastSeq: 12, settled: true, terminalCause: 'finished' },
    })
    f.observations.set('right', {
      state: { phase: 'idle', lastSeq: 8, settled: true, terminalCause: 'finished' },
    })
    await new ComparisonCoordinator(f.ports).reconcile('compare')
    const restored = f.records.get('compare')?.rounds[0]?.runs
    expect(restored?.left.timing).toEqual(failed?.timing)
    expect(restored?.right.timing?.elapsedMs).toBeNull()
    expect(restored?.left.terminalSeq).toBe(12)
    expect(restored?.right.terminalSeq).toBe(8)
    expect(restored?.left.terminalCause).toBe('finished')
  })

  it('does not let a late cancellation acknowledgement rewrite confirmed elapsed or cause', async () => {
    const f = fixture()
    f.ports.clock = {
      now: () => Date.parse('2026-10-03T00:00:00.000Z'),
      monotonic: () => 50,
    }
    const coordinator = new ComparisonCoordinator(f.ports)
    await coordinator.create(params)
    await coordinator.submit({ id: 'compare', inputId: 'one', content })
    await coordinator.drain()
    const before = structuredClone(f.records.get('compare')?.rounds[0]?.runs.left)
    f.ports.sessions.cancel = async (input) => {
      f.calls.push(`cancel:${input.sessionId}:${input.inputId}`)
      return { phase: 'idle', lastSeq: 9, settled: true, terminalCause: 'cancelled' }
    }
    const afterCancel = await coordinator.cancel({ id: 'compare', side: 'left' })
    expect(terminalCauses(afterCancel)).toEqual([
      { side: 'left', cause: 'finished' },
      { side: 'right', cause: 'finished' },
    ])
    expect(f.records.get('compare')?.rounds[0]?.runs.left.timing).toEqual(before?.timing)
    expect(f.records.get('compare')?.rounds[0]?.runs.left.terminalSeq).toBe(before?.terminalSeq)
  })
})
