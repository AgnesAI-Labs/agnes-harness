import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EventInput, presetDefaults, type SessionImpl } from '@agnes/core'
import {
  assertRuntimeRecord,
  openJevRuntime,
  type RuntimeConfig,
  type RuntimePorts,
  type RuntimeRecord,
} from '@agnes/jev-runtime'
import { assistantHistoryContent } from '@agnes/runtime-jev'
import { describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
import { drainJevCostOutbox, JEV_COST_ACK, JEV_COST_OUTBOX, projectJevCost } from '../src/runtime/jev-cost.js'
import { createJevLedger } from '../src/runtime/jev-ledger.js'
import { createJevModelPolicy } from '../src/runtime/jev-model-policy.js'
import {
  admitJevTreeRequest,
  drainJevTreeBudget,
  JEV_TREE_ACK,
  JEV_TREE_ADMISSION,
  JEV_TREE_DISPATCH,
} from '../src/runtime/jev-tree-budget.js'

const requested = {
  version: 1,
  id: 'request',
  turn: 'turn',
  step: 'step',
  attempt: 'attempt',
  kind: 'model.requested',
  call: {
    purpose: 'answer',
    backend: 'agnes-provider',
    endpoint: 'test',
    requestedModel: 'model',
    codec: 'agnes-language-v1',
    input: {},
    inputCursor: null,
  },
} as unknown as RuntimeRecord
const settled = {
  version: 1,
  id: 'settled',
  turn: 'turn',
  step: 'step',
  attempt: 'attempt',
  kind: 'model.settled',
  requested: 'request',
  settlement: {
    output: {},
    usage: {
      type: 'usage',
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      credits: 1,
      creditSource: 'estimated',
    },
  },
} as unknown as RuntimeRecord

type Row = EventInput & { seq: number }
function fixture(key = 's', storage: object = {}, boundarySeq = 0) {
  const rows: Row[] = []
  const delivered: Record<string, unknown>[] = []
  const sink = new Map<string, Record<string, unknown>>()
  let failAtomic = false
  let failAck = false
  let failSink = false
  let failTree: string | undefined
  let turn = 2
  let step = 3
  const session = {
    key,
    lane: 'main',
    runtimeIdentity: { id: 'jevloop', version: '1' },
    preset: { ...presetDefaults(), treeBudgetMode: 'unlimited' },
    get lastSeq() {
      return rows.length
    },
    state: { openTurn: { get: () => ({ turn }) }, openStep: { get: () => ({ step }) } },
    lastTurnNumber: () => turn,
    locked: async <T>(fn: () => Promise<T>) => fn(),
    ev: (type: string, data: unknown, extras = {}) => ({ type, data, lane: 'main', ...extras }),
    scan: async (query: { type?: string | string[]; fromSeq?: number; toSeq?: number; limit?: number }) =>
      rows
        .filter(
          (row) =>
            (!query.type ||
              (Array.isArray(query.type) ? query.type.includes(row.type) : row.type === query.type)) &&
            row.seq >= (query.fromSeq ?? 1) &&
            row.seq <= (query.toSeq ?? rows.length),
        )
        .slice(0, query.limit),
    d: {
      log: {
        get parent() {
          return boundarySeq ? { key: 'parent', boundarySeq } : undefined
        },
        get storage() {
          return storage
        },
        append: async (batch: EventInput[]) => {
          if (failTree && batch.some((row) => row.type === failTree)) throw new Error('tree append failed')
          if (failAtomic && batch.some((row) => row.type === 'cost/ledger'))
            throw new Error('atomic append failed')
          if (failAck && batch.some((row) => row.type === JEV_COST_ACK)) throw new Error('ack append failed')
          const firstSeq = rows.length + 1
          rows.push(...batch.map((row, i) => ({ ...structuredClone(row), seq: firstSeq + i })))
          return { firstSeq, lastSeq: rows.length }
        },
      },
      runtime: {
        ledgerRecord: async (data: Record<string, unknown>) => {
          // Delivery must observe both durable authoritative facts, including on recovery.
          expect(
            rows.some(
              (row) =>
                row.type === 'runtime/record' &&
                (row.data as unknown as { record: RuntimeRecord }).record.kind === 'model.settled',
            ),
          ).toBe(true)
          expect(
            rows.some(
              (row) =>
                row.type === 'cost/ledger' && (row.data as { effectId: string }).effectId === data.effectId,
            ),
          ).toBe(true)
          delivered.push(data)
          if (failSink) return false
          sink.set(String(data.effectId), data)
          return true
        },
      },
    },
  } as unknown as SessionImpl
  return {
    session,
    rows,
    setStorage: (next: object) => {
      storage = next
    },
    treeFailure: (type?: string) => {
      failTree = type
    },
    delivered,
    sink,
    atomicFailure: (value: boolean) => {
      failAtomic = value
    },
    ackFailure: (value: boolean) => {
      failAck = value
    },
    sinkFailure: (value: boolean) => {
      failSink = value
    },
    position: (nextTurn: number, nextStep: number) => {
      turn = nextTurn
      step = nextStep
    },
  }
}

describe('Jev durable cost outbox', () => {
  it('keeps a persisted finite tree capped when uncapped media has no token counter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-jev-media-tree-'))
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    try {
      const h = fixture('media-finite-tree', storage)
      h.session.turnBudgetCap = () => null
      Object.assign(h.session.d, { provider: {} })
      const rootTaskId = `${h.session.key}:main:0`
      await storage.ensureRootScope(rootTaskId, 2_000_000n)
      if (requested.kind !== 'model.requested') throw new Error('Expected request fixture')
      const media = {
        ...requested.call,
        input: {
          request: {
            kind: 'inference',
            sessionKey: h.session.key,
            slot: 'primary',
            route: 'test',
            model: 'model',
            contractId: null,
            derivedHash: 'a'.repeat(64),
            system: '',
            tools: [],
            messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'aQ==' }] }],
          },
        },
      }
      let invoked = false
      const backend = {
        maxFormatRetries: 0,
        prepare: async () => media,
        invoke: async () => {
          invoked = true
          return { output: {} }
        },
      }
      const policy = createJevModelPolicy({ session: h.session, decision: backend, language: backend })
      const call = await policy.language.prepare({} as never, new AbortController().signal)
      const ledger = await createJevLedger(h.session)
      await ledger.commit({ ...requested, call })
      await expect(policy.language.invoke(call, new AbortController().signal)).rejects.toThrow(
        'unknown_bound',
      )
      expect(invoked).toBe(false)
      expect(h.rows.some((row) => row.type === JEV_TREE_DISPATCH)).toBe(false)
      expect(h.rows.find((row) => row.type === 'budget.state')?.data).not.toHaveProperty('lastPreflight')
      expect(await storage.projectTree(rootTaskId)).toMatchObject({ capMicro: 2_000_000n, heldMicro: 0n })
    } finally {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays real captured tree settlements with original source bindings and missing decision charges', async () => {
    const captured = JSON.parse(
      readFileSync(new URL('./fixtures/jev-real-tree-budget.json', import.meta.url), 'utf8'),
    ) as {
      sessionKey: string
      events: Row[]
      observedBudget: {
        scope: { root_task_id: string; cap_micro: string | null; settled_micro: string; held_micro: string }
        reservations: {
          permit_id: string
          effect_id: string
          request_hash: string
          scope_ids: string[]
          q_micro: string | null
          writer_generation: number
          status: string
        }[]
      }
    }
    type Admission = {
      requestedId: string
      requestedSeq: number
      rootTaskId: string
      scopeIds: string[]
      effectId: string
      requestHash: string
      qMicro: string | null
      writerGeneration: number
    }
    const dir = mkdtempSync(join(tmpdir(), 'agnes-jev-real-tree-'))
    const open = () => createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    let storage = open()
    try {
      const h = fixture(captured.sessionKey, storage)
      const scope = captured.observedBudget.scope
      await storage.ensureRootScope(
        scope.root_task_id,
        scope.cap_micro === null ? null : BigInt(scope.cap_micro),
      )
      const admissions = captured.events.filter((row) => row.type === JEV_TREE_ADMISSION)
      for (const row of admissions) {
        const admission = row.data as Admission
        const observed = captured.observedBudget.reservations.find(
          (permit) =>
            permit.effect_id === admission.effectId && permit.request_hash === admission.requestHash,
        )
        if (!observed) throw new Error('Captured admission must bind the observed SQLite reservation')
        expect(admission).toMatchObject({
          rootTaskId: scope.root_task_id,
          scopeIds: observed.scope_ids,
          qMicro: observed.q_micro,
          writerGeneration: observed.writer_generation,
        })
        const reserved = await storage.reserve({
          rootTaskId: admission.rootTaskId,
          scopeIds: admission.scopeIds,
          effectId: admission.effectId,
          requestHash: admission.requestHash,
          qMicro: admission.qMicro === null ? null : BigInt(admission.qMicro),
          writerGeneration: admission.writerGeneration,
        })
        expect(reserved).toMatchObject({ ok: true, permitId: observed.permit_id, status: 'held' })
      }
      // Pad omitted non-budget events to keep every captured source coordinate unchanged.
      // Drop only the captured ACKs to exercise recovery from settlement-before-ACK loss.
      const source = new Map(
        captured.events.filter((row) => row.type !== JEV_TREE_ACK).map((row) => [row.seq, row]),
      )
      h.rows.push(
        ...Array.from({ length: Math.max(...captured.events.map((row) => row.seq)) }, (_, index) =>
          structuredClone(
            source.get(index + 1) ??
              ({ seq: index + 1, type: 'x/test/omitted-event', lane: 'main', data: {} } as Row),
          ),
        ),
      )
      await storage.close()
      storage = open()
      h.setStorage(storage)

      const firstAdmission = h.rows.find((row) => row.seq === admissions[0]?.seq)
      const secondAdmission = admissions[1]
      const secondPermit = captured.observedBudget.reservations[1]
      if (!firstAdmission || !secondAdmission || !secondPermit)
        throw new Error('Expected both captured admissions and reservations')
      const originalAdmission = structuredClone(firstAdmission.data)
      ;(firstAdmission.data as Admission).requestedSeq = (secondAdmission.data as Admission).requestedSeq
      await expect(createJevLedger(h.session)).rejects.toThrow('Invalid durable tree admission binding')
      firstAdmission.data = originalAdmission
      const firstDispatch = h.rows.find((row) => row.type === JEV_TREE_DISPATCH)
      if (!firstDispatch) throw new Error('Expected first captured dispatch')
      const originalDispatch = structuredClone(firstDispatch.data)
      ;(firstDispatch.data as { permitId: string }).permitId = secondPermit.permit_id
      await expect(createJevLedger(h.session)).rejects.toThrow('Durable tree dispatch has no matching permit')
      firstDispatch.data = originalDispatch
      expect(h.rows.filter((row) => row.type === JEV_TREE_ACK)).toHaveLength(0)
      for (const observed of captured.observedBudget.reservations)
        expect(await storage.peekReservation?.(observed.permit_id)).toMatchObject({ status: 'held' })

      await createJevLedger(h.session)
      for (const observed of captured.observedBudget.reservations)
        expect(await storage.peekReservation?.(observed.permit_id)).toMatchObject({
          status: observed.status,
          effectId: observed.effect_id,
          requestHash: observed.request_hash,
          qMicro: observed.q_micro === null ? null : BigInt(observed.q_micro),
          writerGeneration: observed.writer_generation,
        })
      expect(await storage.projectTree(scope.root_task_id)).toEqual({
        capMicro: scope.cap_micro === null ? null : BigInt(scope.cap_micro),
        settledMicro: BigInt(scope.settled_micro),
        heldMicro: BigInt(scope.held_micro),
        unknownHeld: captured.observedBudget.reservations.some((permit) => permit.status === 'unknown'),
      })
      const receipt = (row: Row) => ({ data: row.data, sourceEventSeqs: row.sourceEventSeqs })
      expect(h.rows.filter((row) => row.type === JEV_TREE_ACK).map(receipt)).toEqual(
        captured.events.filter((row) => row.type === JEV_TREE_ACK).map(receipt),
      )
      const recoveredLength = h.rows.length
      await storage.close()
      storage = open()
      h.setStorage(storage)
      await createJevLedger(h.session)
      expect(h.rows).toHaveLength(recoveredLength)
      expect((await storage.projectTree(scope.root_task_id))?.settledMicro).toBe(BigInt(scope.settled_micro))
    } finally {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['before-dispatch', 'after-dispatch'] as const)(
    'recovers %s crash gaps through the portable runtime without inventing actual cost',
    async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-jev-runtime-recovery-'))
      const open = () =>
        createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
      let storage = open()
      try {
        const h = fixture(`runtime-recovery-${mode}`, storage)
        h.session.preset.treeBudgetCredits = 2
        h.session.preset.treeBudgetMode = 'capped'
        const ledger = await createJevLedger(h.session)
        await ledger.commit(requested)
        if (requested.kind !== 'model.requested') throw new Error('expected request fixture')
        if (mode === 'before-dispatch') h.treeFailure(JEV_TREE_DISPATCH)
        const admission = admitJevTreeRequest(h.session, requested.call, 1, new AbortController().signal)
        if (mode === 'before-dispatch') await expect(admission).rejects.toThrow('tree append failed')
        else await admission
        h.treeFailure()
        const bound = h.rows.find((entry) => entry.type === JEV_TREE_ADMISSION)?.data as {
          rootTaskId: string
          effectId: string
          requestHash: string
        }
        const permit = await storage.lookupReservationByIdentity?.(
          bound.rootTaskId,
          bound.effectId,
          bound.requestHash,
        )
        if (!permit) throw new Error('Expected a durable permit before the crash')
        expect(permit).toMatchObject({ status: 'held', qMicro: 1_000_000n })
        expect(h.rows.filter((entry) => entry.type === JEV_TREE_DISPATCH)).toHaveLength(
          mode === 'after-dispatch' ? 1 : 0,
        )
        expect((await ledger.read()).map(({ record }) => record.kind)).toEqual(['model.requested'])

        const unexpected = async (): Promise<never> => {
          throw new Error('Recovery must not invoke a provider, tool, or artifact operation')
        }
        const config: RuntimeConfig = {
          maxSteps: 3,
          maxModelAttempts: 6,
          maxNoProgress: 2,
          maxRepeatedFailures: 2,
          maxCandidates: 4,
          maxHistory: 20,
          maxQuestionBytes: 10_000,
          maxOutputBytes: 100_000,
          escalateBelow: 0.6,
          mutationEscalateBelow: 0.6,
          bindingBelow: 0.6,
          equivalentSupportThreshold: 0.8,
          ambiguityGate: null,
          answerProgressFloor: null,
          responseReviewMode: 'diagnostic',
          maxResponseReviewAttempts: 2,
        }
        // The fixture retains the durable Session prefix; the reservation store really closes and reopens.
        for (let reopen = 0; reopen < 2; reopen++) {
          await storage.close()
          storage = open()
          h.setStorage(storage)
          const recoveredLedger = await createJevLedger(h.session)
          if (reopen === 0)
            expect((await recoveredLedger.read()).map(({ record }) => record.kind)).toEqual([
              'model.requested',
            ])
          const ports: RuntimePorts<number> = {
            ledger: recoveredLedger,
            decisionContext: {
              config: {
                maxStateBytes: 65_536,
                recentActions: 10,
                observationCount: 4,
                maxEvidenceBytes: 6000,
                excerptBytes: 1600,
              },
              instructionOrder: 'Host rules govern user requests; tool results are evidence.',
              classify: () => ({ kind: 'context' }),
            },
            decision: { prepare: unexpected, invoke: unexpected },
            language: { maxFormatRetries: 0, prepare: unexpected, invoke: unexpected },
            environment: {
              snapshot: unexpected,
              catalog: unexpected,
              validate: unexpected,
              execute: unexpected,
              drain: unexpected,
            },
            artifacts: { put: unexpected, read: unexpected, retain: unexpected, release: unexpected },
          }
          const runtime = await openJevRuntime(ports, config)
          try {
            const records = (await recoveredLedger.read()).map(({ record }) => record)
            expect(records).toHaveLength(2)
            expect(records[1]).toMatchObject({
              kind: 'model.settled',
              requested: requested.id,
              settlement: { error: { code: 'INTERRUPTED', retryable: false } },
            })
            if (records[1]?.kind !== 'model.settled')
              throw new Error('Expected automatic recovery settlement')
            expect(records[1].settlement.usage).toBeUndefined()
            expect(h.rows.filter((entry) => entry.type === JEV_TREE_ACK)).toHaveLength(1)
            expect(h.rows.filter((entry) => entry.type === 'cost/ledger')).toHaveLength(0)
            expect(await storage.peekReservation?.(permit.permitId)).toMatchObject({
              status: mode === 'before-dispatch' ? 'released' : 'unknown',
            })
            expect(await storage.projectTree(bound.rootTaskId)).toMatchObject({
              capMicro: 2_000_000n,
              settledMicro: 0n,
              heldMicro: mode === 'before-dispatch' ? 0n : 1_000_000n,
              unknownHeld: mode === 'after-dispatch',
            })
          } finally {
            await runtime.close()
          }
        }
      } finally {
        await storage.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('settles durable tree permits after model settlement and recovers interrupted admission without dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-jev-tree-'))
    const open = () => createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    let storage = open()
    try {
      for (const mode of [
        'known',
        'unknown',
        'before-dispatch',
        'ack-lost',
        'finite-unknown',
        'finite-exceeded',
        'fenced',
        'retired',
      ] as const) {
        const h = fixture(`tree-${mode}`, storage)
        if (mode.startsWith('finite')) {
          h.session.preset.treeBudgetCredits = 2
          h.session.preset.treeBudgetMode = 'capped'
        }
        const ledger = await createJevLedger(h.session)
        await ledger.commit(requested)
        if (requested.kind !== 'model.requested') throw new Error('expected request fixture')
        if (mode === 'before-dispatch') h.treeFailure(JEV_TREE_DISPATCH)
        if (mode === 'retired')
          await storage.sealSessionTree({
            rootSessionKey: h.session.key,
            retirementId: 'comparison',
            epoch: 1,
          })
        const admission = admitJevTreeRequest(
          h.session,
          requested.call,
          mode === 'finite-exceeded' ? 3 : undefined,
          new AbortController().signal,
        )
        if (mode === 'before-dispatch') await expect(admission).rejects.toThrow('tree append failed')
        else if (mode === 'retired') await expect(admission).rejects.toThrow(/sealed/)
        else if (mode.startsWith('finite')) await expect(admission).rejects.toThrow('reservation refused')
        else await admission
        h.treeFailure()
        const row = h.rows.find((entry) => entry.type === JEV_TREE_ADMISSION)
        const bound = row?.data as { rootTaskId: string; effectId: string; requestHash: string }
        const permit = await storage.lookupReservationByIdentity?.(
          bound.rootTaskId,
          bound.effectId,
          bound.requestHash,
        )
        if (mode === 'retired') {
          expect(permit).toBeNull()
          expect(h.rows.some((entry) => entry.type === JEV_TREE_DISPATCH)).toBe(false)
          await storage.close()
          storage = open()
          expect(() => storage.assertSessionAdmittedTree(h.session.key)).toThrow(/sealed/)
          continue
        }
        if (mode.startsWith('finite')) expect(permit).toBeNull()
        else expect(permit).toMatchObject({ status: 'held', qMicro: null })
        if (mode === 'fenced') {
          if (!permit) throw new Error('Expected a durable permit')
          await storage.takeoverReservation?.(permit.permitId, permit.writerGeneration)
          await expect(ledger.commit(settled)).rejects.toThrow('changed its admission binding')
          await storage.close()
          storage = open()
          h.setStorage(storage)
          await expect(createJevLedger(h.session)).rejects.toThrow('changed its admission binding')
          expect(h.rows.filter((entry) => entry.type === JEV_TREE_ACK)).toHaveLength(0)
          expect(await storage.peekReservation?.(permit.permitId)).toMatchObject({
            status: 'held',
            writerGeneration: permit.writerGeneration + 1,
          })
          continue
        }
        if (mode === 'ack-lost') h.treeFailure(JEV_TREE_ACK)
        const terminal =
          mode === 'known' || mode === 'ack-lost'
            ? settled
            : ({
                ...settled,
                settlement: { error: { code: 'INTERRUPTED', message: 'Interrupted', retryable: false } },
              } as RuntimeRecord)
        if (mode === 'ack-lost') await expect(ledger.commit(terminal)).rejects.toThrow('tree append failed')
        else await ledger.commit(terminal)
        h.treeFailure()
        if (mode === 'ack-lost') {
          const child = fixture('history-child', storage, h.rows.length)
          child.rows.push(...structuredClone(h.rows))
          await createJevLedger(child.session)
          expect(child.rows).toHaveLength(h.rows.length)
          expect(child.delivered).toHaveLength(0)
        }
        await storage.close()
        storage = open()
        h.setStorage(storage)
        await createJevLedger(h.session)
        await drainJevTreeBudget(h.session)
        expect(h.rows.filter((entry) => entry.type === JEV_TREE_ACK)).toHaveLength(1)
        if (permit) {
          const expected =
            mode === 'before-dispatch' ? 'released' : mode === 'unknown' ? 'unknown' : 'settled'
          expect(await storage.peekReservation?.(permit.permitId)).toMatchObject({ status: expected })
          expect(await storage.projectTree(bound.rootTaskId)).toMatchObject({
            capMicro: null,
            settledMicro: mode === 'known' || mode === 'ack-lost' ? 1_000_000n : 0n,
            unknownHeld: mode === 'unknown',
          })
        }
        await expect(
          admitJevTreeRequest(h.session, requested.call, undefined, new AbortController().signal),
        ).rejects.toThrow('already admitted or settled')
      }
    } finally {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps request identities distinct across sessions and does not invent missing usage', () => {
    const a = fixture('a'),
      b = fixture('b')
    const entries = [{ cursor: 1, record: requested }]
    const ca = projectJevCost(a.session, entries, settled)
    const cb = projectJevCost(b.session, entries, settled)
    expect(ca?.data).not.toEqual(cb?.data)
    expect(
      projectJevCost(a.session, entries, { ...settled, settlement: {} } as RuntimeRecord),
    ).toBeUndefined()
    expect(a.delivered).toHaveLength(0)
  })

  it('never calls the sink when the settlement transaction fails', async () => {
    const h = fixture(),
      ledger = await createJevLedger(h.session)
    await ledger.commit(requested)
    h.atomicFailure(true)
    await expect(ledger.commit(settled)).rejects.toThrow('atomic append failed')
    expect(h.delivered).toHaveLength(0)
    expect(h.rows).toHaveLength(1)
    expect(await ledger.read()).toHaveLength(1)
  })

  it('replays failed delivery on open, retaining settlement and original attribution without duplicate costs', async () => {
    const h = fixture(),
      ledger = await createJevLedger(h.session)
    await ledger.commit(requested)
    h.sinkFailure(true)
    await expect(ledger.commit(settled)).rejects.toThrow('pending Jev cost delivery')
    expect((await ledger.read()).map((entry) => entry.record.kind)).toEqual([
      'model.requested',
      'model.settled',
    ])
    expect(h.rows.map((row) => row.type)).toEqual([
      'runtime/record',
      'runtime/record',
      'cost/ledger',
      JEV_COST_OUTBOX,
    ])
    await expect(createJevLedger(h.session)).rejects.toThrow('pending Jev cost delivery')
    h.sinkFailure(false)
    h.position(9, 8)
    const reopened = await createJevLedger(h.session)
    expect(await reopened.read()).toHaveLength(2)
    expect(h.rows.filter((row) => row.type === 'cost/ledger')).toHaveLength(1)
    expect([...h.sink.values()]).toMatchObject([
      { sessionKey: 's', lane: 'main', turn: 2, step: 3, credits: 1 },
    ])
    const deliveries = h.delivered.length
    await drainJevCostOutbox(h.session)
    expect(h.delivered).toHaveLength(deliveries)
  })

  it('retries an unacknowledged successful delivery with the same idempotency key', async () => {
    const h = fixture(),
      ledger = await createJevLedger(h.session)
    await ledger.commit(requested)
    h.ackFailure(true)
    await expect(ledger.commit(settled)).rejects.toThrow('ack append failed')
    expect(h.sink.size).toBe(1)
    h.ackFailure(false)
    await createJevLedger(h.session)
    expect(h.delivered).toHaveLength(2)
    expect(h.delivered[0]).toEqual(h.delivered[1])
    expect(h.sink.size).toBe(1)
    expect(h.rows.filter((row) => row.type === JEV_COST_ACK)).toHaveLength(1)
    const inherited = h.rows.filter((row) => row.type !== JEV_COST_ACK)
    const child = fixture('history-child', {}, inherited.length)
    child.rows.push(...structuredClone(inherited))
    await createJevLedger(child.session)
    expect(child.delivered).toHaveLength(0)
    expect(child.rows.filter((row) => row.type === JEV_COST_ACK)).toHaveLength(0)
  })
})

