import type { Seq } from '@agnes/core-common/types'
import type { DecisionSnapshot, SessionStart } from '@agnes/protocol'
import { ChunkedMap } from './chunked-map.js'
import type { RefinementEntryMeta, RefinementEntryTombstone } from './refinement-entry-meta.js'
import type { RefinementRunRecord } from './refinement-run.js'
import type { RefinementSaveRecord } from './refinement-save.js'
import type { ArtifactJob, BudgetState, EffectIntent, HarnessEntry, Inbox, PlanItems } from './shapes.js'

export type {
  RefinementApplicability,
  RefinementEntryMeta,
  RefinementEntryTombstone,
} from './refinement-entry-meta.js'
export { REFINEMENT_ENTRY_META_EVENT } from './refinement-entry-meta.js'
export type {
  RefinementEntryKind,
  RefinementEntryRef,
  RefinementEvidenceRef,
  RefinementPlan,
  RefinementPlanEdit,
  RefinementReadSet,
  RefinementRunRecord,
  RefinementRunState,
  RefinementTrigger,
  RefinementTriggerKind,
  RefinementWorkspaceConfirmation,
  RefinementWorkspaceRef,
} from './refinement-run.js'
export { canMoveRun, REFINEMENT_RUN_EVENT, TERMINAL_RUN_STATES } from './refinement-run.js'
export type { RefinementSaveRecord, SaveReceipt } from './refinement-save.js'
export { REFINEMENT_SAVE_EVENT } from './refinement-save.js'

export type RegisterCell<T> = { seq: Seq; value: T }

/**
 * The lane background maintenance calls record their effects on. It never holds a turn or a
 * program counter: its effects are valid outside a turn and stay out of every turn's own view.
 */
export const MAINTENANCE_LANE = 'refinement'

export type EffectNode = {
  effectId: string
  lane: string
  parentEffectId?: string
  kind: EffectIntent['kind']
  tool?: EffectIntent['tool']
  replay: EffectIntent['replay']
  intentSeq: Seq
  receiptSeq?: Seq
  firstOutputSeq?: Seq
  /** Where the text said before the stream was cut short was recorded, if it was. */
  interruptedSeq?: Seq
  argsSeq?: Seq
  slot?: string
  children: EffectNode[]
}
export type EffectTree = EffectNode[]

/**
 * Everything the ledger folds to. The five registers are the cells folded from rows; the rest is derived
 * bookkeeping the step machine and the relation check read. Registers are keyed the way storage
 * keys them, so a rebuilt state and the register table can be compared cell for cell.
 *
 * A state is never changed once the fold returns it: every table is read-only here, and the two that
 * only grow for the life of a session are chunked, so a fold step copies only what it writes.
 */
