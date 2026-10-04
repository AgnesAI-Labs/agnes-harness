import {
  CoreError,
  canonicalJson,
  capToMicrocredits,
  chargeToMicrocredits,
  hasChildControl,
  hasDurableReservations,
  type SessionImpl,
  scanAll,
  sha256Hex,
} from '@agnes/core'
import { assertRuntimeRecord, type PreparedModelCall, type RuntimeRecord } from '@agnes/jev-runtime'
import { type InferenceEvent, validateAgainst } from '@agnes/protocol'
import { InferenceEvent as InferenceEventSchema } from '@agnes/protocol/gen/model'
import { assertRuntimeOwner } from '@agnes/runtime-api'

export const JEV_TREE_ADMISSION = 'x/agnes/jev-tree-admission'
export const JEV_TREE_DISPATCH = 'x/agnes/jev-tree-dispatch'
export const JEV_TREE_ACK = 'x/agnes/jev-tree-ack'

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

function failure(message: string): never {
  throw new CoreError('E_BUDGET', message)
}
function runtimeRecord(s: SessionImpl, data: unknown): RuntimeRecord {
  const value = data as { runtime?: unknown; record?: unknown } | null
  assertRuntimeOwner(value?.runtime, s.runtimeIdentity)
  assertRuntimeRecord(value?.record)
  return value.record
}

const identity = (s: SessionImpl, requestedId: string) =>
  sha256Hex(canonicalJson(['jev-tree-model', s.key, s.lane, requestedId]))

/** Keep the portable loop independent of storage, currency units, and Host budget policy. */
export async function assertJevTreeBudgetAvailable(s: SessionImpl): Promise<void> {
  const storage = s.d.log.storage
  const required =
    s.preset.treeBudgetCredits !== null ||
    s.preset.treeBudgetMode === 'unlimited' ||
    (storage && hasChildControl(storage) && !!(await storage.lookupByKey(s.key)))
  if (required && (!storage || !hasDurableReservations(storage)))
    failure('Durable Jev tree-budget reservation is unavailable')
  if (s.preset.treeBudgetMode === 'unlimited' && s.preset.treeBudgetCredits !== null)
    failure('Conflicting tree budget configuration')
}

/**
 * The admission intent precedes reserve, so a crash between reserve and dispatch remains locatable.
 * Dispatch is written only after a fresh permit. A retry never turns an existing permit into a call.
 */
