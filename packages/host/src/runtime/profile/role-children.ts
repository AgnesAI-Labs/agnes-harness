import { createHash } from 'node:crypto'
import type { ChildRolePort, RoleDelegation } from '@agnes/core'
import type { ChildRole } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import { canonicalJson, sha256hex } from '@agnes/host-common/profile/canonical'
import type { ConfigurationService } from '@agnes/host-infrastructure/configuration'
import type { CompositionBinding } from '@agnes/host-providers/profile/composition-state'
import { parseAgentRef } from '@agnes/protocol'
import type { Host, HostSession } from '../lifecycle/host.js'
import type { createAgentResolver, sessionAdmission } from './agent-plan.js'
import { type CompositionContainer, profileForComposition } from './composition-selection.js'
import { roleToolBinding } from './role-tool-bindings.js'

export function createRoleChildren(deps: {
  host(): Host
  configuration: ConfigurationService
  admission(): ReturnType<typeof sessionAdmission>
  resolve: ReturnType<typeof createAgentResolver>
  containers: ReadonlyMap<string, CompositionContainer>
  sessionOwners: Map<string, CompositionContainer>
  pin(binding: CompositionBinding): CompositionBinding
  open(binding: CompositionBinding): Promise<{ host: Host }>
}): ChildRolePort {
  const catalogue = async (): Promise<readonly ChildRole[]> => {
    const selection = (await deps.configuration.application?.())?.selection
    const snapshot = selection?.consentSnapshot
    if (!selection || !snapshot) return []
    const { consentDigest, ...content } = snapshot
    if (
      snapshot.packageId !== selection.packageId ||
      snapshot.integrity !== selection.integrity ||
      snapshot.declaration.id !== selection.applicationId ||
      snapshot.declarationDigest !== selection.declarationDigest ||
      createHash('sha256').update(canonicalJson(snapshot.declaration)).digest('hex') !==
        selection.declarationDigest ||
      consentDigest !== selection.consentDigest ||
      createHash('sha256').update(canonicalJson(content)).digest('hex') !== consentDigest
    )
      return []
    const { current } = await deps.admission()
    if (
      !current.packages.some(
        (pkg) => pkg.id === selection.packageId && pkg.enabled && pkg.integrity === selection.integrity,
      )
    )
      return []
    return (snapshot.declaration.delegableAgents ?? []).map((ref) => {
      if (!snapshot.declaration.agents?.includes(ref))
        throw new HostError('E_PRESET_UNSUPPORTED', 'Delegable role is absent from application agents')
      const launch = current.bundleCatalog?.[ref]?.document.launch
      if (!launch) throw new HostError('E_PRESET_UNSUPPORTED', `Application role is not launchable: ${ref}`)
      return { ref, title: launch.title, ...(launch.description ? { description: launch.description } : {}) }
    })
  }
  return {
    list: () => catalogue(),
    async resolve(parent, input) {
      const ref = parseAgentRef(input)
      // Snapshot before the first await. Never retain a live parent authorization link.
      const parentPreset = structuredClone(parent.preset)
      const actor = structuredClone(parent.d.actor)
      const permission =
        parent.permissionContext.policy === 'read-only' ||
        parent.preset.approval.policy === 'read-only' ||
        deps.sessionOwners.get(parent.key)?.host.sessionCapabilities?.(parent.key)?.permissions.readOnly ===
          true
          ? 'read-only'
          : 'workspace-write'
      const parentHost = deps.sessionOwners.get(parent.key)?.host ?? deps.host()
      const parentResources = structuredClone(parentHost.sessionCapabilities?.(parent.key))
      const parentTools = [...parent.currentTools().snapshot(parent.lastSeq).byName.values()]
      const parentBindings = new Map(
        parentTools.map((tool) => [tool.name, roleToolBinding(parentHost, tool)]),
      )
      const sandbox = (parent as HostSession).commandSandboxPolicy?.()
      if (!sandbox)
        throw new HostError('E_PRESET_UNSUPPORTED', 'Parent workspace policy snapshot is unavailable')
      const filesystem = structuredClone(sandbox.policy)
      if (sandbox.network === 'allow') filesystem.networkAllow = ['*']
      const enforced = parent.d.runtime.enforcement().level !== 'none'
      const role = (await catalogue()).find((entry) => entry.ref === ref)
      if (!role)
        throw new HostError(
          'E_PRESET_UNSUPPORTED',
          `Role is not delegable by the adopted application: ${ref}`,
        )
      const reviewed = await deps.resolve(ref)
      const candidate = await deps.open({ sessionKey: '', tree: reviewed.tree, profile: reviewed.profile })
      const enabled =
        candidate.host
          .sessionCapabilities?.('')
          ?.tools.filter((tool) => tool.enabled)
          .map((tool) => tool.id) ?? []
      const roleCapabilities = candidate.host.sessionCapabilities?.('')
      const resources = {
        mcp: (parentResources?.mcp ?? [])
          .filter(
            (item) =>
              item.enabled && roleCapabilities?.mcp.some((other) => other.enabled && other.id === item.id),
          )
          .map((item) => item.id),
        skills: (parentResources?.skills ?? [])
          .filter(
            (item) =>
              item.enabled && roleCapabilities?.skills.some((other) => other.enabled && other.id === item.id),
          )
          .map((item) => item.id),
      }
      const rolePreset = candidate.host.kernel.o.preset
      const tools = parentTools
        .filter(
          (tool) =>
            parentBindings.get(tool.name) !== undefined &&
            parentBindings.get(tool.name) ===
              (candidate.host.kernel.tools.resolve(tool.name)
                ? roleToolBinding(candidate.host, candidate.host.kernel.tools.resolve(tool.name)!)
                : undefined) &&
            enabled.includes(tool.name) &&
            (rolePreset.tools.allow === undefined || rolePreset.tools.allow.includes(tool.name)) &&
            candidate.host.kernel.tools.resolve(tool.name)?.definitionFingerprint ===
              tool.definitionFingerprint,
        )
        .map((tool) => tool.name)
      const rolePermissions = candidate.host.sessionCapabilities?.('')?.permissions
      const roleReadOnly =
        rolePermissions?.readOnly === true ||
        rolePermissions?.policy === 'read-only' ||
        rolePreset.permission === 'read-only' ||
        rolePreset.approval.policy === 'read-only'
      const captured: RoleDelegation = {
        role,
        parentKey: parent.key,
        actor,
        tools,
        resources,
        generationLimit: Math.min(parentPreset.generationLimit, rolePreset.generationLimit),
        maxFanOut: Math.min(parentPreset.maxFanOut, rolePreset.maxFanOut),
        permission: roleReadOnly ? 'read-only' : permission,
        approvalPolicy: 'never',
        filesystem,
        sandboxRequired: enforced,
        parentPolicy:
          parentPreset.approval.policy === 'full-access'
            ? 'default'
            : (parentPreset.approval.policy ?? 'default'),
        ...(parentPreset.approval.commandTable ? { commandTable: parentPreset.approval.commandTable } : {}),
      }
      const { hash: _hash, ...body } = reviewed.tree
      const narrowed = {
        ...body,
        selection: {
          ...body.selection,
          tools,
          toolPolicy: {
            ...body.selection.toolPolicy,
            allow: tools,
            readOnly: permission === 'read-only' || body.selection.toolPolicy?.readOnly === true,
          },
        },
      }
      const tree = { ...narrowed, hash: `sha256-${sha256hex(canonicalJson(narrowed))}` }
      const profile = profileForComposition(reviewed.profile, tree)
      return {
        role,
        async open(key, options) {
          const binding = deps.pin({ sessionKey: key, tree, profile })
          const container = await deps.open(binding)
          const child = await container.host.createSession({
            key,
            cwd: options.cwd,
            preset: tree.preset,
            strict: true,
            roleDelegation: {
              ...captured,
              tools: captured.tools.filter(
                (name) =>
                  !options.toolFilter?.deny?.includes(name) &&
                  (options.toolFilter?.allow === undefined || options.toolFilter.allow.includes(name)),
              ),
            },
            ...(options.delegation ? { delegation: options.delegation } : {}),
            writerRunId: options.writerRunId,
            ...(options.lane ? { lane: options.lane } : {}),
          })
          const close = child.close.bind(child)
          child.close = async () => {
            try {
              await close()
            } finally {
              container.host.kernel.sessions.delete(key)
              deps.sessionOwners.delete(key)
            }
          }
          const owned = [...deps.containers.values()].find((entry) => entry.host === container.host)
          if (owned) deps.sessionOwners.set(key, owned)
          return child
        },
      }
    },
  }
}

/** Container construction precedes the agent resolver; access these dependencies only at spawn. */
export function lazyRoleChildren(deps: () => Parameters<typeof createRoleChildren>[0]): ChildRolePort {
  return {
    list: (parent) => createRoleChildren(deps()).list(parent),
    resolve: (parent, ref) => createRoleChildren(deps()).resolve(parent, ref),
  }
}
