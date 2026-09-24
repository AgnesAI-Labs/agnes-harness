import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { SessionImpl, TurnEndReason } from '../step/session.js'
import { CoreError, type Seq } from '../types.js'
import { capToMicrocredits, chargeToMicrocredits, conservativeModelCredits } from './credits.js'
import { hasChildControl, hasDurableReservations } from './store.js'

export type TreePermit = {
  permitId: string
  requestHash: string
  maxTokens?: number
  rootTaskId?: string
  writerGeneration?: number
}
export type TreeBudgetTarget = { route: string; model: string }
export type TreeReservationIdentity = { effectId: string; requestHash: string }

declare const explicitTreeReservation: unique symbol
export type TreeReservationHandle = TreePermit & {
  readonly effectId: string
  readonly rootTaskId: string
  readonly writerGeneration: number
  readonly [explicitTreeReservation]: true
}

export type TreeReservationResult =
  | { status: 'unreserved' }
  | { status: 'blocked'; reason: TurnEndReason }
  | {
      status: 'terminal'
      durableStatus: 'settled' | 'released' | 'unknown'
      permitId: string
      effectId: string
      requestHash: string
    }
  | {
      status: 'reserved'
      handle: TreeReservationHandle
      existing: boolean
      durableStatus: 'held'
    }

type ExplicitReservationState = {
  session: SessionImpl
  status: 'held' | 'releasing' | 'released' | 'settling' | 'settled' | 'unknown'
  operation?: Promise<void>
  settlement?: {
    credits: number | undefined
    originSeq: Seq
    creditSource: 'gateway' | 'estimated' | 'unknown'
  }
}

type ExplicitReservationIdentity = {
  auditBindingHash: string
  quoteHash: string
  result: Promise<TreeReservationResult>
}

const lastTreePermit = new WeakMap<SessionImpl, TreePermit>()
const explicitTreeReservations = new WeakMap<TreeReservationHandle, ExplicitReservationState>()
const explicitReservationIdentities = new WeakMap<SessionImpl, Map<string, ExplicitReservationIdentity>>()

export function setTreePermit(s: SessionImpl, permit: TreePermit): void {
  lastTreePermit.set(s, permit)
}

/** Child records inherit the tree even when the live preset no longer names a cap. */
export async function treeBudgetApplies(s: SessionImpl): Promise<boolean> {
  const storage = s.d.log.storage
  return (
    hasChildControl(storage) && (!!(await storage.lookupByKey(s.key)) || s.preset.treeBudgetCredits !== null)
  )
}

async function reserveTreeBudgetPermit(
  s: SessionImpl,
  projectedCredits: number,
  target: TreeBudgetTarget,
  identity: TreeReservationIdentity | undefined,
  endTurnOnBlocked: boolean,
  inputTokens = 0,
  quotedModel?: ReturnType<SessionImpl['d']['provider']['models']>[number] | null,
): Promise<
  | 'unreserved'
  | { reason: TurnEndReason }
  | {
      permit: TreePermit
      effectId: string
      existing: boolean
      durableStatus: 'held' | 'settled' | 'released' | 'unknown'
    }