export type LedgerState = {
  lastSeq: Seq
  session: SessionStart | null
  registers: {
    decisionStates: ReadonlyMap<string, RegisterCell<DecisionSnapshot>>
    planItems: ReadonlyMap<string, RegisterCell<PlanItems>>
    budgetState: ReadonlyMap<string, RegisterCell<BudgetState>>
    artifactJobs: ReadonlyMap<string, RegisterCell<ArtifactJob>>
    inbox: ReadonlyMap<string, RegisterCell<Inbox>>
    harnessEntries: ReadonlyMap<string, RegisterCell<HarnessEntry>>
  }
  openTurn: ReadonlyMap<string, { turn: number; startSeq: Seq; trigger: string; lastHeaderSeq?: Seq }>
  openStep: ReadonlyMap<string, { turn: number; step: number; startSeq: Seq }>
  // The last turn number seen on the lane, and the last step number opened inside the current turn.
  // Both outlive the open* maps on purpose: the step machine numbers the next turn from lastTurn,
  // and the relation check numbers the next step from lastStep, which openStep can no longer answer
  // once step/end has closed it — reading openStep there numbers every second step back to 1.
  lastTurn: ReadonlyMap<string, number>
  /** Durable successful boundaries used to validate detached effect provenance during replay. */
  completedTurns: ChunkedMap<
    number,
    { lane: string; turn: number; startSeq: number; lastAssistantSeq: number }
  >
  lastStep: ReadonlyMap<string, number>
  pendingEffects: ReadonlyMap<string, Omit<EffectNode, 'children'>>
  resumedRequests: ReadonlySet<string>
  taint: ReadonlyMap<string, boolean>
  toolCalls: ChunkedMap<string, { seq: Seq; name: string; turn: number; step: number; lane: string }>
  creditsUsed: number
  /** Background refinement runs by run id, folded from Core's `x/core/refinement-run` rows. */
  refinementRuns: ReadonlyMap<string, RefinementRunRecord>
  /**
   * Refinement entries' validity and confirmations, folded from Core's `x/core/refinement-entry-meta`
   * rows and keyed like the `harness/entry` cells they describe. A fork keeps them, as it keeps the
   * entries.
   */
  refinementEntryMeta: ReadonlyMap<string, RefinementEntryMeta>
  /**
   * What removed refinement entries left behind (their last version and the removal's seq), keyed
   * like the cells they were. A fork keeps them too.
   */
  refinementTombstones: ReadonlyMap<string, RefinementEntryTombstone>
  /**
   * Receipts of this session's saves of task experience into the workspace, by receipt id, folded from
   * Core's `x/core/refinement-save` rows (structure and hashes only). A fork starts them over.
   */
  refinementSaves: ReadonlyMap<string, RefinementSaveRecord>
  // The most recent non-interrupted `cost/ledger` entry's token total, with the seq it landed at,
  // and that same entry's cache-read/input breakdown. `contextTokens` starts counting surface nodes
  // after this seq instead of from the top of the ledger, so a long session's preflight cost stays
  // bounded by what changed since the last request; `cacheRead`/`input` are what the compaction
  // trigger's hysteresis reads to tell whether the cache it is about to discard is currently warm.
  lastLedgerTokens: { seq: Seq; total: number; cacheRead: number; input: number } | null
}

export function initialState(): LedgerState {
  return {
    lastSeq: 0,
    session: null,
    registers: {
      decisionStates: new Map(),
      planItems: new Map(),
      budgetState: new Map(),
      artifactJobs: new Map(),
      inbox: new Map(),
      harnessEntries: new Map(),
    },
    openTurn: new Map(),
    openStep: new Map(),
    lastTurn: new Map(),
    completedTurns: ChunkedMap.empty(),
    lastStep: new Map(),
    pendingEffects: new Map(),
    resumedRequests: new Set(),
    taint: new Map(),
    toolCalls: ChunkedMap.empty(),
    creditsUsed: 0,
    refinementRuns: new Map(),
    refinementEntryMeta: new Map(),
    refinementTombstones: new Map(),
    refinementSaves: new Map(),
    lastLedgerTokens: null,
  }
}

/**
 * Builds the tree of effects still in flight. A root is a node whose parent is not itself pending —
 * either it never had one, or the parent has already settled — so a settled parent does not hide the
 * children still running under it. Given a lane, only that lane's effects are in the tree, so a turn
 * never waits on, settles or reports an effect another lane is running.
 */
export function effectTree(state: LedgerState, lane?: string): EffectTree {
  const nodes = new Map<string, EffectNode>()
  for (const p of state.pendingEffects.values())
    if (lane === undefined || p.lane === lane) nodes.set(p.effectId, { ...p, children: [] })
  const roots: EffectNode[] = []
  for (const n of nodes.values()) {
    const parent = n.parentEffectId === undefined ? undefined : nodes.get(n.parentEffectId)
    if (parent) parent.children.push(n)
    else roots.push(n)
  }
  return roots.sort((a, b) => a.intentSeq - b.intentSeq)
}
