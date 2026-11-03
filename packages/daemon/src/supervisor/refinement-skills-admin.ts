import { realpath } from 'node:fs/promises'
import {
  createSkillDraftStore,
  RefinementRegistry,
  type RefinementSkillInstallers,
  rollbackSkillForUser,
  uninstallSkillForUser,
} from '@agnes/host'
import type { RefinementSavedSkill, RefinementSkillsParams, RefinementSkillsResult } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'

/** The refusals the owner is told by code; anything else is `SKILL_UNAVAILABLE`. */
const REASONS = new Set([
  'SKILL_NOT_INSTALLED_BY_REFINEMENT',
  'SKILL_CHANGED_SINCE',
  'SKILL_NO_EARLIER_REVISION',
  'SKILL_TARGET_BUSY',
])
const PREVIOUS_LISTED = 16
const HASH = /^[a-f0-9]{64}$/

const refused = (reason: string) => rpcError('SEMANTIC_REJECTED', { reason })

/**
 * The owner's view of the skills refinement saved in one workspace, and their uninstall or rollback of
 * one of them. The workspace must be one the daemon lists as available; its canonical path names the
 * registry. Uninstalling and rolling back go through the shared installers (the skill's own queue) and
 * are recorded as the user's revocation, so no automatic or model save brings that skill back.
 */
export function createRefinementSkillsAdmin(options: {
  dataDir: string
  installers: RefinementSkillInstallers
  workspaces(): Promise<{ items: readonly { path: string; available: boolean }[] }>
  clock: () => number
}) {
  const drafts = createSkillDraftStore(options.dataDir)
  const view = (root: string, registry: RefinementRegistry): RefinementSkillsResult => {
    const skills: RefinementSavedSkill[] = registry.unreadable()
      ? []
      : registry
          .read()
          .skills.filter((skill) => skill.state === 'active' || skill.state === 'review-disabled')
          .map((skill) => ({
            name: skill.name,
            resourceId: skill.resourceId,
            revision: skill.revision,
            state: skill.state as RefinementSavedSkill['state'],
            reviewAfter: skill.reviewAfter,
            initiator: skill.source.initiator ?? 'auto',
            ...(skill.source.fromWorkflow === true ? { workflow: true as const } : {}),
            previous: skill.archive.filter((revision) => revision !== skill.revision).slice(-PREVIOUS_LISTED),
          }))
    let kept: RefinementSkillsResult['drafts'] = []
    try {
      kept = drafts(root)
        .list()
        .filter((draft) => HASH.test(draft.id))
        .map(({ id, name, reason, diff, at }) => ({ id, name, reason, diff, at }))
    } catch {
      // No drafts to show.
    }
    return { skills, drafts: kept }
  }
  return async (params: RefinementSkillsParams, actor: string): Promise<RefinementSkillsResult> => {
    const { items } = await options.workspaces()
    if (!items.some((item) => item.available && item.path === params.cwd)) throw rpcError('CAPABILITY_DENIED')
    const root = await realpath(params.cwd)
    const registry = new RefinementRegistry(options.dataDir, root, options.clock)
    const action = params.action ?? 'list'
    if (action !== 'list') {
      const name = params.name
      if (!name) throw rpcError('INVALID_PARAMS')
      const record = registry
        .read()
        .skills.find(
          (skill) => skill.name === name && (skill.state === 'active' || skill.state === 'review-disabled'),
        )
      if (!record) throw refused('SKILL_NOT_INSTALLED_BY_REFINEMENT')
      const installer = options.installers(root)
      const who = { actor: actor.slice(0, 256), at: options.clock() }
      try {
        if (action === 'uninstall') await uninstallSkillForUser(registry, installer, { name, ...who })
        else {
          const toRevision =
            params.toRevision ?? record.archive.filter((revision) => revision !== record.revision).at(-1)
          if (!toRevision) throw refused('SKILL_NO_EARLIER_REVISION')
          await rollbackSkillForUser(registry, installer, { name, toRevision, ...who })
        }
      } catch (error) {
        const data = (error as { data?: unknown }).data
        if (data) throw error
        const code = (error as { code?: unknown }).code
        throw refused(typeof code === 'string' && REASONS.has(code) ? code : 'SKILL_UNAVAILABLE')
      }
    }
    return view(root, registry)
  }
}
