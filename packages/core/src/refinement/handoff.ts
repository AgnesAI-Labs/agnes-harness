import { sha256Hex } from '@agnes/core-common/request/hash'
import {
  PROMOTION_CONFIRMATIONS,
  type SaveInitiator,
  timesSeen,
} from '@agnes/core-ledger/reduce/refinement-save'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import type { RefinementRunRecord, RefinementTriggerKind } from '@agnes/core-ledger/reduce/state'
import { entryKey } from '../refine/apply.js'
import { isChildSession } from '../step/child-session.js'
import type { SessionImpl } from '../step/session.js'
import { namesWorkspace } from './reach.js'
import { settingsOf } from './scheduler.js'
import { boundMeta } from './validity.js'
import { saveToWorkspace, type WorkspaceSaveInput } from './workspace.js'

/**
 * Who a run that asked for its result to be saved speaks for. The initiator comes from the trigger
 * Core recorded for the run, never from anything the model wrote: only the user's own request is
 * `manual`, and the model's request (its review or its direct proposal) is always `model`.
 */
const INITIATOR: Partial<Record<RefinementTriggerKind, SaveInitiator>> = { manual: 'user', model: 'model' }

type Applied = RefinementRunRecord & { plan: NonNullable<RefinementRunRecord['plan']> }

/** Owed saves offered again per reopen at most; the rest wait for the next one. */
export const RESUME_LIMIT = 20

/**
 * The fixed command ids of the saves Core hands over: short, of fixed length and printable, so the host
 * never refuses them for their size, whatever the entry id. An automatic offer is scoped to the session,
 * the entry and its content version; a run's save to the run and the entry.
 */
const autoCommandId = (s: SessionImpl, ref: { kind: string; id: string }, contentHash: string): string =>
  `auto:${sha256Hex(`${s.key}\n${ref.kind}/${ref.id}\n${contentHash}`).slice(0, 48)}`
const runCommandId = (runId: string, ref: { kind: string; id: string }): string =>
  `${runId}:${sha256Hex(`${ref.kind}/${ref.id}`).slice(0, 32)}`

/** The upserts of an applied run whose entry still holds what that run wrote. */
function written(s: SessionImpl, run: Applied) {
  return run.plan.edits.filter((edit) => {
    if (edit.op !== 'upsert') return false
    const entry = s.state.registers.harnessEntries.get(entryKey(edit))?.value as HarnessEntry | undefined
    return entry?.source === `refinement:${run.runId}`
  })
}

/** The command ids this session has a receipt row for. */
const recordedIds = (s: SessionImpl): Set<string> =>
  new Set([...s.state.refinementSaves.values()].map((receipt) => receipt.commandId))

/**
 * The entries this run touched (wrote, or confirmed) that now qualify for an automatic save: in auto
 * mode, held for the session, not handed off, seen to hold at least `PROMOTION_CONFIRMATIONS` times at
 * their current content version (the review that wrote it counts as the first), and not yet offered at
 * that version (a receipt row of this session names the offer). An offer is keyed by the content version, so each version is offered once, to user
 * memory when the entry may reach every workspace (`toUser`), else to the workspace.
 */
function automatic(s: SessionImpl, run: Applied, recorded: ReadonlySet<string>): WorkspaceSaveInput[] {
  if (settingsOf(s)?.mode !== 'auto') return []
  const touched = new Map<string, { kind: HarnessEntry['kind']; id: string }>()
  // What a planner wrote is seen to hold by that review; a direct proposal has no review behind it, so it
  // is offered only once a later review confirms it.
  const planned = run.evidenceHash !== undefined
  for (const ref of [
    ...(planned ? written(s, run) : []),
    ...run.plan.confirmations.filter((c) => c.confirmedBy),
  ])
    touched.set(entryKey(ref), { kind: ref.kind, id: ref.id })
  const offers: WorkspaceSaveInput[] = []
  for (const [key, ref] of touched) {
    const meta = boundMeta(s.state, key)
    if (meta?.applicability !== 'session' || meta.handedOff === true) continue
    if (timesSeen(meta.confirmations.count) < PROMOTION_CONFIRMATIONS) continue
    const commandId = autoCommandId(s, ref, meta.contentHash)
    if (!recorded.has(commandId))
      offers.push({
        initiator: 'auto',
        ...ref,
        commandId,
        runId: run.runId,
        ...(toUser(s, key, meta.reach) ? { target: 'user' as const } : {}),
      })
  }
  return offers
}