> {
  const storage = s.d.log.storage
  if (!(await treeBudgetApplies(s)) || !hasChildControl(storage)) return 'unreserved'
  const rec = await storage.lookupByKey(s.key)
  const treeCredits = s.preset.treeBudgetCredits
  if (!Number.isFinite(projectedCredits) || projectedCredits < 0) {
    if (endTurnOnBlocked) await s.endTurn('budget')
    return { reason: 'budget' }
  }
  let scopeIds = rec?.ancestorScopeIds
  let rootTaskId = rec?.rootTaskId
  if (!rec && treeCredits !== null) {
    rootTaskId = `${s.key}:${s.lane}:${s.state.openTurn.get(s.lane)?.startSeq ?? 0}`
    const root = await storage.ensureRootScope(rootTaskId, capToMicrocredits(treeCredits))
    scopeIds = [root.scopeId]
  }
  if (!rootTaskId || !scopeIds?.length) return 'unreserved'
  let recModel = quotedModel ?? undefined
  if (quotedModel === undefined) {
    let catalogue: ReturnType<typeof s.d.provider.models> = []
    try {
      catalogue = s.d.provider.models()
    } catch {
      catalogue = []
    }
    recModel = catalogue.find((item) => item.route === target.route && item.id === target.model)
  }
  // A model resolved by a pinned id (resolveModel's `pinned` branch) may legitimately never appear
  // in the local static catalogue snapshot — remote catalogues publish ids only. Missing or
  // incomplete catalogue data means "no conservative upper bound available", not "refuse the
  // turn": the ledger's own history-based projectedCredits is still a real signal, so fall back to
  // holding against that alone rather than failing the whole turn closed over a listing gap.
  const complete =
    !!recModel &&
    Number.isFinite(recModel.maxTokens) &&
    recModel.maxTokens > 0 &&
    Number.isFinite(recModel.cost.input) &&
    Number.isFinite(recModel.cost.output)
  const upper =
    complete && recModel ? conservativeModelCredits(inputTokens, recModel.maxTokens, recModel.cost) : 0
  const hold = Math.max(projectedCredits, upper)
  const requestHash =
    complete && recModel
      ? `${recModel.route}/${recModel.id}/${recModel.maxTokens}/${recModel.cost.input}/${recModel.cost.output}`
      : `${target.route}/${target.model}/unlisted`
  const effectId = identity?.effectId ?? `preflight:${s.key}:${s.lastSeq}:${hold}`
  const boundRequestHash = identity?.requestHash ?? requestHash
  const writerGeneration = (await storage.writerGeneration?.(rootTaskId)) ?? 1
  const reserved = await storage.reserve({
    rootTaskId,
    scopeIds,
    qMicro: chargeToMicrocredits(hold),
    effectId,
    requestHash: boundRequestHash,
    writerGeneration,
  })
  if (!reserved.ok) {
    if (endTurnOnBlocked) await s.endTurn('budget')
    return { reason: 'budget' }
  }
  if (identity === undefined && reserved.status !== 'held') {
    if (endTurnOnBlocked) await s.endTurn('budget')
    return { reason: 'budget' }
  }
  if (reserved.existing && identity !== undefined) {
    if (!storage.lookupReservationByIdentity)
      throw new CoreError('E_UNSUPPORTED', 'durable reservation recovery is unavailable')
    const durable = await storage.lookupReservationByIdentity(rootTaskId, effectId, boundRequestHash)
    if (!durable || durable.permitId !== reserved.permitId || durable.status !== reserved.status)
      throw new CoreError('E_BUDGET', 'durable tree reservation recovery disagrees with reserve result', {
        permitId: reserved.permitId,
      })
  }
  return {
    effectId,
    existing: reserved.existing,
    durableStatus: reserved.status,
    permit: {
      permitId: reserved.permitId,
      requestHash: boundRequestHash,
      rootTaskId,
      writerGeneration,
      ...(complete && recModel ? { maxTokens: recModel.maxTokens } : {}),
    },
  }
}

export async function reserveTreeBudget(
  s: SessionImpl,
  projectedCredits: number,
  target: TreeBudgetTarget,
  inputTokens = 0,
): Promise<'ok' | { reason: TurnEndReason }> {
  const reserved = await reserveTreeBudgetPermit(s, projectedCredits, target, undefined, true, inputTokens)
  if (reserved === 'unreserved') return 'ok'
  if ('reason' in reserved) return reserved
  setTreePermit(s, reserved.permit)
  return 'ok'
}

/**
 * Reserve a tree-budget hold without replacing the primary inference permit.
 * The effect id and a hash binding the caller's request identity to its full quote are persisted.
 */
