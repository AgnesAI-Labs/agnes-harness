import { CC_HOOK_EVENTS, type HooksMap, type SkillRoot } from '../src/data/types.js'
import { loadHooksMap, loadSkillRoots } from '../src/index.js'

export type BaseHookEntry = {
  to: string[] | null
  reason?: string
  unsupportedFields?: string[]
}
export type BaseCcHookMap = {
  $generated: string
  version: string
  events: Record<string, BaseHookEntry>
}

export function projectSkillRoots(roots: readonly SkillRoot[]): Array<Omit<SkillRoot, 'note'>> {
  return roots.map(({ root, host, layout, trust }) =>
    trust === undefined ? { root, host, layout } : { root, host, layout, trust },
  )
}

export function projectCcHookMap(map: Readonly<HooksMap>, version: string): BaseCcHookMap {
  const events: Record<string, BaseHookEntry> = {}
  for (const event of CC_HOOK_EVENTS) {
    const source = map.events[event]
    events[event] = {
      to: source.to === null ? null : [...source.to],
      ...(source.reason ? { reason: source.reason } : {}),
      ...(source.unsupportedFields?.length ? { unsupportedFields: [...source.unsupportedFields] } : {}),
    }
  }
  return { $generated: `generated from @agnes/bridges@${version} — do not edit`, version, events }
}

export const BASE_TARGETS: ReadonlyArray<{
  relPath: string
  render(version: string): string
}> = [
  {
    relPath: 'base/extensions/skills/generated/skill-roots.json',
    render: () => `${JSON.stringify(projectSkillRoots(loadSkillRoots()), null, 2)}\n`,
  },
  {
    relPath: 'base/extensions/hooks-runner/generated/cc-hook-map.json',
    render: (version) => `${JSON.stringify(projectCcHookMap(loadHooksMap(), version), null, 2)}\n`,
  },
]
