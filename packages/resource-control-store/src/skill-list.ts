import type { SkillScanReport } from '@agnes/protocol'
import type { SkillCatalogAdapter } from './adapters.js'
import type { SkillJournalStore } from './skill-journal.js'
import { projected, projectRoots } from './skill-state.js'

export function skillListPage(
  view: Awaited<ReturnType<typeof readSkillView>>,
  params: Record<string, unknown>,
) {
  const all = view.items.filter((item) => !params.cursor || item.resourceId > String(params.cursor))
  const items = all.slice(0, 100)
  const last = items.at(-1)
  return {
    items,
    ...(all.length > items.length && last ? { nextCursor: last.resourceId } : {}),
    ...(params.kind === 'mcp' ? {} : { skillRoots: view.skillRoots }),
    ...(view.skillScanReport ? { skillScanReport: view.skillScanReport } : {}),
  }
}

/** One complete observation; caller binds the workspace before combining durable and runtime rows. */
export async function readSkillView(
  journal: SkillJournalStore,
  adapter: SkillCatalogAdapter | undefined,
  params: Record<string, unknown>,
  workspaceId: string | undefined,
  skillScanReport?: SkillScanReport,
) {
  const saved = await journal.read(params.profile as string, (value) => ({
    items: projected(value)
      .filter((item) => !params.kind || item.kind === params.kind)
      .filter(
        (item) =>
          !workspaceId || item.sourceIdentity.scope !== 'workspace' || item.workspaceId === workspaceId,
      ),
    skillRoots: projectRoots(value, workspaceId),
  }))
  if (params.kind !== 'mcp' && adapter?.view) {
    saved.items = [
      ...(await adapter.view({
        profile: params.profile as string,
        skills: saved.items,
        signal: AbortSignal.timeout(31_000),
      })),
    ]
    saved.skillRoots.push({
      rootKey: 'runtime',
      scope: 'runtime',
      state: saved.items.some((item) => item.sourceIdentity.scope === 'runtime') ? 'ready' : 'empty',
    })
  }
  return {
    ...saved,
    items: saved.items.sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    ...(skillScanReport ? { skillScanReport } : {}),
  }
}