export async function reserveTreeBudgetHandle(
  s: SessionImpl,
  projectedCredits: number,
  target: TreeBudgetTarget,
  identity: TreeReservationIdentity,
  inputTokens = 0,
): Promise<TreeReservationResult> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(identity.effectId) ||
    /(?:authorization|bearer|credential|secret|password|api[_-]?key|token|sk-[A-Za-z0-9])/iu.test(
      identity.effectId,
    ) ||
    !/^[0-9a-f]{64}$/u.test(identity.requestHash)
  )
    throw new CoreError('E_BUDGET', 'explicit tree reservation audit identity is invalid')
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
    throw new CoreError('E_BUDGET', 'explicit tree reservation input token quote is invalid')
  // A session outside any configured/inherited tree does not need a durable reservation backend.
  // Preserve legacy storage compatibility by deciding applicability before the narrow capability gate.
  if (!(await treeBudgetApplies(s))) return { status: 'unreserved' }
  if (!hasDurableReservations(s.d.log.storage))
    throw new CoreError('E_UNSUPPORTED', 'durable explicit tree reservations are unavailable')
  let recModel: ReturnType<typeof s.d.provider.models>[number] | undefined
  try {
    recModel = s.d.provider.models().find((item) => item.route === target.route && item.id === target.model)
  } catch {
    recModel = undefined
  }
  const quoteHash = sha256Hex(
    canonicalJson({
      auditBindingHash: identity.requestHash,
      target,
      projectedCredits,
      inputTokens,
      model: recModel
        ? {
            route: recModel.route,
            id: recModel.id,
            contractId: recModel.contract_id,
            maxTokens: recModel.maxTokens,
            cost: recModel.cost,
          }
        : null,
    }),
  )
  let identities = explicitReservationIdentities.get(s)
  if (!identities) {
    identities = new Map()
    explicitReservationIdentities.set(s, identities)
  }
  const prior = identities.get(identity.effectId)
  if (prior) {
    if (prior.auditBindingHash !== identity.requestHash || prior.quoteHash !== quoteHash)
      throw new CoreError('E_BUDGET', 'explicit tree reservation identity was reused with a different quote')
    const cached = await prior.result
    if (cached.status === 'reserved') {
      const state = explicitTreeReservations.get(cached.handle)
      // A failed terminal write has an ambiguous outcome. Never return the cached dispatchable
      // handle until the caller explicitly reconciles it against the durable record.
      if (state?.status === 'unknown')
        return {
          status: 'terminal',
          durableStatus: 'unknown',
          permitId: cached.handle.permitId,
          effectId: cached.handle.effectId,
          requestHash: cached.handle.requestHash,
        }
    }
    return cached
  }
  const result = (async (): Promise<TreeReservationResult> => {
    const boundIdentity = { ...identity, requestHash: quoteHash }
    const reserved = await reserveTreeBudgetPermit(
      s,
      projectedCredits,
      target,
      boundIdentity,
      false,
      inputTokens,
      recModel ?? null,
    )
    if (reserved === 'unreserved') return { status: 'unreserved' }
    if ('reason' in reserved) return { status: 'blocked', reason: reserved.reason }
    if (reserved.durableStatus !== 'held')
      return {
        status: 'terminal',
        durableStatus: reserved.durableStatus,
        permitId: reserved.permit.permitId,
        effectId: reserved.effectId,
        requestHash: reserved.permit.requestHash,
      }
    const handle = Object.freeze({
      ...reserved.permit,
      effectId: reserved.effectId,
    }) as TreeReservationHandle
    explicitTreeReservations.set(handle, { session: s, status: 'held' })
    return {
      status: 'reserved',
      handle,
      existing: reserved.existing,
      durableStatus: reserved.durableStatus,
    }
  })()
  identities.set(identity.effectId, {
    auditBindingHash: identity.requestHash,
    quoteHash,
    result,
  })
  try {
    const resolved = await result
    if (resolved.status !== 'reserved') identities.delete(identity.effectId)
    return resolved
  } catch (error) {
    identities.delete(identity.effectId)
    throw error
  }
}

function invalidateReservationIdentity(s: SessionImpl, effectId: string): void {
  explicitReservationIdentities.get(s)?.delete(effectId)
}

function explicitReservationState(s: SessionImpl, handle: TreeReservationHandle): ExplicitReservationState {
  const state = explicitTreeReservations.get(handle)
  if (!state || state.session !== s)
    throw new CoreError('E_BUDGET', 'tree reservation handle does not belong to this session', {
      permitId: handle.permitId,
    })
  return state
}

