import { ResourceAdminApi } from '@agnes/resource-control-web/api'
import type { ComposerSkill, ComposerSkills } from '@agnes/web-units/shell'

/** Reads the daemon's reviewed resource catalogue; browser code never discovers skill files itself. */
export function composerSkills(workspaceId: () => string | undefined): ComposerSkills {
  let context: Awaited<ReturnType<typeof ResourceAdminApi.context>> | undefined
  return {
    async list(signal) {
      signal.throwIfAborted()
      context ??= await ResourceAdminApi.context()
      signal.throwIfAborted()
      const api = new ResourceAdminApi(context, fetch, workspaceId())
      const items: ComposerSkill[] = []
      let page = await api.skills()
      while (true) {
        signal.throwIfAborted()
        items.push(
          ...page.items
            .filter(
              (skill) =>
                skill.actual === 'ready' &&
                skill.desired === 'enabled' &&
                skill.trust === 'trusted' &&
                skill.resolution.winner === true &&
                !skill.stale,
            )
            .map((skill) => ({ name: skill.name, ...(skill.description ? { description: skill.description } : {}) })),
        )
        if (!page.nextCursor) break
        page = await api.skills(page.nextCursor)
      }
      return items
    },
  }
}
