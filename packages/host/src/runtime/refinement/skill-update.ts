import type { WorkspaceSaveRequest } from '@agnes/core'
import {
  normalizedContentHash,
  type RefinementRegistry,
  type RegistrySkill,
  type RegistrySnapshot,
  type SaveReceipt,
  type SaveRefusal,
  type SaveSource,
} from '@agnes/host-infrastructure/refinement-registry'
import {
  type SkillDraftReason,
  type SkillDraftStore,
  skillDraftOf,
  workspaceSkillText,
} from './skill-drafts.js'

/**
 * How the save path reaches the skill installer, which runs where resource control lives. `request`
 * sends one installer request for the requesting session (its workspace is taken from that session,
 * never from the request) and answers `{ ok: true, ... }` with the installer's result, or
 * `{ ok: false, reason }` with a save refusal reason. `drafts` keeps the changes left for a person.
 */
export type WorkspaceSkills = {
  request(sessionKey: string, params: Record<string, unknown>): Promise<unknown>
  drafts(workspaceRoot: string): SkillDraftStore
  /**
   * Whether the folder of a skill refinement installed is gone from the workspace while no installer
   * operation on it is unfinished: a person deleted it. Absent: never.
   */
  gone?(workspaceRoot: string, name: string): boolean
}

type Step = SaveReceipt['steps'][number]['step']
/** What a skill save came to, for the save path to record. */
export type SkillSaveDecision =
  | { outcome: 'installed'; target: Extract<NonNullable<SaveReceipt['target']>, { kind: 'skill' }> }
  | { refused: SaveRefusal; step: Step }

const LIVE: readonly RegistrySkill['state'][] = ['active', 'review-disabled']
const REVISION = /^[a-f0-9]{64}$/
/** The refusals the installer and its request handler answer with; anything else reads `unavailable`. */
const INSTALLER_REFUSALS: readonly SaveRefusal[] = [
  'static-check',
  'conflict',
  'unavailable',
  'refinement-off',
]
type Reply = {
  ok?: unknown
  revision?: unknown
  resourceId?: unknown
  draft?: unknown
  reason?: unknown
  code?: unknown
}

const liveRecord = (snapshot: Pick<RegistrySnapshot, 'skills'>, name: string) =>
  snapshot.skills.find((skill) => skill.name.toLowerCase() === name && LIVE.includes(skill.state))

/**
 * A skill entry saved into the workspace, past the switch, revocation, confirmation and source steps:
 * - its name or description cannot be a saved skill's: `static-check`;
 * - refinement installed a skill of that name: it is updated through the installer, against the
 *   revision refinement recorded for it. The installer writes only while the folder and resource
 *   control still show exactly that revision and the review's disabled state is kept. A skill a person
 *   changed (now, or between this decision and the write) is never written: the change is kept as a
 *   draft for the person (`conflict`);
 * - a person's skill holds the name in the workspace: the change is only kept as a draft (`conflict`);
 * - otherwise it is installed as a new workspace skill, trusted and enabled, without a turn: turning
 *   refinement on is the authorisation. A person's skill of that name anywhere else (the installer
 *   refuses the name) keeps the change as a draft for them.
 * A skill entry bound to an approved skill (`reference`) is a pointer to that skill, never a skill of
 * its own: `static-check`.
 */
