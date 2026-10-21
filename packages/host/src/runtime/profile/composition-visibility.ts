import { AsyncLocalStorage } from 'node:async_hooks'
import { sha256Hex, type ToolRegistry, ToolRegistryView } from '@agnes/core'
import type { CompositionPatch, ResolvedComposition } from '@agnes/host-common/profile/composition'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import type { CompositionToolGroup } from '@agnes/host-providers/profile/composition-state'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { SessionCapabilityInput } from './session-capabilities.js'
import {
  capabilityEnabled,
  capabilityToolCatalog,
  resolveSessionCapabilities,
  type SessionCapabilitySet,
} from './session-capabilities.js'

type VisibilitySelection = Pick<
  CompositionPatch,
  'packages' | 'toolPolicy' | 'tools' | 'mcp' | 'skills' | 'uiModules' | 'shell' | 'surfaces'
>

/** A read facade; registration and leases stay owned by the generation's original registry. */
export function compositionTools(
  tools: ToolRegistry,
  selection: VisibilitySelection,
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
  return new ToolRegistryView(tools, () =>
    capabilities()
      .tools.filter((tool) => tool.enabled)
      .map((tool) => tool.id),
  )
}

/** Describe the actual filtered catalog, without exposing plugin configuration. */
export function compositionToolGroups(
  tools: ToolRegistry,
  tree: ResolvedComposition,
  catalog: import('@agnes/host-common/profile/composition').BundleCatalog = {},
): readonly CompositionToolGroup[] {
  const groups = new Map<
    string,
    { packageId: string; reason: CompositionToolGroup['reason']; bundles: string[]; tools: string[] }
  >()
  // Capture one authorized view. Resolving each tool again both mixes live selections and
  // repeats the full session/model capability resolver for every item in periodic status.
  for (const registered of tools.snapshot(0).byName.values()) {
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
    group.tools.push(registered.name)
  }
  return [...groups.values()].sort((a, b) => a.packageId.localeCompare(b.packageId))
}

/** Selection accepts stable Skill resource IDs or names; an empty list retains defaults. */
export function compositionSkills(
  input: SkillRuntimeInput | undefined,
  selection: VisibilitySelection,
  owners: ReadonlyMap<string, string> = new Map(),
  resourceScope?: (sessionKey?: string) => SessionCapabilityInput['resourceScope'],
): SkillRuntimeInput | undefined {
  if (!input) return input
  const restricted = !!selection.skills?.length || selection.packages?.some((pkg) => pkg.enabled === false)
  if (!restricted && !resourceScope) return input
  const workspace = new AsyncLocalStorage<string>()
  const capabilities = (skills = input.list(), sessionKey = workspace.getStore()) =>
    resolveSessionCapabilities({
      selection,
      ...(resourceScope?.(sessionKey) ? { resourceScope: resourceScope(sessionKey)! } : {}),
      live: {
        skills: skills.map((skill) => ({
          id: skill.resourceId,
          name: skill.name,
          packageId: owners.get(skill.resourceId),
        })),
      },
    }).skills
  const visible = (id: string, sessionKey: string) =>
    capabilityEnabled(capabilities(input.list(), sessionKey), id)
  return Object.freeze({
    ...input,
    list: () => {
      const skills = input.list()
      const set = capabilities(skills)
      return skills.filter((skill) => capabilityEnabled(set, skill.resourceId))
    },
    read: (id, session) =>
      visible(id, session.sessionKey)
        ? input.read(id, session)
        : { ok: false, code: 'UNAUTHORIZED' as const },
    readFile: (id, revision, path, session) =>
      visible(id, session.sessionKey)
        ? input.readFile(id, revision, path, session)
        : { ok: false, code: 'UNAUTHORIZED' as const },
    // Restricted reads go through read/readFile. Do not grant the broad user Skill file fence.
    readRoots: () => (restricted || resourceScope?.(workspace.getStore()) ? [] : (input.readRoots?.() ?? [])),
    scopeWorkspace: (root, sessionKey, invoke) =>
      workspace.run(sessionKey, () =>
        input.scopeWorkspace ? input.scopeWorkspace(root, sessionKey, invoke) : invoke(),
      ),
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
      const digest = sha256Hex('package\0package\0' + location)
      const id = ['skill', 'package', 'package', digest].join('/')
      owners.set(id, source.snapshot.packageId)
    }
  return owners
}

export function compositionSurfaceAllowed(
  selection: VisibilitySelection | undefined,
  surface: 'web' | 'acp' | 'http',
): boolean {
  return capabilityEnabled(resolveSessionCapabilities({ selection }).surfaces, surface)
}

export function compositionModuleAllowed(
  selection: VisibilitySelection | undefined,
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