/** Repeated releases are idempotent; releasing a settling/settled hold is an error. */
export async function releaseTreeReservationHandle(
  s: SessionImpl,
  handle: TreeReservationHandle,
): Promise<void> {
  const state = explicitReservationState(s, handle)
  if (state.status === 'unknown')
    throw new CoreError('E_BUDGET', 'tree reservation outcome requires reconciliation', {
      permitId: handle.permitId,
    })
  if (state.status === 'released' || state.status === 'releasing') return state.operation
  if (state.status !== 'held')
    throw new CoreError('E_BUDGET', 'tree reservation was already settled', { permitId: handle.permitId })
  const storage = s.d.log.storage
  if (!hasDurableReservations(storage))
    throw new CoreError('E_UNSUPPORTED', 'durable explicit tree reservations are unavailable')
  const operation = storage.releaseReservation({
    permitId: handle.permitId,
    writerGeneration: handle.writerGeneration,
  })
  state.status = 'releasing'
  state.operation = operation
  try {
    await operation
    state.status = 'released'
    invalidateReservationIdentity(s, handle.effectId)
  } catch (error) {
    state.status = 'unknown'
    throw error
  }
}

/**
 * Repeating the identical settlement is idempotent. A different settlement or release after the
 * first terminal operation fails closed, including when the provider outcome is unknown.
 */
export async function settleTreeSpendHandle(
  s: SessionImpl,
  handle: TreeReservationHandle,
  credits: number | undefined,
  originSeq: Seq,
  creditSource: 'gateway' | 'estimated' | 'unknown' = credits === undefined ? 'unknown' : 'estimated',
): Promise<void> {
  if (!Number.isSafeInteger(originSeq) || originSeq < 1)
    throw new CoreError('E_BUDGET', 'tree reservation origin sequence is invalid')
  if (credits !== undefined && (!Number.isFinite(credits) || credits < 0))
    throw new CoreError('E_BUDGET', 'tree reservation settlement credits are invalid')
  if (
    (credits === undefined && creditSource !== 'unknown') ||
    (credits !== undefined && creditSource === 'unknown')
  )
    throw new CoreError('E_BUDGET', 'tree reservation settlement credit source is inconsistent')
  const state = explicitReservationState(s, handle)
  if (state.status === 'unknown')
    throw new CoreError('E_BUDGET', 'tree reservation outcome requires reconciliation', {
      permitId: handle.permitId,
    })
  if (state.status === 'settling' || state.status === 'settled') {
    const settlement = state.settlement
    if (
      settlement &&
      settlement.credits === credits &&
      settlement.originSeq === originSeq &&
      settlement.creditSource === creditSource
    )
      return state.operation
    throw new CoreError('E_BUDGET', 'tree reservation has a different settlement', {
      permitId: handle.permitId,
    })
  }
  if (state.status !== 'held')
    throw new CoreError('E_BUDGET', 'tree reservation was already released', {
      permitId: handle.permitId,
    })
  const storage = s.d.log.storage
  if (!hasDurableReservations(storage))
    throw new CoreError('E_UNSUPPORTED', 'durable explicit tree reservations are unavailable')
  const operation = storage.settleOrigin({
    permitId: handle.permitId,
    writerGeneration: handle.writerGeneration,
    originSessionKey: s.key,
    originCostSeq: originSeq,
    actualMicro: credits === undefined ? null : chargeToMicrocredits(credits),
    complete: credits !== undefined,
    creditSource,
  })
  state.status = 'settling'
  state.settlement = { credits, originSeq, creditSource }
  state.operation = operation
  try {
    await operation
    state.status = credits === undefined ? 'unknown' : 'settled'
    invalidateReservationIdentity(s, handle.effectId)
  } catch (error) {
    // A rejected settlement may already have consumed or marked the durable permit unknown. It is
    // not replayable until the store reports the permit's durable status.
    state.status = 'unknown'
    throw error
  }
}

export type TreeReservationReconciliation =
  | { status: 'held' | 'released' | 'settled' | 'unknown' }
  | { status: 'unsupported' }

/** Reconcile an ambiguous local operation using the durable permit record, when the store supports it. */
export async function reconcileTreeReservationHandle(
  s: SessionImpl,
  handle: TreeReservationHandle,
): Promise<TreeReservationReconciliation> {
  const state = explicitReservationState(s, handle)
  const storage = s.d.log.storage
  if (!hasDurableReservations(storage)) return { status: 'unsupported' }
  const durable = await storage.peekReservation(handle.permitId)
  if (!durable || durable.effectId !== handle.effectId || durable.requestHash !== handle.requestHash)
    throw new CoreError('E_BUDGET', 'durable tree reservation identity does not match its handle', {
      permitId: handle.permitId,
    })
  if (durable.status === 'held') {
    state.status = 'held'
    delete state.operation
  } else if (durable.status === 'released') {
    state.status = 'released'
    state.operation = Promise.resolve()
  } else if (durable.status === 'settled') {
    state.status = 'settled'
    state.operation = Promise.resolve()
  } else {
    // Unknown spend remains non-replayable even after it has been located durably.
    state.status = 'unknown'
    delete state.operation
  }
  if (durable.status !== 'held') invalidateReservationIdentity(s, handle.effectId)
  return { status: durable.status }
}

