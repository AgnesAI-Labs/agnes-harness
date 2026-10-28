import {
  type ChildRolePort,
  intersectCapabilities,
  type RoleDelegation,
  type SessionOptions,
} from '@agnes/core'
import type { ChildRole } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import type { ConfigurationService } from '@agnes/host-infrastructure/configuration'
import type { CompositionBinding } from '@agnes/host-providers/profile/composition-state'
import { applicationConsentSnapshot } from '@agnes/package-manager'
import { parseAgentRef } from '@agnes/protocol'
import type { Host, HostSession } from '../lifecycle/host.js'
import type { CreateSessionOptions } from '../sessions/session.js'
import type { createAgentResolver, sessionAdmission } from './agent-plan.js'
import type { CompositionContainer } from './composition-selection.js'
import { roleToolBindingIdentity } from './role-tool-bindings.js'
import { intersectRoleTools, recordRoleToolIntersection } from './role-tool-intersection.js'

/**
 * The workspace a role child opens in: the parent's own, under the authority the parent was granted
 * (key aside), exactly as a fork inherits it. Without a parent identity the child falls back to its cwd.
 */
function inheritedWorkspace(
  host: Host,
  key: string,
  options: Pick<SessionOptions, 'cwd' | 'workspaceIdentity'>,
): Pick<CreateSessionOptions, 'cwd' | 'binding'> {
  const identity = options.workspaceIdentity
  if (!identity) return { cwd: options.cwd }
  return {
    cwd: identity.canonicalRoot,
    binding: host.acceptWorkspaceBinding(
      {
        version: 1,
        sessionKey: key,
        workspaceId: identity.workspaceId,
        revision: identity.authorityRevision,
        canonicalRoot: identity.canonicalRoot,
        ...(identity.extraRoots?.length ? { extraRoots: identity.extraRoots } : {}),
      },
      key,
    ),
  }
}

