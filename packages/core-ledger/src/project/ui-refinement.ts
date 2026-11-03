import type { Event, Seq } from '@agnes/core-common/types'
import type { UINode } from '@agnes/protocol'
import { REFINEMENT_RUN_EVENT } from '../reduce/refinement-run.js'
import { REFINEMENT_SAVE_EVENT, SAVE_REFUSALS } from '../reduce/refinement-save.js'
import type { LedgerState } from '../reduce/state.js'
import { clipUtf16 as clip } from './clip.js'

export type RefinementRunNode = Extract<UINode, { kind: 'refinement-run' }>
export type RefinementSaveNode = Extract<UINode, { kind: 'refinement-save' }>
type NodeEdit = NonNullable<RefinementRunNode['edits']>[number]
/** What names an edit: its kind and id, and for a skill made from a workflow run, the run. */
type Named = { kind?: unknown; id?: unknown; workflowRun?: unknown }

const MAX_EDITS = 50
/** The kind of workspace target a save goes to, by the kind of entry saved. */
const TARGETS = {
  prompt: 'workspace-memory',
  memory: 'workspace-memory',
  skill: 'workspace-skill',
  subagent: 'workspace-agent',
} as const satisfies Record<string, NonNullable<RefinementSaveNode['target']>>
const KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])
// A reason is one of Core's short names; anything else (free text, a path) is not shown.
const REASON = /^[a-z0-9][a-z0-9._-]{0,63}$/u

/** What an applied `harness/refine` row did, by name only: never an entry's title or text. */
function editsOf(data: unknown): NodeEdit[] {
  const raw = (data as { edits?: unknown } | null)?.edits
  if (!Array.isArray(raw)) return []
  const edits: NodeEdit[] = []
  for (const item of raw) {
    const edit = (item as ({ op?: unknown; entry?: unknown } & Named) | null) ?? {}
    const named = edit.op === 'upsert' ? (edit.entry as Named | null) : edit
    const kind = named?.kind
    const id = named?.id
    if ((edit.op !== 'upsert' && edit.op !== 'delete') || typeof kind !== 'string' || !KINDS.has(kind))
      continue
    if (typeof id !== 'string' || id.length === 0) continue
    // An edit based on a finished workflow run says so; the run's id is not part of the timeline.
    const workflow = edit.op === 'upsert' && kind === 'skill' && typeof named?.workflowRun === 'string'
    edits.push({
      op: edit.op,
      kind: kind as NodeEdit['kind'],
      id: clip(id, 128),
      ...(workflow ? { workflow: true as const } : {}),
    })
    if (edits.length === MAX_EDITS) break
  }
  return edits
}

/** Puts a node that later rows keep updating where it is, or at the end when it is new. */
export function placeNode(nodes: UINode[], indexes: Map<string, number>, node: UINode): string {
  const index = indexes.get(node.id)
  if (index === undefined) {
    indexes.set(node.id, nodes.length)
    nodes.push(node)
  } else nodes[index] = node
  return node.id
}

/**
 * The timeline's one row per refinement run. It follows the run's own rows (state and reason) and
 * the `harness/refine` rows that applied it or withdrew that application. Only names and numbers are
 * kept: the plan, the evidence and every entry's title and text stay in the ledger.
 */
export class RefinementProjection {
  /** The row id each run's node was first given, so later rows replace it in place. */
  private readonly ids = new Map<string, string>()
  private readonly applied = new Map<string, { seq: Seq; edits: NodeEdit[] }>()
  private readonly byRefineSeq = new Map<Seq, string>()
  private readonly withdrawn = new Set<Seq>()
  private readonly nodes = new Map<string, RefinementRunNode>()
  /** Where each save receipt's node was first placed, so a later outcome replaces it in place. */
  private readonly saves = new Map<string, { id: string; seq: Seq }>()