/**
 * Explicit recovery/takeover fence. Production recovery must call this deliberately; ordinary
 * reservation retries never bump the generation.
 */
export async function takeoverTreeReservationWriter(
  s: SessionImpl,
  handle: TreeReservationHandle,
): Promise<TreeReservationHandle> {
  const state = explicitReservationState(s, handle)
  if (state.status !== 'held')
    throw new CoreError('E_BUDGET', 'only a held tree reservation can be taken over', {
      permitId: handle.permitId,
    })
  const storage = s.d.log.storage
  if (!hasDurableReservations(storage))
    throw new CoreError('E_UNSUPPORTED', 'durable explicit tree reservations are unavailable')
  const durable = await storage.takeoverReservation(handle.permitId, handle.writerGeneration)
  if (
    durable.rootTaskId !== handle.rootTaskId ||
    durable.effectId !== handle.effectId ||
    durable.requestHash !== handle.requestHash
  )
    throw new CoreError('E_BUDGET', 'reservation takeover returned a different durable identity', {
      permitId: handle.permitId,
    })
  // The generation is a root-wide epoch. Invalidate every cached handle from the old writer, not
  // only the permit used to authorize takeover; each sibling identity must be recovered at the new
  // generation before it can dispatch again.
  const identities = explicitReservationIdentities.get(s)
  const identity = identities?.get(handle.effectId)
  if (identities) {
    for (const [effectId, cachedIdentity] of [...identities]) {
      const cached = await cachedIdentity.result
      if (cached.status !== 'reserved' || cached.handle.rootTaskId !== handle.rootTaskId) continue
      const cachedState = explicitTreeReservations.get(cached.handle)
      if (cachedState) cachedState.status = 'unknown'
      identities.delete(effectId)
    }
  } else {
    state.status = 'unknown'
  }
  const next = Object.freeze({
    ...handle,
    writerGeneration: durable.writerGeneration,
  }) as TreeReservationHandle
  explicitTreeReservations.set(next, { session: s, status: 'held' })
  if (identity)
    identities?.set(handle.effectId, {
      ...identity,
      result: Promise.resolve({
        status: 'reserved',
        handle: next,
        existing: true,
        durableStatus: 'held',
      }),
    })
  return next
}

export function treePermitOf(s: SessionImpl): TreePermit | undefined {
  return lastTreePermit.get(s)
}

export function clearTreePermit(s: SessionImpl): void {
  lastTreePermit.delete(s)
}

/** Release a reservation when the request is refused before any provider effect can start. */
export async function releaseTreeReservation(s: SessionImpl): Promise<void> {
  const permit = lastTreePermit.get(s)
  if (!permit) return
  try {
    const storage = s.d.log.storage
    if (hasChildControl(storage))
      await storage.releaseReservation(
        permit.writerGeneration === undefined
          ? permit.permitId
          : { permitId: permit.permitId, writerGeneration: permit.writerGeneration },
      )
  } finally {
    lastTreePermit.delete(s)
  }
}

export async function settleTreeSpend(
  s: SessionImpl,
  credits: number | undefined,
  originSeq: Seq,
): Promise<void> {
  const storage = s.d.log.storage
  if (!hasChildControl(storage)) return
  const permit = lastTreePermit.get(s)
  if (!permit) return
  try {
    await storage.settleOrigin({
      permitId: permit.permitId,
      ...(permit.writerGeneration === undefined ? {} : { writerGeneration: permit.writerGeneration }),
      originSessionKey: s.key,
      originCostSeq: originSeq,
      actualMicro: credits === undefined ? null : chargeToMicrocredits(credits),
      complete: credits !== undefined,
      creditSource: credits === undefined ? 'unknown' : 'estimated',
    })
  } finally {
    lastTreePermit.delete(s)
  }
}
