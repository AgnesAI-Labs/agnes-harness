import { createHash } from 'node:crypto'
import type { ToolRegistry } from '@agnes/core'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { SkillRuntimeInput } from '../resources/skills.js'
import type { CompositionPatch } from './composition.js'
import { compositionAllowsTool } from './composition.js'

/** A read facade; registration and leases stay owned by the generation's original registry. */
export function compositionTools(tools: ToolRegistry, selection: CompositionPatch): ToolRegistry {
  // Decode the registered MCP name contract without loading its concrete provider package.
  const mcpPrefixes = selection.mcp?.map((id) => {
    const serverId = id.replace(/^mcp\//, '')
    const slug =
      serverId
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'server'
    const hash = createHash('sha256').update(serverId, 'utf8').digest('hex').slice(0, 8)
    return ['mcp', slug, hash, ''].join('_')
  })
  const allowed = (name: string): boolean => {
    const registered = tools.resolve(name)
    return (
      !!registered &&
      !selection.packages?.some((pkg) => pkg.id === registered.packageIdentity && pkg.enabled === false) &&
      compositionAllowsTool(selection, name, registered.meta.isReadOnly) &&
      (!name.startsWith('mcp_') ||
        !mcpPrefixes?.length ||
        selection.mcp?.includes(registered.packageIdentity ?? '') ||
        mcpPrefixes.some((prefix) => name.startsWith(prefix)))
    )
  }
  return new Proxy(tools, {
    get(target, property) {
      if (property === 'list') return () => target.list().filter((tool) => allowed(tool.name))
      if (property === 'resolve') return (name: string) => (allowed(name) ? target.resolve(name) : undefined)
      if (property === 'size') return target.list().filter((tool) => allowed(tool.name)).length
      if (property === 'snapshot')
        return (seq: Parameters<ToolRegistry['snapshot']>[0]) => {
          const original = target.snapshot(seq)
          const defs = original.defs.filter((tool) => allowed(tool.name))
          const byName = new Map([...original.byName].filter(([name]) => allowed(name)))
          return Object.freeze({
            ...original,
            defs,
            byName,
            hash: createHash('sha256')
              .update(original.hash + '\0' + JSON.stringify(defs.map((tool) => tool.name)))
              .digest('hex'),
          })
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Selection accepts stable Skill resource IDs or names; an empty list retains defaults. */
export function compositionSkills(
  input: SkillRuntimeInput | undefined,
  selection: CompositionPatch,
  owners: ReadonlyMap<string, string> = new Map(),
): SkillRuntimeInput | undefined {
  if (!input) return input
  const denied = new Set(selection.packages?.filter((pkg) => pkg.enabled === false).map((pkg) => pkg.id))
  if (!selection.skills?.length && !denied.size) return input
  const visible = (id: string) =>
    input
      .list()
      .some(
        (skill) =>
          skill.resourceId === id &&
          !denied.has(owners.get(id) ?? '') &&
          (!selection.skills?.length ||
            selection.skills.includes(id) ||
            selection.skills.includes(skill.name) ||
            selection.skills.includes(owners.get(id) ?? '')),
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
  return selection?.surfaces === undefined || selection.surfaces.includes(surface)
}

export function compositionModuleAllowed(
  selection: CompositionPatch | undefined,
  module: { id: string; aliases?: readonly string[]; slots?: readonly string[] },
): boolean {
  const identities = [module.id, ...(module.aliases ?? [])]
  return (
    compositionSurfaceAllowed(selection, 'web') &&
    (!selection?.uiModules?.length || identities.some((id) => selection.uiModules!.includes(id))) &&
    (selection?.shell?.modules === undefined ||
      identities.some((id) => selection.shell!.modules!.includes(id))) &&
    (selection?.shell?.slots === undefined ||
      (!!module.slots?.length && module.slots.every((slot) => selection.shell!.slots!.includes(slot))))
  )
}