describe('Jev answer settlement admission', () => {
  const thinking = Array.from({ length: 45 }, (_, index) => ({
    type: 'thinking_delta' as const,
    delta: `t${index}`,
  }))
  const thought = thinking.map((event) => event.delta).join('')
  const answerRequest = {
    version: 1,
    id: 'answer-request',
    turn: 'turn',
    step: 'step',
    attempt: 'attempt',
    kind: 'model.requested',
    call: {
      purpose: 'answer',
      backend: 'agnes-provider',
      endpoint: 'test',
      requestedModel: 'model',
      codec: 'agnes-language-v1',
      input: {},
      inputCursor: null,
    },
  } as RuntimeRecord
  const answerSettled = (settlement: {
    output: { kind: 'answer'; content: { kind: 'text'; text: string }[] }
    snapshot?: { codec: string; response: { events: import('@agnes/jev-runtime').JsonValue[] } }
  }) => {
    const value = {
      version: 1,
      id: 'answer-settled',
      turn: 'turn',
      step: 'step',
      attempt: 'attempt',
      kind: 'model.settled',
      requested: 'answer-request',
      settlement,
    }
    assertRuntimeRecord(value)
    return value
  }

  it('refuses stream/output forks on write and reopen, restores verified thinking, and keeps snapshot-less legacy readable', async () => {
    const forked = fixture('answer-fork')
    const forkedLedger = await createJevLedger(forked.session)
    await forkedLedger.commit(answerRequest)
    await expect(
      forkedLedger.commit(
        answerSettled({
          output: { kind: 'answer', content: [{ kind: 'text', text: 'OUTPUT_B_NOT_IN_STREAM' }] },
          snapshot: {
            codec: 'agnes-inference-v1',
            response: {
              events: [
                { type: 'text_delta', delta: 'STREAM_A' },
                { type: 'done', reason: 'stop' },
              ],
            },
          },
        }),
      ),
    ).rejects.toThrow('Completed Agnes answer lacks its native model stream')
    expect(forked.rows.filter((row) => row.type === 'assistant/message')).toEqual([])
    expect(forked.rows.filter((row) => row.type === 'runtime/record')).toHaveLength(1)

    const matched = fixture('answer-match')
    const matchedLedger = await createJevLedger(matched.session)
    await matchedLedger.commit(answerRequest)
    await matchedLedger.commit(
      answerSettled({
        output: { kind: 'answer', content: [{ kind: 'text', text: 'STREAM_A' }] },
        snapshot: {
          codec: 'agnes-inference-v1',
          response: {
            events: [
              ...thinking,
              { type: 'text_delta', delta: 'STREAM_A' },
              { type: 'done', reason: 'stop' },
            ],
          },
        },
      }),
    )
    expect(matched.rows.filter((row) => row.type === 'assistant/message').map((row) => row.data)).toEqual([
      { content: [{ type: 'text', text: 'STREAM_A' }], stopReason: 'end_turn' },
    ])
    const matchedSettled = (await matchedLedger.read())
      .map((entry) => entry.record)
      .find((record) => record.kind === 'model.settled')
    if (matchedSettled?.kind !== 'model.settled') throw new Error('Missing matched settlement')
    expect(assistantHistoryContent(matchedSettled.settlement)).toEqual([
      { type: 'thinking', text: thought },
      { type: 'text', text: 'STREAM_A' },
    ])

    const poisoned = fixture('answer-poison')
    await poisoned.session.d.log.append([
      poisoned.session.ev('runtime/record', {
        runtime: poisoned.session.runtimeIdentity,
        record: answerRequest,
      }),
      poisoned.session.ev('runtime/record', {
        runtime: poisoned.session.runtimeIdentity,
        record: answerSettled({
          output: { kind: 'answer', content: [{ kind: 'text', text: 'OUTPUT_B_NOT_IN_STREAM' }] },
          snapshot: {
            codec: 'agnes-inference-v1',
            response: {
              events: [
                { type: 'text_delta', delta: 'STREAM_A' },
                { type: 'done', reason: 'stop' },
              ],
            },
          },
        }),
      }),
    ])
    await expect(createJevLedger(poisoned.session)).rejects.toThrow(
      'Completed Agnes answer lacks its native model stream',
    )

    const legacy = fixture('answer-legacy')
    await legacy.session.d.log.append([
      legacy.session.ev('runtime/record', {
        runtime: legacy.session.runtimeIdentity,
        record: answerRequest,
      }),
      legacy.session.ev('runtime/record', {
        runtime: legacy.session.runtimeIdentity,
        record: answerSettled({
          output: { kind: 'answer', content: [{ kind: 'text', text: 'legacy portable answer' }] },
        }),
      }),
    ])
    const legacyLedger = await createJevLedger(legacy.session)
    const legacySettled = (await legacyLedger.read())
      .map((entry) => entry.record)
      .find((record) => record.kind === 'model.settled')
    if (legacySettled?.kind !== 'model.settled') throw new Error('Missing legacy settlement')
    expect(assistantHistoryContent(legacySettled.settlement)).toEqual([
      { type: 'text', text: 'legacy portable answer' },
    ])
  })
})
