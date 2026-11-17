import type { RefinementSkillInstaller } from '@agnes/host-extensions/resources/refinement-skill-install'
import {
  REVIEW_AFTER_MS,
  type RefinementRegistry,
  type RegistryRecords,
  type RegistrySkill,
  type Revocation,
} from '@agnes/host-infrastructure/refinement-registry'

/**
 * What the review and the cap need from the installer: switching a skill off, never removing it.
 * `capacity` says the cap did it.
 */
export type SkillReviewInstaller = {
  disable(
    name: string,
    expected: { revision: string; reviewAfter?: number },
    reason?: 'capacity',
  ): Promise<void>
}

const LIVE: readonly RegistrySkill['state'][] = ['active', 'review-disabled']

/** How many skills refinement installed may be in force (`active`) in one workspace. */
export const RSI_SKILL_CAP = 20

/**
 * The 30-day review of skills refinement installed in one workspace. It runs when a session opens and
 * when refinement is switched on; there is no timer. Every skill the registry holds as `active` whose
 * `reviewAfter` has passed is switched off through the installer (`desired = disabled`; the folder
 * stays) and recorded `review-disabled`, which the skills page shows as awaiting review.
 *
 * The installer acts only on a skill nobody changed since it installed it, and only while its review
 * date is still the one read here, so a skill a person edited, or one a confirmation renewed meanwhile,
 * is left as it is. Skills the registry does not hold (a person's own) are never looked at. A registry
 * that cannot be read is a reason to do nothing. Switching a skill off is the system's own step: it is
 * not a revocation, and re-enabling the skill renews it. The cap on skills in force (`enforceSkillCap`)
 * follows, so a workspace that had more before the cap existed comes down to it when a session opens.
 */
export async function reviewSkills(
  registry: RefinementRegistry,
  installer: SkillReviewInstaller,
  now: number,
): Promise<void> {
  let skills: RegistrySkill[]
  try {
    if (registry.unreadable()) return
    skills = registry.read().skills
  } catch {
    return
  }
  for (const skill of skills) {
    if (skill.state !== 'active' || !(skill.reviewAfter < now)) continue
    try {
      await installer.disable(skill.name, { revision: skill.revision, reviewAfter: skill.reviewAfter })
    } catch {
      // Changed by a person, renewed meanwhile, or resource control is unavailable: left as it is, and
      // the next review looks again.
    }
  }
  await enforceSkillCap(registry, installer, now)
}

/**
 * The cap on skills refinement installed in one workspace: at most `RSI_SKILL_CAP` of them `active`.
 * A skill a person switched back on (`enabledBy: 'person'`) is theirs to keep and is not counted, so
 * the workspace may then hold more. Over the cap, the skills with the earliest review date (the ones
 * confirmed longest ago) are switched off through the installer with reason `capacity`: the folder stays,
 * the record says `review-disabled` with `disabledFor: 'capacity'`, and the registry keeps a receipt.
 * Only a person switches one back on; a confirmation or an update does not. A skill the installer will
 * not switch off (a person changed it, or it was renewed meanwhile) is passed over for the next one.
 * Skills the registry does not hold (a person's own, a plugin's) are never counted. A registry that
 * cannot be read is a reason to do nothing. The order is by review date alone, whatever `now` is.
 */
