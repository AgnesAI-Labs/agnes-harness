import { satisfiesApiRange } from '@agnes/extension-api'
import type { AgentPlan, BundleLaunch } from '@agnes/protocol'
import { HostError } from '../errors.js'
import { type BundleCatalog, expandBundles } from './composition.js'

export type AgentSource = AgentPlan['sources'][number] & {
  enabled: boolean
  dependencies: Readonly<Record<string, string>>
}
const refuse = (reason: string): never => {
  throw new HostError('E_PRESET_UNSUPPORTED', `agent: ${reason}`)
}
/** Resolve only an explicit launch; inheritance and dependency validation share compiler order. */
export function agentSelection(
  ref: string,
  catalog: BundleCatalog,
  packages: readonly AgentSource[],
): {
  launch: BundleLaunch
  bundles: string[]
  preset: string
  sources: AgentPlan['sources']
} {
  const entry = catalog[ref]
  if (!entry || ref !== `${entry.sourcePackage}#${ref.split('#')[1]}` || !entry.document.launch)
    refuse('unknown agent')
  const launch = entry!.document.launch!
  const sources = validateAgentBundles([ref], catalog, packages)
  return {
    launch,
    bundles: [ref],
    preset: launch.preset,
    sources,
  }
}

/** All explicit bundle references must remain inside their authors' declared dependency edges. */
export function validateAgentBundles(
  ids: readonly string[],
  catalog: BundleCatalog,
  packages: readonly AgentSource[],
): AgentPlan['sources'] {
  const byId = new Map(packages.map((source) => [source.id, source]))
  if (byId.size !== packages.length) refuse('duplicate source identity')
  const used = new Map<string, AgentSource>()
  const visit = (id: string): AgentSource => {
    const source = byId.get(id)
    if (!source?.enabled) return refuse('dependency unavailable')
    used.set(id, source)
    return source
  }
  const dependency = (owner: AgentSource, id: string) => {
    const target = visit(id)
    const range = owner.dependencies[id]
    if (!range || !satisfiesApiRange(range, target.version))
      refuse('cross-package reference requires a compatible declared dependency')
  }
  for (const bundle of expandBundles(ids, catalog)) {
    const owner = visit(bundle.sourcePackage)
    for (const parent of bundle.document.extends ?? []) {
      const target = catalog[parent] ?? refuse('unknown bundle')
      if (target.sourcePackage !== owner.id) dependency(owner, target.sourcePackage)
    }
    for (const preset of Object.values(bundle.document.presets ?? {})) {
      for (const selected of (preset.bundles ?? []) as string[]) {
        const target = catalog[selected] ?? refuse('unknown preset bundle')
        if (target.sourcePackage !== owner.id) dependency(owner, target.sourcePackage)
      }
    }
  }
  return [...used.values()].map(({ enabled: _enabled, dependencies: _dependencies, ...identity }) => identity)
}
