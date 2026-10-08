import { createHash } from 'node:crypto'
import { canonicalJson, sha256Hex, type ToolRegistry } from '@agnes/core'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { SkillRuntimeInput } from '../resources/skills.js'
import type { CompositionPatch, ResolvedComposition } from './composition.js'
import type { CompositionToolGroup } from './composition-state.js'
import {
  capabilityEnabled,
  capabilityToolCatalog,
  resolveSessionCapabilities,
  type SessionCapabilitySet,
} from './session-capabilities.js'

/** A read facade; registration and leases stay owned by the generation's original registry. */
export function compositionTools(
  tools: ToolRegistry,
  selection: CompositionPatch,
  scope?: ResolvedComposition['toolScope'],
  resolve?: (tools: ToolRegistry) => SessionCapabilitySet,
): ToolRegistry {
  const capabilities = () =>
    resolve?.(tools) ??
    resolveSessionCapabilities({
      selection,
      scope,
      installed: { tools: capabilityToolCatalog(tools) },
    })
  const visible = () => {
    const set = capabilities()
    return tools.list().filter((tool) => capabilityEnabled(set.tools, tool.name))
  }
  const allowed = (set: SessionCapabilitySet, name: string): boolean => capabilityEnabled(set.tools, name)
  return new Proxy(tools, {
    get(target, property) {
      if (property === 'list') return () => visible()
      if (property === 'resolve')
        return (name: string) => (allowed(capabilities(), name) ? target.resolve(name) : undefined)
      if (property === 'size') return visible().length
      if (property === 'snapshot')
        return (seq: Parameters<ToolRegistry['snapshot']>[0]) => {
          const original = target.snapshot(seq)
          const set = capabilities()
          const defs = original.defs.filter((tool) => allowed(set, tool.name))
          if (defs.length === original.defs.length) return original
          const byName = new Map([...original.byName].filter(([name]) => allowed(set, name)))
          return Object.freeze({
            ...original,
            defs,
            byName,
            hash: sha256Hex(
              canonicalJson(defs.map((tool) => ({ name: tool.name, parameters: tool.parameters }))),
            ),
          })
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Describe the actual filtered catalog, without exposing plugin configuration. */
export function compositionToolGroups(
  tools: ToolRegistry,
  tree: ResolvedComposition,
  catalog: import('./composition.js').BundleCatalog = {},
): readonly CompositionToolGroup[] {
  const groups = new Map<
    string,
    { packageId: string; reason: CompositionToolGroup['reason']; bundles: string[]; tools: string[] }
  >()
  for (const tool of tools.list()) {
    const registered = tools.resolve(tool.name)
    if (!registered) continue
    const packageId = registered.packageIdentity ?? registered.source.source
    let group = groups.get(packageId)
    if (!group) {
      const bundles = tree.bundles.filter(
        (id) => catalog[id]?.sourcePackage === packageId || id.startsWith(packageId + '#'),
      )
      group = {
        packageId,
        reason: bundles.length
          ? 'bundle'
          : tree.toolScope?.bundlePackages.includes(packageId)
            ? 'selected-loop'
            : registered.source.trust === 'builtin'
              ? 'official-default'
              : 'enabled-plugin',
        bundles,
        tools: [],
      }
      groups.set(packageId, group)
    }
    group.tools.push(tool.name)
  }
  return [...groups.values()].sort((a, b) => a.packageId.localeCompare(b.packageId))
}

/** Selection accepts stable Skill resource IDs or names; an empty list retains defaults. */
export function compositionSkills(
  input: SkillRuntimeInput | undefined,
  selection: CompositionPatch,
  owners: ReadonlyMap<string, string> = new Map(),
): SkillRuntimeInput | undefined {
  if (!input) return input
  if (!selection.skills?.length && !selection.packages?.some((pkg) => pkg.enabled === false)) return input
  const visible = (id: string) =>
    capabilityEnabled(
      resolveSessionCapabilities({
        selection,
        live: {
          skills: input.list().map((skill) => ({
            id: skill.resourceId,
            name: skill.name,
            packageId: owners.get(skill.resourceId),
          })),
        },
      }).skills,
      id,
    )
  return Object.freeze({
    ...input,
    list: () => input.list().filter((skill) => visible(skill.resourceId)),
    read: (id, session) =>
      visible(id) ? input.read(id, session) : { ok: false, code: 'UNAUTHORIZED' as const },
    readFile: (id, revision, path, session) =>
      visible(id)
        ? input.readFile(id, revision, path, session)
        : { ok: false, code: 'UNAUTHORIZED' as const },
    // Restricted reads go through read/readFile. Do not grant the broad user Skill file fence.
    readRoots: () => [],
  })
}

/** Package Skill IDs are derived by the public discovery helper from attested contribution paths. */
export function compositionSkillOwners(
  sources: readonly RuntimePluginSnapshot[],
): ReadonlyMap<string, string> {
  const owners = new Map<string, string>()
  for (const source of sources)
    for (const contribution of source.snapshot.contributions) {
      if (contribution.kind !== 'skill') continue
      // Package resource identity is the persisted scope/root/location digest contract.
      const location = source.snapshot.packageId + '\0' + contribution.id + '\0' + contribution.path
      const digest = createHash('sha256')
        .update('package\0package\0' + location)
        .digest('hex')
      const id = ['skill', 'package', 'package', digest].join('/')
      owners.set(id, source.snapshot.packageId)
    }
  return owners
}

export function compositionSurfaceAllowed(
  selection: CompositionPatch | undefined,
  surface: 'web' | 'acp' | 'http',
): boolean {
  return capabilityEnabled(resolveSessionCapabilities({ selection }).surfaces, surface)
}

export function compositionModuleAllowed(
  selection: CompositionPatch | undefined,
  module: { id: string; aliases?: readonly string[]; slots?: readonly string[] },
): boolean {
  return capabilityEnabled(
    resolveSessionCapabilities({
      selection,
      installed: { uiModules: [module] },
    }).uiModules,
    module.id,
  )
}