export async function enforceSkillCap(
  registry: RefinementRegistry,
  installer: SkillReviewInstaller,
  _now: number,
): Promise<void> {
  let counted: RegistrySkill[]
  try {
    if (registry.unreadable()) return
    counted = registry
      .read()
      .skills.filter((skill) => skill.state === 'active' && skill.enabledBy !== 'person')
  } catch {
    return
  }
  let over = counted.length - RSI_SKILL_CAP
  if (over <= 0) return
  const oldest = [...counted].sort(
    (a, b) => a.reviewAfter - b.reviewAfter || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
  for (const skill of oldest) {
    if (over <= 0) return
    try {
      await installer.disable(
        skill.name,
        { revision: skill.revision, reviewAfter: skill.reviewAfter },
        'capacity',
      )
      over--
    } catch {
      // Changed by a person, renewed meanwhile, or resource control is unavailable: the next one goes
      // instead, and the next check looks at this one again.
    }
  }
}

/**
 * Edits the registry when `mutate` says there is something to change, retrying a few times when another
 * writer got there first. Nothing is written (no file is created) when there is nothing to change.
 */
function edit(registry: RefinementRegistry, mutate: (draft: RegistryRecords) => boolean): boolean {
  for (let attempt = 0; ; attempt++) {
    const snapshot = registry.read()
    if (!mutate(structuredClone(snapshot))) return false
    try {
      let changed = false
      registry.update((draft) => {
        changed = mutate(draft)
      }, snapshot.revision)
      return changed
    } catch (error) {
      if ((error as { code?: string }).code !== 'REGISTRY_REVISION_CONFLICT' || attempt >= 4) throw error
    }
  }
}

const liveRecord = (draft: RegistryRecords, resourceId: string) =>
  draft.skills.find((skill) => skill.resourceId === resourceId && LIVE.includes(skill.state))

/** What a person did to a saved skill on the skills page. */
export type UserSkillRevocation = {
  action: 'skill-uninstalled' | 'skill-rolled-back'
  resourceId: string
  /** The revision taken back: the one removed, or the one a rollback replaced. */
  revision: string
  /** The principal that asked. */
  actor: string
  at: number
}

/**
 * Records that the user uninstalled or rolled back a skill refinement installed: a durable revocation
 * naming the entry it was saved from, the revision taken back, the intent, who and when. From then on
 * no automatic or model save may bring back that entry or that skill name. An uninstalled skill's
 * record becomes `uninstalled`. A skill the registry does not hold is not refinement's, and nothing is
 * written; a request already recorded is not recorded twice. True when the registry was written.
 */
export function recordSkillRevocation(registry: RefinementRegistry, input: UserSkillRevocation): boolean {
  if (registry.unreadable()) return false
  return edit(registry, (draft) => {
    const skill = liveRecord(draft, input.resourceId)
    if (!skill) return false
    const record: Revocation = {
      sessionKey: skill.source.sessionKey,
      kind: skill.source.kind,
      entryId: skill.source.entryId,
      contentHash: skill.source.contentHash,
      skillName: skill.name,
      action: input.action,
      revision: input.revision,
      actor: input.actor,
      at: input.at,
    }
    if (input.action === 'skill-uninstalled') skill.state = 'uninstalled'
    const known = draft.revocations.some(
      (r) =>
        r.sessionKey === record.sessionKey &&
        r.kind === record.kind &&
        r.entryId === record.entryId &&
        r.skillName === record.skillName &&
        r.action === record.action &&
        r.revision === record.revision,
    )
    if (!known) draft.revocations.push(record)
    return true
  })
}

/**
 * The user switched a saved skill back on: it is renewed (`active`, a new review period from `now`) and
 * marked as switched on by a person (`enabledBy: 'person'`), which the cap on skills in force respects;
 * a capacity mark is cleared. Only a skill refinement installed and nobody changed since (`revision` is
 * the one in place). True when it was renewed.
 */
export function renewSkillForUser(
  registry: RefinementRegistry,
  resourceId: string,
  revision: string,
  now: number,
): boolean {
  if (registry.unreadable()) return false
  return edit(registry, (draft) => {
    const skill = liveRecord(draft, resourceId)
    if (!skill || skill.revision !== revision) return false
    skill.state = 'active'
    skill.reviewAfter = now + REVIEW_AFTER_MS
    skill.enabledBy = 'person'
    delete skill.disabledFor
    return true
  })
}

/**
 * The user's rollback of a saved skill to an earlier revision: the installer restores it, then the
 * rollback is recorded as a revocation of the revision it replaced. A rollback that fails, or that
 * changes nothing, records nothing. The installer's own replacements (an update, finishing interrupted
 * work) never come here.
 */
export async function rollbackSkillForUser(
  registry: RefinementRegistry,
  installer: Pick<RefinementSkillInstaller, 'rollback'>,
  input: { name: string; toRevision: string; actor: string; at: number; enable?: boolean },
): Promise<{ revision: string }> {
  const before = registry
    .read()
    .skills.find((skill) => skill.name === input.name && LIVE.includes(skill.state))
  const result = await installer.rollback(
    input.name,
    input.toRevision,
    input.enable === undefined ? undefined : { enable: input.enable },
  )
  if (before && before.revision !== result.revision)
    recordSkillRevocation(registry, {
      action: 'skill-rolled-back',
      resourceId: before.resourceId,
      revision: before.revision,
      actor: input.actor,
      at: input.at,
    })
  return result
}

/**
 * The user's uninstall of a saved skill: the installer removes it (only while nobody changed it since),
 * then the removal is recorded as a revocation of the revision it removed, naming the entry the skill
 * was saved from. An uninstall that fails records nothing.
 */
export async function uninstallSkillForUser(
  registry: RefinementRegistry,
  installer: Pick<RefinementSkillInstaller, 'uninstall'>,
  input: { name: string; actor: string; at: number },
): Promise<void> {
  const before = registry
    .read()
    .skills.find((skill) => skill.name === input.name && LIVE.includes(skill.state))
  await installer.uninstall(input.name)
  if (!before) return
  edit(registry, (draft) => {
    const record: Revocation = {
      sessionKey: before.source.sessionKey,
      kind: before.source.kind,
      entryId: before.source.entryId,
      contentHash: before.source.contentHash,
      skillName: before.name,
      action: 'skill-uninstalled',
      revision: before.revision,
      actor: input.actor,
      at: input.at,
    }
    if (
      draft.revocations.some(
        (r) =>
          r.skillName === record.skillName && r.revision === record.revision && r.action === record.action,
      )
    )
      return false
    draft.revocations.push(record)
    return true
  })
}