export function createRoleChildren(deps: {
  host(): Host
  configuration: ConfigurationService
  admission(): ReturnType<typeof sessionAdmission>
  resolve: ReturnType<typeof createAgentResolver>
  containers: ReadonlyMap<string, CompositionContainer>
  sessionOwners: Map<string, CompositionContainer>
  read(key: string): CompositionBinding | undefined
  pin(binding: CompositionBinding): CompositionBinding
  open(binding: CompositionBinding): Promise<{ host: Host }>
}): ChildRolePort {
  const catalogue = async (): Promise<readonly ChildRole[]> => {
    const selection = (await deps.configuration.application?.())?.selection
    const snapshot = applicationConsentSnapshot(selection)
    if (!selection || !snapshot) return []
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
  // The adopted application's own declaration; the catalogue has already checked the package is current.
  const declaresFullAccess = async (): Promise<boolean> =>
    applicationConsentSnapshot((await deps.configuration.application?.())?.selection)?.declaration
      .delegatedFullAccess === true
  return {
    list: () => catalogue(),
    async reopen(key, options) {
      const binding = deps.read(key)
      if (!binding || binding.sessionKey !== key)
        throw new HostError('E_PRESET_UNSUPPORTED', 'Role child composition binding is unavailable')
      const container = await deps.open(binding)
      const child = await container.host.createSession({
        key,
        ...inheritedWorkspace(container.host, key, options),
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
    async resolve(parent, input) {
      const ref = input
      // Copy synchronous parent state before the first await; resources enter its workspace below.
      // Never retain a live parent authorization link after admission.
      const parentPreset = structuredClone(parent.preset)
      const triggerSeq = parent.op()?.meta.triggerSeq
      const parentAuthority = parent.roleAuthority
      const parentTainted =
        parent.laneTaint() || (parentAuthority !== undefined && parentAuthority.parentTainted !== false)
      const commandTable = [
        ...(parentPreset.approval.commandTable ?? []),
        ...(parentAuthority?.commandTable ?? []),
      ]
      const actor = structuredClone(parent.d.actor)
      const permission =
        parent.permissionContext.policy === 'read-only' ||
        parent.preset.approval.policy === 'read-only' ||
        deps.sessionOwners.get(parent.key)?.host.sessionCapabilities?.(parent.key)?.permissions.readOnly ===
          true
          ? 'read-only'
          : 'workspace-write'
      const parentHost = deps.sessionOwners.get(parent.key)?.host ?? deps.host()
      const workspace = parent.d.workspaceInvocation
      if (!workspace || !parentHost.captureSessionCapabilities)
        throw new HostError('E_PRESET_UNSUPPORTED', 'Parent resource workspace is unavailable')
      const parentTools = [...parent.currentTools().snapshot(parent.lastSeq).byName.values()]
      const parentBindingIdentities = new Map(
        parentTools.map((tool) => [tool.name, roleToolBindingIdentity(parentHost, tool)]),
      )
      const sandbox = (parent as HostSession).commandSandboxPolicy?.()
      if (!sandbox)
        throw new HostError('E_PRESET_UNSUPPORTED', 'Parent workspace policy snapshot is unavailable')
      const filesystem = structuredClone(sandbox.policy)
      if (sandbox.network === 'allow') filesystem.networkAllow = ['*']
      const enforced = parent.d.runtime.enforcement().level !== 'none'
      const [trigger] =
        triggerSeq === undefined
          ? []
          : await parent.d.log.scan({
              type: 'user/message',
              lane: parent.lane,
              toSeq: triggerSeq,
              order: 'desc',
              limit: 1,
            })
      const humanApprovals =
        parentAuthority?.humanApprovals !== false &&
        !(trigger?.origin === 'system' && trigger.actor.attrs.unattendedApproval === 'refuse')
      const parentResources = await parentHost.captureSessionCapabilities(parent.key, workspace)
      const available = await catalogue()
      const role = available.find((entry) => entry.ref === ref)
      if (!role)
        throw new HostError(
          'E_PRESET_UNSUPPORTED',
          available.length
            ? `unknown role ${input}; available: ${available.map((entry) => entry.ref).join(', ')}`
            : 'no roles are declared in this session; omit role',
        )
      // Only trusted declared references reach the protocol parser.
      parseAgentRef(ref)
      const reviewed = await deps.resolve(ref)
      const candidate = await deps.open({ sessionKey: '', tree: reviewed.tree, profile: reviewed.profile })
      if (!candidate.host.captureSessionCapabilities)
        throw new HostError('E_PRESET_UNSUPPORTED', 'Role resource workspace is unavailable')
      const roleCapabilities = await candidate.host.captureSessionCapabilities('', workspace)
      const enabled = roleCapabilities.tools.filter((tool) => tool.enabled).map((tool) => tool.id)
      const resources = {
        mcp: intersectCapabilities(parentResources.mcp, roleCapabilities.mcp),
        skills: intersectCapabilities(parentResources.skills, roleCapabilities.skills),
      }
      const rolePreset = candidate.host.kernel.o.preset
      const declared = reviewed.tree.selection.tools?.length
        ? reviewed.tree.selection.tools
        : (reviewed.tree.selection.toolPolicy?.allow ??
          roleCapabilities.tools.filter((tool) => tool.enabled).map((tool) => tool.id))
      const { tools, excluded } = intersectRoleTools({
        declared,
        parent: parentTools,
        parentIdentities: parentBindingIdentities,
        candidate: candidate.host,
        enabled,
        allow: rolePreset.tools.allow,
      })
      await recordRoleToolIntersection(parent, ref, declared, tools, excluded)
      const rolePermissions = roleCapabilities.permissions
      const roleReadOnly =
        rolePermissions?.readOnly === true ||
        rolePermissions?.policy === 'read-only' ||
        rolePreset.permission === 'read-only' ||
        rolePreset.approval.policy === 'read-only'
      // A nested role holds the opt-in only if the role that delegated to it does.
      const delegatedFullAccess =
        (await declaresFullAccess()) && (!parentAuthority || parentAuthority.delegatedFullAccess === true)
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
        parentTainted,
        humanApprovals,
        ...(delegatedFullAccess ? { delegatedFullAccess: true as const } : {}),
        filesystem,
        sandboxRequired: enforced,
        parentPolicy:
          parentPreset.approval.policy === 'full-access'
            ? 'default'
            : (parentPreset.approval.policy ?? 'default'),
        ...(commandTable.length ? { commandTable } : {}),
        ...(parentAuthority
          ? {
              policyCeilings: [
                {
                  policy: parentAuthority.parentPolicy,
                  ...(parentAuthority.commandTable ? { commandTable: parentAuthority.commandTable } : {}),
                },
                ...(parentAuthority.policyCeilings ?? []),
              ],
            }
          : {}),
      }
      const { tree, profile } = reviewed
      return {
        role,
        async open(key, options) {
          const filtered = captured.tools.filter(
            (name) =>
              !options.toolFilter?.deny?.includes(name) &&
              (options.toolFilter?.allow === undefined || options.toolFilter.allow.includes(name)),
          )
          if (filtered.length !== captured.tools.length)
            await recordRoleToolIntersection(parent, ref, declared, filtered, [
              ...excluded,
              ...captured.tools
                .filter((name) => !filtered.includes(name))
                .map((tool) => ({ tool, reason: 'child-tool-filter-denied' })),
            ])
          const binding = deps.pin({ sessionKey: key, tree, profile })
          const container = await deps.open(binding)
          const child = await container.host.createSession({
            key,
            ...inheritedWorkspace(container.host, key, options),
            preset: tree.preset,
            strict: true,
            roleDelegation: {
              ...captured,
              tools: filtered,
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
    reopen: (key, options) => createRoleChildren(deps()).reopen!(key, options),
    resolve: (parent, ref) => createRoleChildren(deps()).resolve(parent, ref),
  }
}
