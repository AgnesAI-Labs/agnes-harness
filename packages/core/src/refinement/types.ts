import type {
  RefinementEntryKind,
  RefinementEntryRef,
  RefinementReadSet,
  RefinementTrigger,
} from '@agnes/core-ledger/reduce/state'

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
} from '@agnes/core-ledger/reduce/state'

/** The planner input target in estimated tokens, the output cap, and the deadlines. */
export const PLANNER_INPUT_TOKENS = 24_000
export const PLANNER_OUTPUT_TOKENS = 4096
export const PLANNER_DEADLINE_MS = { automatic: 60_000, manual: 90_000 } as const
/** At most this many edits in a plan, each at most this many characters of content. */
export const MAX_PLAN_EDITS = 5
export const MAX_EDIT_CHARS = 2000
/** Existing entries of one kind the planner is offered at most. */
export const PLANNER_ENTRIES_PER_KIND = 40

/** One settled fact of the triggering task, under the id this snapshot gave it. */
export type EvidenceItem = {
  id: string
  lane: string
  seq: number
  /** `external` is content from outside (a page, a referenced file) recorded as an untrusted user row. */
  kind: 'user' | 'external' | 'tool' | 'summary' | 'assistant'
  trust: 'trusted' | 'untrusted'
  text: string
  tool?: string
  args?: string
  isError?: boolean
  code?: string
}

/** The task a run learns from: the turn the trigger fell in, or the last ended one before it. */
export type EvidenceTaskScope = { kind: 'turn'; turn: number; startSeq: number; endSeq?: number }

/**
 * The frozen facts one run plans from. `boundarySeq` is the last row read: nothing written later
 * is evidence for this run. `omitted` counts facts left out because the snapshot is bounded.
 */
export type EvidenceSnapshot = {
  trigger: RefinementTrigger
  taskScope: EvidenceTaskScope
  taskEnded: boolean
  boundarySeq: number
  items: EvidenceItem[]
  omitted: number
  evidenceHash: string
  readSet: RefinementReadSet
}

// The planner contract. The planner lives in a plugin, which never imports Core: these types are the
// shapes it must accept and return, and the plugin restates them on its own side.

export type PlannerEvidence = Omit<EvidenceItem, 'lane' | 'seq'>
export type PlannerSnapshot = { items: readonly PlannerEvidence[]; omitted: number }
export type PlannerEntry = RefinementEntryRef & { title: string; content: string; version: number }
/** An entry saved to the workspace as the planner is shown it: confirm-only, by its reference. */
export type PlannerWorkspaceRef = { ref: string; title: string; summary: string }
export type PlannerGuidance = {
  trigger: RefinementTrigger['kind']
  focus?: string
  taskEnded: boolean
  activeGoal: boolean
  counts: Record<RefinementEntryKind, number>
  /** Entries saved to this workspace, which a plan may only confirm; absent when there are none. */
  workspace?: readonly PlannerWorkspaceRef[]
  /** The run's result is saved to the workspace, or to user memory. */
  saveTo?: 'workspace' | 'user'
  /** The host can save lessons beyond the session: it has a workspace save path. */
  savesToWorkspace?: boolean
}
export type PlannerPrompt = {
  system: string
  messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]
  evidenceIds: string[]
  fullEntries: RefinementEntryRef[]
  referenceEntries: RefinementEntryRef[]
  /** The workspace references the prompt shows; only these may be confirmed. Absent means none. */
  workspaceRefs?: string[]
  omitted: { referenceEntries: number; evidence: number; fullEntries: number }
  inputTokens: number
}
export type PlannerParseContext = {
  evidenceIds: readonly string[]
  fullEntries: readonly RefinementEntryRef[]
  shownEntries: readonly RefinementEntryRef[]
  /** The workspace references the prompt showed. */
  workspaceRefs?: readonly string[]
}
export type PlannerOutputEdit =
  | {
      op: 'upsert'
      kind: RefinementEntryKind
      id: string
      title: string
      content: string
      applicability: 'task' | 'session'
      evidenceIds: string[]
      /** Skill and subagent only: the approved resource the entry is bound to. */
      reference?: string
      /** The planner's suggestion that the lesson holds in every workspace; Core decides. */
      reach?: 'workspace' | 'user'
    }
  | { op: 'delete'; kind: RefinementEntryKind; id: string; evidenceIds: string[] }
export type PlannerOutput = {
  summary: string
  rationale: string
  expectedOutcome: string
  edits: PlannerOutputEdit[]
  confirmations: { entryId: string; evidenceIds: string[]; quote?: string }[]
  evidenceIds: string[]
}

/** The plugin side of planning: it writes the prompt and reads the one answer. */
export type RefinementPlanner = {
  buildPrompt(
    snapshot: PlannerSnapshot,
    entries: readonly PlannerEntry[],
    guidance: PlannerGuidance,
  ): PlannerPrompt
  parseOutput(text: string, context: PlannerParseContext): PlannerOutput | { error: string }
}