export async function saveSkillChange(input: {
  request: WorkspaceSaveRequest
  receiptId: string
  source: SaveSource
  snapshot: RegistrySnapshot
  registry: RefinementRegistry
  skills: WorkspaceSkills
  clock: () => number
}): Promise<SkillSaveDecision | undefined> {
  const { request, registry, skills } = input
  if (request.entry.reference !== undefined) return { refused: 'static-check', step: 'rules' }
  const draft = skillDraftOf(request.entry)
  if (!draft) return { refused: 'static-check', step: 'rules' }
  const root = request.session.workspaceRoot
  const proposed = draft.files[0]?.content as string
  const keepDraft = (reason: SkillDraftReason): SkillSaveDecision => {
    const found = workspaceSkillText(root, draft.name)
    try {
      skills.drafts(root).put({
        name: draft.name,
        reason,
        base: found?.text ?? null,
        proposed,
        receiptId: input.receiptId,
        evidence: {
          sessionKey: request.session.key,
          entryId: request.entry.id,
          entryVersion: request.entry.version,
          contentHash: normalizedContentHash(request.entry.content),
          evidenceSeqs: [...request.evidenceSeqs],
          ...(request.runId === undefined ? {} : { runId: request.runId }),
          commandId: request.commandId,
          initiator: request.initiator,
        },
        at: input.clock(),
      })
    } catch {
      // The receipt still says the skill was not written; only the draft is missing.
    }
    return { refused: 'conflict', step: 'capacity' }
  }

  const record = liveRecord(input.snapshot, draft.name)
  if (!record) {
    if (workspaceSkillText(root, draft.name)) return keepDraft('human-written')
    return installSkill({ ...input, draft, keepDraft })
  }
  let reply: Reply
  try {
    reply = ((await skills.request(request.session.key, {
      op: 'update',
      name: draft.name,
      draft,
      expectedRevision: record.revision,
    })) ?? {}) as Reply
  } catch {
    return { refused: 'unavailable', step: 'capacity' }
  }
  if (reply.ok === true && typeof reply.revision === 'string' && REVISION.test(reply.revision)) {
    const now = liveRecord(registry.read(), draft.name)
    return {
      outcome: 'installed',
      target: {
        kind: 'skill',
        name: draft.name,
        resourceId: now?.resourceId ?? record.resourceId,
        revision: reply.revision,
      },
    }
  }
  if (reply.ok === true && reply.draft === 'changed-since') {
    // Another save of refinement's moved the skill on first: not a person's change, nothing to draft.
    const now = liveRecord(registry.read(), draft.name)
    if (now && now.revision !== record.revision) return { refused: 'conflict', step: 'capacity' }
    return keepDraft('changed-since')
  }
  const reason = INSTALLER_REFUSALS.find((known) => known === reply.reason) ?? 'unavailable'
  return { refused: reason, step: reason === 'static-check' ? 'rules' : 'capacity' }
}

/** Installs a new saved skill through the installer, for the requesting session. */
async function installSkill(input: {
  request: WorkspaceSaveRequest
  receiptId: string
  source: SaveSource
  registry: RefinementRegistry
  skills: WorkspaceSkills
  draft: NonNullable<ReturnType<typeof skillDraftOf>>
  keepDraft(reason: SkillDraftReason): SkillSaveDecision
}): Promise<SkillSaveDecision> {
  const { draft } = input
  let reply: Reply
  try {
    reply = ((await input.skills.request(input.request.session.key, {
      op: 'install',
      draft,
      receiptId: input.receiptId,
      source: input.source,
    })) ?? {}) as Reply
  } catch {
    return { refused: 'unavailable', step: 'capacity' }
  }
  if (
    reply.ok === true &&
    typeof reply.resourceId === 'string' &&
    reply.resourceId.length > 0 &&
    typeof reply.revision === 'string' &&
    REVISION.test(reply.revision)
  )
    return {
      outcome: 'installed',
      target: { kind: 'skill', name: draft.name, resourceId: reply.resourceId, revision: reply.revision },
    }
  if (reply.ok === false && reply.code === 'SKILL_TARGET_CONFLICT') {
    // Refinement's own save got there first: not a person's skill, nothing to draft.
    if (liveRecord(input.registry.read(), draft.name)) return { refused: 'conflict', step: 'capacity' }
    return input.keepDraft('human-written')
  }
  const reason = INSTALLER_REFUSALS.find((known) => known === reply.reason) ?? 'unavailable'
  return { refused: reason, step: reason === 'static-check' ? 'rules' : 'capacity' }
}

/**
 * The skills refinement installed whose folder a person deleted are uninstalled, as if they had been
 * removed on the skills page: each record says `uninstalled` and a revocation names the entry it was
 * saved from, its name and content, so no automatic or model save brings it back under any name. True
 * when the registry was written.
 */
export function reconcileSkillDeletions(
  registry: RefinementRegistry,
  snapshot: RegistrySnapshot,
  root: string,
  skills: WorkspaceSkills,
  now: number,
): boolean {
  const check = skills.gone
  if (!check) return false
  const gone = new Set<string>()
  for (const record of snapshot.skills) {
    if (!LIVE.includes(record.state)) continue
    try {
      if (check(root, record.name)) gone.add(record.name)
    } catch {
      // Cannot tell: left as it is.
    }
  }
  if (gone.size === 0) return false
  try {
    registry.update((draft) => {
      for (const live of draft.skills) {
        if (!gone.has(live.name) || !LIVE.includes(live.state)) continue
        live.state = 'uninstalled'
        draft.revocations.push({
          sessionKey: live.source.sessionKey,
          kind: live.source.kind,
          entryId: live.source.entryId,
          contentHash: live.source.contentHash,
          skillName: live.name,
          action: 'skill-uninstalled',
          revision: live.revision,
          at: now,
        })
      }
    }, snapshot.revision)
    return true
  } catch {
    return false
  }
}
