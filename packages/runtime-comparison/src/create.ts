import type { ComparisonCreateParams, ComparisonSnapshot } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { ComparisonPreparedReceipt as PreparedSchema } from '@agnes/protocol/gen/agnes-v1'
import { type ComparisonPorts, type ComparisonRecord, SIDES } from './ports.js'
import { ComparisonError, canonical, creationFailure, read, snapshot, update } from './state.js'

export async function createComparison(
  ports: ComparisonPorts,
  params: ComparisonCreateParams,
): Promise<ComparisonSnapshot> {
  const input = JSON.parse(
    canonical({ ...params, isolation: params.isolation ?? 'snapshot' }),
  ) as ComparisonCreateParams
  if (input.isolation !== 'snapshot')
    throw new ComparisonError('UNSUPPORTED_ISOLATION', 'Worktree isolation is not implemented')
  const createPayload = canonical(input)
  const initial: ComparisonRecord = {
    id: input.requestId,
    revision: 0,
    createPayload,
    creation: 'preparing',
    permissionMode: input.permissionMode ?? 'workspace',
    lanes: {},
    rounds: [],
    cancellation: {},
    cleanup: { exited: [], released: false },
  }
  if (!(await ports.store.compareAndSwap(initial.id, null, initial))) {
    const existing = await read(ports.store, initial.id)
    if (existing.retirement?.state === 'removed')
      throw new ComparisonError('COMPARISON_REMOVED', 'Comparison results have been removed')
    if (existing.createPayload !== createPayload)
      throw new ComparisonError(
        'IDEMPOTENCY_CONFLICT',
        'Request identity is bound to different creation parameters',
      )
    return snapshot(existing)
  }
  try {
    const frozen = ports.resolveCreation ? structuredClone(await ports.resolveCreation(input)) : undefined
    if (frozen) {
      await update(ports.store, initial.id, (record) => {
        record.selection = structuredClone(frozen)
      })
    }
    const selection = frozen ?? input
    const baseline = structuredClone(
      await ports.workspaces.prepare({ comparisonId: initial.id, cwd: input.cwd }),
    )
    if (
      !baseline.id ||
      !/^[a-f0-9]{64}$/.test(baseline.digest) ||
      !/^[a-f0-9]{64}$/.test(baseline.policyHash) ||
      !baseline.roots.left ||
      !baseline.roots.right ||
      baseline.roots.left === baseline.roots.right ||
      SIDES.some((side) => baseline.roots[side] === input.cwd)
    )
      throw new ComparisonError(
        'INVALID_BASELINE',
        'Workspace isolation did not produce two independent roots',
      )
    await update(ports.store, initial.id, (record) => {
      record.baseline = structuredClone(baseline)
    })
    // Wait for both preparations, including late successes, before deciding whether cleanup is needed.
    const prepared = await Promise.allSettled(
      SIDES.map(async (side) =>
        ports.sessions.create({
          comparisonId: initial.id,
          side,
          cwd: baseline.roots[side],
          runtime: input[side].runtime,
          ...(selection.preset === undefined ? {} : { preset: selection.preset }),
          ...(selection.model === undefined ? {} : { model: structuredClone(selection.model) }),
        }),
      ),
    )
    const ready = await update(ports.store, initial.id, (record) => {
      for (const [index, result] of prepared.entries())
        if (result.status === 'fulfilled') {
          const side = SIDES[index]!
          const { prepared: receipt, ...lane } = result.value
          if (
            lane.side !== side ||
            lane.runtime.id !== input[side].runtime ||
            !lane.sessionId ||
            lane.phase !== 'idle' ||
            !Number.isSafeInteger(lane.lastSeq) ||
            lane.lastSeq < 0
          )
            throw new ComparisonError(
              'INVALID_SESSION',
              'Session preparation returned invalid lane ownership',
            )
          record.lanes[side] = { ...structuredClone(lane), workspaceLabel: baseline.labels[side] }
          if (receipt) {
            if (
              !validateAgainst(PreparedSchema, receipt).ok ||
              receipt.sessionId !== lane.sessionId ||
              receipt.sourceSeq > lane.lastSeq ||
              receipt.configuration.runtime.id !== lane.runtime.id ||
              receipt.configuration.runtime.version !== lane.runtime.version
            )
              throw new ComparisonError('INVALID_SESSION', 'Preparation receipt does not match its lane')
            record.prepared ??= {}
            record.prepared[side] = structuredClone(receipt)
          }
        }
      if (
        prepared.some((result) => result.status === 'rejected') ||
        record.lanes.left?.sessionId === record.lanes.right?.sessionId
      ) {
        const refusal = prepared.find(
          (result) =>
            result.status === 'rejected' &&
            creationFailure(result.reason).code !== 'COMPARISON_CREATE_FAILED',
        )
        if (refusal?.status === 'rejected') throw creationFailure(refusal.reason)
        throw new ComparisonError('COMPARISON_CREATE_FAILED', 'Comparison session preparation failed')
      }
      record.creation = 'ready'
      const left = record.prepared?.left?.configuration.fingerprints
      const right = record.prepared?.right?.configuration.fingerprints
      if (
        left &&
        right &&
        ((['tools', 'model', 'preset', 'permission'] as const).some(
          (key) => left[key] !== null && right[key] !== null && left[key] !== right[key],
        ) ||
          (typeof left.mounted === 'string' &&
            typeof right.mounted === 'string' &&
            left.mounted !== right.mounted))
      )
        throw new ComparisonError(
          'CONFIGURATION_MISMATCH',
          'Lane preparation produced different common configuration',
        )
    })
    return snapshot(ready)
  } catch (error) {
    const failure = creationFailure(error)
    // Retire the reserved identities before closing either owner. Otherwise a raw session.open
    // racing cleanup could reopen a lane after its close proof and before workspace deletion.
    await update(ports.store, initial.id, (record) => {
      record.creation = 'failed'
      record.error = { code: failure.code, message: failure.message }
      if (record.retirement === undefined || record.retirement.state === 'full')
        record.retirement = { state: 'releasing', epoch: record.revision + 1 }
    })
    const closed = await Promise.allSettled(
      SIDES.map(async (side) => ports.sessions.close({ comparisonId: initial.id, side })),
    )
    const exited = SIDES.filter((_, index) => {
      const result = closed[index]!
      return result.status === 'fulfilled' && result.value.exited
    })
    let released = false
    if (exited.length === 2) {
      try {
        await ports.workspaces.release(initial.id)
        released = true
      } catch {
        /* Durable failure retains ownership for explicit cleanup. */
      }
    }
    await update(ports.store, initial.id, (record) => {
      record.creation = 'failed'
      record.error = { code: failure.code, message: failure.message }
      record.cleanup = { exited, released }
    })
    throw failure
  }
}