export async function admitJevTreeRequest(
  s: SessionImpl,
  call: PreparedModelCall,
  upperCredits: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  await assertJevTreeBudgetAvailable(s)
  const storage = s.d.log.storage
  if (!storage || !hasDurableReservations(storage)) return
  const child = await storage.lookupByKey(s.key)
  if (!child && s.preset.treeBudgetCredits === null && s.preset.treeBudgetMode !== 'unlimited') return
  if (upperCredits !== undefined && (!Number.isFinite(upperCredits) || upperCredits < 0))
    failure('Invalid tree request price upper bound')
  await s.locked(async () => {
    signal.throwIfAborted()
    const rows = await scanAll((query) => s.scan(query), {
      type: ['runtime/record', JEV_TREE_ADMISSION],
      fromSeq: (s.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: s.lastSeq,
    })
    const fingerprint = sha256Hex(canonicalJson(call))
    const request = rows.findLast((row) => {
      if (row.type !== 'runtime/record' || row.lane !== s.lane) return false
      const record = runtimeRecord(s, row.data)
      return record.kind === 'model.requested' && sha256Hex(canonicalJson(record.call)) === fingerprint
    })
    if (!request) failure('Tree request has no durable model request')
    const requested = runtimeRecord(s, request.data)
    if (
      rows.some((row) => {
        if (row.type === JEV_TREE_ADMISSION) return (row.data as Admission).requestedId === requested.id
        const record = runtimeRecord(s, row.data)
        return record.kind === 'model.settled' && record.requested === requested.id
      })
    )
      failure('Tree model request was already admitted or settled')
    const rootTaskId =
      child?.rootTaskId ?? `${s.key}:${s.lane}:${s.state.openTurn.get(s.lane)?.startSeq ?? 0}`
    const scopeIds = child?.ancestorScopeIds ?? [
      (
        await storage.ensureRootScope(
          rootTaskId,
          s.preset.treeBudgetCredits === null ? null : capToMicrocredits(s.preset.treeBudgetCredits),
        )
      ).scopeId,
    ]
    const admission: Admission = {
      requestedId: requested.id,
      requestedSeq: request.seq,
      rootTaskId,
      scopeIds: [...scopeIds],
      effectId: identity(s, requested.id),
      requestHash: sha256Hex(canonicalJson({ fingerprint, upperCredits: upperCredits ?? null })),
      qMicro: upperCredits === undefined ? null : chargeToMicrocredits(upperCredits).toString(),
      writerGeneration: await storage.writerGeneration(rootTaskId),
    }
    const receipt = await s.d.log.append([
      s.ev(JEV_TREE_ADMISSION, admission, { ignorable: true, sourceEventSeqs: [request.seq] }),
    ])
    const permit = await storage.reserve({
      ...admission,
      originSessionKey: s.key,
      qMicro: admission.qMicro === null ? null : BigInt(admission.qMicro),
    })
    if (!permit.ok) failure(`Tree model reservation refused: ${permit.reason}`)
    if (permit.existing || permit.status !== 'held') failure('Tree model reservation is not a fresh permit')
    if (signal.aborted) {
      await storage.releaseReservation({
        permitId: permit.permitId,
        writerGeneration: admission.writerGeneration,
      })
      signal.throwIfAborted()
    }
    await s.d.log.append([
      s.ev(
        JEV_TREE_DISPATCH,
        { admissionSeq: receipt.firstSeq, permitId: permit.permitId },
        {
          ignorable: true,
          sourceEventSeqs: [request.seq, receipt.firstSeq],
        },
      ),
    ])
  })
}

/** Replay settlement only after the model result is durable; every store operation is idempotent. */
export async function drainJevTreeBudget(s: SessionImpl): Promise<void> {
  const storage = s.d.log.storage
  if (!storage || !hasDurableReservations(storage)) return
  await s.locked(async () => {
    const rows = await scanAll((query) => s.scan(query), {
      type: ['runtime/record', JEV_TREE_ADMISSION, JEV_TREE_DISPATCH, JEV_TREE_ACK],
      fromSeq: (s.d.log.parent?.boundarySeq ?? 0) + 1,
      toSeq: s.lastSeq,
    })
    const acknowledged = new Set(
      rows
        .filter((row) => row.type === JEV_TREE_ACK)
        .map((row) => (row.data as { admissionSeq: number }).admissionSeq),
    )
    for (const row of rows) {
      if (row.type !== JEV_TREE_ADMISSION || acknowledged.has(row.seq)) continue
      const admission = row.data as Admission
      const request = rows.find((entry) => entry.seq === admission.requestedSeq)
      const requested = request?.type === 'runtime/record' ? runtimeRecord(s, request.data) : undefined
      if (
        row.lane !== s.lane ||
        !request ||
        requested?.kind !== 'model.requested' ||
        requested.id !== admission.requestedId ||
        request.seq >= row.seq ||
        admission.effectId !== identity(s, requested.id) ||
        !/^[a-f0-9]{64}$/u.test(admission.requestHash) ||
        !Number.isSafeInteger(admission.writerGeneration) ||
        admission.writerGeneration < 1
      )
        failure('Invalid durable tree admission binding')
      const settled = rows.find(
        (entry) =>
          entry.type === 'runtime/record' &&
          (() => {
            const record = runtimeRecord(s, entry.data)
            return record.kind === 'model.settled' && record.requested === admission.requestedId
          })(),
      )
      if (!settled) continue
      const permit = await storage.lookupReservationByIdentity(
        admission.rootTaskId,
        admission.effectId,
        admission.requestHash,
      )
      const dispatch = rows.find(
        (entry) =>
          entry.type === JEV_TREE_DISPATCH &&
          (entry.data as { admissionSeq: number }).admissionSeq === row.seq,
      )
      if (dispatch && (!permit || (dispatch.data as { permitId: string }).permitId !== permit.permitId))
        failure('Durable tree dispatch has no matching permit')
      if (permit) {
        if (
          canonicalJson(permit.scopeIds) !== canonicalJson(admission.scopeIds) ||
          (permit.qMicro?.toString() !== admission.qMicro &&
            !(permit.qMicro === null && admission.qMicro === null)) ||
          permit.writerGeneration !== admission.writerGeneration
        )
          failure('Durable tree permit changed its admission binding')
        if (!dispatch) {
          if (permit.status !== 'held' && permit.status !== 'released')
            failure('Undispatched tree reservation has an inconsistent settlement')
          await storage.releaseReservation({
            permitId: permit.permitId,
            writerGeneration: admission.writerGeneration,
          })
        } else {
          const record = runtimeRecord(s, settled.data)
          if (record.kind !== 'model.settled') failure('Invalid tree settlement record')
          const usage = validateAgainst<InferenceEvent>(InferenceEventSchema, record.settlement.usage)
          const charge =
            usage.ok && usage.value.type === 'usage' && usage.value.credits !== undefined
              ? usage.value
              : undefined
          await storage.settleOrigin({
            permitId: permit.permitId,
            writerGeneration: admission.writerGeneration,
            originSessionKey: s.key,
            originCostSeq: settled.seq,
            actualMicro: charge?.credits === undefined ? null : chargeToMicrocredits(charge.credits),
            complete: charge !== undefined,
            creditSource: charge?.creditSource ?? 'unknown',
          })
        }
      }
      await s.d.log.append([
        s.ev(
          JEV_TREE_ACK,
          { admissionSeq: row.seq, settledSeq: settled.seq },
          {
            ignorable: true,
            sourceEventSeqs: [row.seq, settled.seq],
          },
        ),
      ])
    }
  })
}
