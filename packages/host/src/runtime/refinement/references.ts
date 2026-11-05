import type { ReferencedSkill, RefinementReferences, SessionImpl } from '@agnes/core'
import type { SkillRuntimeDiscovery } from '@agnes/host-extensions/assemble/packages'

/**
 * The host's answer to which approved skills and roles a refinement entry may be bound to for a
 * session now. Skills are listed once per check in that session's own workspace view, as the skill
 * tools see it: usable only while ready, enabled, trusted, the winner of its name and visible to the
 * model (the same rule the skill catalog and `skill_read` apply). Roles are the ones the adopted
 * application still lists as delegable to that session (the list `subagent_spawn` offers). Nothing
 * here grants a role tools, a model, a budget or full access: invoking it still goes through
 * `subagent_spawn` and its own checks.
 */
export function createRefinementReferences(o: {
  session(key: string, lane: string): SessionImpl | undefined
  skills(): SkillRuntimeDiscovery | undefined
}): RefinementReferences {
  return {
    async skills(at) {
      const skills = o.skills()
      if (!skills || !o.session(at.key, at.lane)) return []
      return skills.runInWorkspace(
        at.key,
        async (): Promise<ReferencedSkill[]> =>
          skills.list().map((found) => {
            const flags = skills.invocation?.(found.resourceId)
            const usable =
              found.actual === 'ready' &&
              found.desired === 'enabled' &&
              found.trust === 'trusted' &&
              found.resolution.winner === true &&
              (flags === undefined || (flags.modelInvocable && !flags.disabled))
            return { resourceId: found.resourceId, revision: found.revision, usable, name: found.name }
          }),
      )
    },
    async agents(at) {
      const session = o.session(at.key, at.lane)
      const roles = session?.d.childRoles
      if (!session || !roles) return []
      return (await roles.list(session)).map((role) => role.ref)
    },
  }
}