/**
 * Whether an automatic offer goes to user memory: the plan kept `reach: 'user'` on the entry, and its
 * text still names no workspace (checked again now, as the host checks it once more on promotion).
 */
function toUser(s: SessionImpl, key: string, reach: 'user' | undefined): boolean {
  if (reach !== 'user') return false
  const entry = s.state.registers.harnessEntries.get(key)?.value as HarnessEntry | undefined
  if (typeof entry?.title !== 'string' || typeof entry.content !== 'string') return false
  return !namesWorkspace(`${entry.title}\n${entry.content}`, s.workspaceRoot)
}

/**
 * The saves an applied run owes: every entry it wrote, when its trigger asked for the result to be
 * saved to the workspace or, by a person's own request, to user memory (a task-level one too: the host's
 * rules refuse it, so the refusal is on record), and the
 * automatic offers of the entries it confirmed. Each has a fixed command id, so asking again after a
 * crash is answered with the first receipt.
 */
function owed(s: SessionImpl, run: Applied, recorded: ReadonlySet<string>): WorkspaceSaveInput[] {
  const initiator = run.trigger.saveTo === undefined ? undefined : INITIATOR[run.trigger.kind]
  // A request for user memory (a person's, or the model's): every entry goes to the host as a
  // user-memory save, which sends text that names its workspace back to that workspace.
  const target = run.trigger.saveTo === 'user' ? ('user' as const) : undefined
  const saves: WorkspaceSaveInput[] = []
  const asked = new Set<string>()
  if (initiator)
    for (const edit of written(s, run)) {
      const commandId = runCommandId(run.runId, edit)
      asked.add(entryKey(edit))
      if (!recorded.has(commandId))
        saves.push({
          initiator,
          ...(target ? { target } : {}),
          kind: edit.kind,
          id: edit.id,
          commandId,
          runId: run.runId,
        })
    }
  // An entry the run already saves on the user's or the model's request is not offered again.
  for (const offer of automatic(s, run, recorded)) if (!asked.has(entryKey(offer))) saves.push(offer)
  return saves
}

/**
 * Hands what an applied run owes to the host's save-to-workspace path, one entry at a time, outside
 * the session lock. Nothing is handed over while refinement is off, from a child session or a fork,
 * or where the host offers no save path. Never throws: a save that fails is left for the next
 * recovery to offer again.
 */
export async function handOffApplied(s: SessionImpl, runId: string): Promise<void> {
  if (!handsOff(s)) return
  const run = s.state.refinementRuns.get(runId)
  if (run?.state !== 'applied' || !run.plan) return
  await handOver(s, owed(s, { ...run, plan: run.plan }, recordedIds(s)))
}

const handsOff = (s: SessionImpl): boolean =>
  !!s.d.refinement?.workspace && !!settingsOf(s) && !isChildSession(s) && !s.closingOrClosed

async function handOver(s: SessionImpl, saves: readonly WorkspaceSaveInput[]): Promise<void> {
  for (const input of saves) {
    if (s.closingOrClosed) return
    try {
      await saveToWorkspace(s, input)
    } catch (error) {
      s.d.logger.warn('refinement workspace hand-off failed', { message: String(error) })
    }
  }
}

/**
 * On reopening a session: offers again what applied runs still owe (a crash between the apply and the
 * save, or a host that could not be reached), oldest first and at most `RESUME_LIMIT` of them; the rest
 * wait for the next reopen. Only runs applied under the switch revision now in force are looked at: a
 * request made before the switch was saved again is not carried over. The offers go out in the
 * background, so a slow or failing host never holds up the reopen; the returned promise is theirs and
 * never rejects.
 */
export function resumeHandOffs(s: SessionImpl): Promise<void> {
  const revision = settingsOf(s)?.revision
  if (revision === undefined || !handsOff(s)) return Promise.resolve()
  const recorded = recordedIds(s)
  const saves: WorkspaceSaveInput[] = []
  const applied = [...s.state.refinementRuns.values()]
    .filter((run) => run.state === 'applied' && run.settingsRevision === revision && run.plan)
    .sort((a, b) => a.seq - b.seq)
  for (const run of applied) {
    if (saves.length >= RESUME_LIMIT) break
    saves.push(...owed(s, run as Applied, recorded))
  }
  return handOver(s, saves.slice(0, RESUME_LIMIT)).catch((error) =>
    s.d.logger.warn('refinement workspace hand-off failed', { message: String(error) }),
  )
}
