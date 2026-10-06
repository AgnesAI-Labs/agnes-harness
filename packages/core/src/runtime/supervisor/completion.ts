import type * as W from '@agnes/protocol/runtime'

export type ActionFact = Readonly<{
  actionId: string
  parentActionId: string | null
  state: W.ActionState
  obligation: 'mandatory' | 'detached'
  owner: W.OwnerRef
}>

export type TerminalVerdict =
  | Readonly<{
      ok: true
      /** Non-empty only for fail/cancel: unresolved effects that must carry an owner into the terminal record. */
      unknownActionIds: readonly string[]
      detachedOwnerRefs: readonly W.OwnerRef[]
    }>
  | Readonly<{ ok: false; code: 'conflict' | 'invalid_input'; detailCode: string }>

const UNKNOWN: ReadonlySet<W.ActionState> = new Set(['unknown', 'reconciling'])
const refuse = (code: 'conflict' | 'invalid_input', detailCode: string): TerminalVerdict => ({
  ok: false,
  code,
  detailCode,
})

/** Complete needs every mandatory action settled, no unresolved unknown effect, no open attached child,
 * and no action created in the same batch. Detached actions are allowed only when a job owns them. */
export function judgeComplete(proposedActions: number, actions: readonly ActionFact[]): TerminalVerdict {
  if (proposedActions > 0) return refuse('conflict', 'supervisor_complete_new_actions')
  const open = actions.filter((fact) => fact.obligation === 'mandatory' && fact.state !== 'settled')
  if (open.some((fact) => UNKNOWN.has(fact.state))) return refuse('conflict', 'supervisor_complete_unknown')
  if (open.some((fact) => fact.parentActionId !== null))
    return refuse('conflict', 'supervisor_complete_children')
  if (open.length > 0) return refuse('conflict', 'supervisor_complete_pending')
  const detached = actions.filter((fact) => fact.obligation === 'detached' && fact.state !== 'settled')
  if (detached.some((fact) => fact.owner.kind !== 'job'))
    return refuse('conflict', 'supervisor_detached_owner_missing')
  return { ok: true, unknownActionIds: [], detachedOwnerRefs: detached.map((fact) => fact.owner) }
}

export type DrainPlan = Readonly<{
  /** Never dispatched: settle as cancelled without any external call. */
  settleUndispatched: readonly string[]
  /** Dispatched: cancel through the owner, then wait for the receipt or mark unknown. */
  cancelInflight: readonly string[]
  /** Unknown or reconciling: must be handed to an owner, never dropped and never reported as success. */
  unknownActionIds: readonly string[]
  detachedOwnerRefs: readonly W.OwnerRef[]
  /** True only when finalizing now would lose no supervision. */
  canFinalize: boolean
}>

/** Fail and cancel seal admission first, then drain. */
export function planDrain(actions: readonly ActionFact[]): DrainPlan {
  const settleUndispatched: string[] = []
  const cancelInflight: string[] = []
  const unknownActionIds: string[] = []
  const detachedOwnerRefs: W.OwnerRef[] = []
  let unowned = false
  for (const fact of actions) {
    if (fact.state === 'settled') continue
    if (fact.obligation === 'detached') {
      if (fact.owner.kind === 'job') detachedOwnerRefs.push(fact.owner)
      else unowned = true
      continue
    }
    if (UNKNOWN.has(fact.state)) {
      unknownActionIds.push(fact.actionId)
      if (fact.owner.kind !== 'reconciliation' && fact.owner.kind !== 'job') unowned = true
    } else if (fact.state === 'dispatching' || fact.state === 'running') cancelInflight.push(fact.actionId)
    else settleUndispatched.push(fact.actionId)
  }
  return {
    settleUndispatched,
    cancelInflight,
    unknownActionIds,
    detachedOwnerRefs,
    canFinalize: !unowned && settleUndispatched.length === 0 && cancelInflight.length === 0,
  }
}