  /** Applies one row and returns the nodes it created or changed, for the caller to place. */
  apply(event: Event, state: LedgerState, lane: string): (RefinementRunNode | RefinementSaveNode)[] {
    if (event.type === REFINEMENT_RUN_EVENT) return this.run(event, state)
    if (event.type === REFINEMENT_SAVE_EVENT) return this.save(event, state)
    if (event.type === 'harness/refine' && (event.lane ?? 'main') === lane) return this.refine(event)
    return []
  }

  /**
   * A save's node: who asked, how it ended and why, and the kind of target (user memory for a promotion,
   * with whether this workspace reads it); nothing about what was saved or where.
   */
  private save(event: Event, state: LedgerState): RefinementSaveNode[] {
    const receiptId = (event.data as { receiptId?: unknown } | null)?.receiptId
    const saved = typeof receiptId === 'string' ? state.refinementSaves.get(receiptId) : undefined
    if (!saved || saved.seq !== event.seq) return []
    const at = this.saves.get(saved.receiptId) ?? { id: event.id, seq: event.seq }
    this.saves.set(saved.receiptId, at)
    return [
      {
        kind: 'refinement-save',
        id: at.id,
        seq: at.seq,
        state: saved.outcome,
        // A reason a later build added is not one the timeline knows yet: the line says only how it ended.
        ...(saved.reason === undefined || !SAVE_REFUSALS.includes(saved.reason)
          ? {}
          : { reason: saved.reason }),
        initiator: saved.initiator,
        ...(saved.layer === 'user'
          ? {
              target: 'user-memory' as const,
              ...(saved.userMemoryRead === undefined ? {} : { userMemoryRead: saved.userMemoryRead }),
            }
          : { target: TARGETS[saved.target?.kind === 'skill' ? 'skill' : saved.source.kind] }),
      },
    ]
  }

  private run(event: Event, state: LedgerState): RefinementRunNode[] {
    const runId = (event.data as { runId?: unknown } | null)?.runId
    const run = typeof runId === 'string' ? state.refinementRuns.get(runId) : undefined
    if (!run) return []
    const id = this.ids.get(run.runId) ?? event.id
    this.ids.set(run.runId, id)
    const applied = this.applied.get(run.runId)
    const node: RefinementRunNode = {
      kind: 'refinement-run',
      id,
      // The queueing row fixes where the run sits in the timeline; later rows only change it.
      seq: run.queuedSeq,
      runId: clip(run.runId, 128),
      state: run.state,
      trigger: run.trigger.kind,
      ...(run.reason !== undefined && REASON.test(run.reason) ? { reason: run.reason } : {}),
      ...(applied ? { edits: applied.edits, appliedSeq: applied.seq } : {}),
      ...(applied && this.withdrawn.has(applied.seq) ? { withdrawn: true } : {}),
    }
    this.nodes.set(run.runId, node)
    return [node]
  }

  private refine(event: Event): RefinementRunNode[] {
    const row = event.data as { outcome?: unknown; runId?: unknown; rollbackOf?: unknown } | null
    if (row?.outcome !== 'applied') return []
    if (Number.isSafeInteger(row.rollbackOf)) {
      const target = Number(row.rollbackOf)
      this.withdrawn.add(target)
      return this.rebuild(this.byRefineSeq.get(target))
    }
    if (typeof row.runId !== 'string') return []
    this.applied.set(row.runId, { seq: event.seq, edits: editsOf(event.data) })
    this.byRefineSeq.set(event.seq, row.runId)
    return this.rebuild(row.runId)
  }

  /** The run's node again with what is now known; nothing when its run row has not come yet. */
  private rebuild(runId: string | undefined): RefinementRunNode[] {
    const node = runId === undefined ? undefined : this.nodes.get(runId)
    const applied = runId === undefined ? undefined : this.applied.get(runId)
    if (!node || !applied) return []
    const next: RefinementRunNode = {
      ...node,
      edits: applied.edits,
      appliedSeq: applied.seq,
      ...(this.withdrawn.has(applied.seq) ? { withdrawn: true } : {}),
    }
    this.nodes.set(runId as string, next)
    return [next]
  }
}
