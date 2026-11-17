import type { SandboxCapabilities } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import {
  type compileWorkspacePolicy,
  normalizeSandboxStaticConfig,
  planExplicitDeny,
  type SandboxStaticConfig,
} from '@agnes/host-common/workspace-policy'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { sandboxReadPaths } from '@agnes/host-infrastructure/sandbox-read-paths'
import { SandboxReadinessManager } from '@agnes/host-infrastructure/sandbox-readiness-manager'
import {
  bindStartupSandboxProvider,
  sandboxProviderIdFrom,
} from '@agnes/host-providers/adapters/sandbox-providers'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { ProcessServices } from './process-services.js'
import { assertHostSpawnProbe, sandboxConfigTarget, windowsHostSpawnOffer } from './workspace-windows-acl.js'

/** Compiled policies by workspace root identity and static config hash. */
export type WorkspacePlans = Map<string, Awaited<ReturnType<typeof compileWorkspacePolicy>>>

/** Reviewed `sandbox.loopback_serve` needs the local macOS Seatbelt backend. */
export const loopbackServeSupported = (os: string, remote: boolean): boolean => os === 'darwin' && !remote

/**
 * Where the loopback listener cannot be provided, the session still opens and only that capability is
 * dropped: the policy falls back to the same closed L1 network it would have without the grant. Nothing
 * is added, `on_unavailable` is untouched, and a command that tries to serve gets no listener fd.
 */
export function degradeLoopbackServe<T extends { loopbackServe?: boolean }>(
  sandbox: T,
  supported: boolean,
): T {
  if (!sandbox.loopbackServe || supported) return sandbox
  const { loopbackServe: _dropped, ...rest } = sandbox
  return rest as T
}

/**
 * The static sandbox config a session on this Host runs under; the admin status describes the same.
 * A policy that opted into the Windows write restriction keeps its loopback request: that restriction
 * leaves the network open, so it cannot stand in for the closed network the dropped request falls back
 * to, and the Windows decision refuses the request instead.
 */
export function requestedSandboxConfig(
  preset: Readonly<Record<string, unknown>>,
  adapters: Readonly<{ platform: { os: string }; transport?: unknown }>,
  localProvider: boolean,
): SandboxStaticConfig {
  const config = normalizeSandboxStaticConfig(preset, sandboxConfigTarget(adapters))
  return degradeLoopbackServe(
    config,
    config.windowsMode === 'write-restricted' ||
      (localProvider && loopbackServeSupported(adapters.platform.os, adapters.transport !== undefined)),
  )
}

/**
 * Decides, per workspace, which sandbox posture a session gets: remote, an external provider's
 * enforcement, or the sandbox package's own probe of the local backend. The probe is revoked with the assembly.
 */
export function createReadinessManager(
  ctx: AssemblyContext,
  pkgs: PackageSet,
  proc: ProcessServices,
  workspacePlans: WorkspacePlans,
): SandboxReadinessManager {
  const { deps, rollback } = ctx
  const { modules } = pkgs
  const { adapters, sandboxProviderSlot } = proc
  const workspaceProbe = localSandboxProbe(ctx.profile, modules)
  const rawProbe = adapters.createProbeExec()
  rollback.push('workspace-sandbox-probe', () => rawProbe.revoke())
  const readinessManager = new SandboxReadinessManager(async (key) => {
    const plan = workspacePlans.get(JSON.stringify([key.canonicalRoot, key.staticConfigHash]))
    if (!plan)
      throw new HostError('E_SANDBOX_WORKSPACE', 'workspace readiness has no compiled policy', {
        detail: { reason: 'workspace-policy-missing' },
      })
    if (
      plan.staticConfig.loopbackServe &&
      !loopbackServeSupported(adapters.platform.os, !!adapters.transport)
    )
      throw new HostError(
        'E_SANDBOX_WORKSPACE',
        'loopback serving is available only with the local macOS L1 Seatbelt provider',
      )
    if (adapters.transport && plan.staticConfig.onUnavailable === 'allow-if-unimplemented')
      throw new HostError(
        'E_SANDBOX_WORKSPACE',
        'remote transport does not declare conditional local isolation support',
      )
    if (adapters.transport)
      return Object.freeze({
        name: 'remote' as const,
        execBackend: 'remote' as const,
        enforcement: Object.freeze({ level: 'none' as const, scope: Object.freeze([]) }),
        confine: async () => {
          throw new HostError('E_SANDBOX_WORKSPACE', 'remote workspaces cannot confine a local process', {
            detail: { reason: 'remote-local-confine' },
          })
        },
      })
    const providerId = sandboxProviderIdFrom(ctx.profile)
    if (providerId !== RELEASE_DEFAULTS.sandboxProvider) {
      if (plan.staticConfig.loopbackServe)
        throw new HostError(
          'E_SANDBOX_WORKSPACE',
          'loopback serving requires the local macOS L1 Seatbelt provider',
        )
      await bindStartupSandboxProvider(sandboxProviderSlot, ctx.profile, plan.policy.workspaceRoot, undefined)
      const selected = sandboxProviderSlot.selected
      if (!selected) throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox provider instance is unavailable')
      return externalProviderPosture(selected.capabilities, plan.staticConfig, providerId)
    }
    if (!workspaceProbe)
      throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox workspace probe is unavailable', {
        detail: { reason: 'workspace-probe-missing' },
      })
    // On Windows the trusted local provider decides the partial contract and probes the root itself.
    const hostSpawn = await windowsHostSpawnOffer({
      execution: proc.windowsAcl,
      os: adapters.platform.os,
      staticConfig: plan.staticConfig,
      customFsDeny: planExplicitDeny(plan),
      providerId,
      localProviderId: RELEASE_DEFAULTS.sandboxProvider,
      localImplementation: localSandboxImplementation(ctx.profile, modules, adapters.platform.os),
      root: plan.policy.workspaceRoot,
      policyDigest: plan.policy.digest,
    })
    const raw = await workspaceProbe({
      level: plan.staticConfig.level,
      required: plan.staticConfig.required,
      onUnavailable: plan.staticConfig.onUnavailable,
      platform: adapters.platform.os,
      shell: adapters.platform.shell(),
      options: {
        ...plan.backendOptions,
        get readPaths() {
          return adapters.platform.os === 'linux' && plan.staticConfig.access !== 'full-access'
            ? sandboxReadPaths(plan.backendOptions.denyPaths)
            : undefined
        },
      },
      probeExec: rawProbe.run,
      log: deps.log,
      signal: key.signal,
      ...(hostSpawn ? { hostSpawn } : {}),
    })
    assertHostSpawnProbe(raw, hostSpawn)
    if (plan.staticConfig.onUnavailable === 'allow-if-unimplemented' && !hostSpawn) {
      const support = localSandboxImplementation(ctx.profile, modules, adapters.platform.os)
      if (
        raw.implementation !== support ||
        support === 'unknown' ||
        (raw.execBackend === 'none' && (support !== 'unimplemented' || !raw.degraded)) ||
        (raw.execBackend === 'l1' && (support !== 'implemented' || raw.probeState !== 'ready'))
      )
        throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox capability and execution probe disagree')
    }
    if (!raw.execBackend || !raw.enforcement)
      throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox probe omitted its posture', {
        detail: { reason: 'workspace-posture-missing' },
      })
    return raw
  })
  rollback.push('workspace-sandbox-readiness', () => readinessManager.revoke())
  return readinessManager
}

/**
 * The posture of a workspace whose commands an external sandbox provider runs: its declared
 * enforcement, which must be full where the policy requires L1. A Windows write boundary in that
 * declaration is dropped: only the Host's own local provider applies it, when the Host starts the
 * process, so another provider naming it describes nothing the Host enforces.
 */
export function externalProviderPosture(
  capabilities: SandboxCapabilities,
  staticConfig: SandboxStaticConfig,
  providerId: string,
) {
  const declared = capabilities.enforcement ?? { level: 'none' as const, scope: [] }
  const enforcement = { level: declared.level, scope: [...declared.scope] }
  const full =
    enforcement.level === 'full' &&
    ['file', 'network', 'process'].every((scope) =>
      enforcement.scope.includes(scope as 'file' | 'network' | 'process'),
    )
  if (
    !capabilities.available ||
    (!full &&
      (staticConfig.required || (staticConfig.level === 'L1' && staticConfig.onUnavailable !== 'allow')))
  )
    throw new HostError(
      'E_SANDBOX_WORKSPACE',
      `sandbox provider ${providerId} cannot enforce the required L1 policy`,
    )
  return Object.freeze({
    execBackend: full && staticConfig.level === 'L1' ? ('l1' as const) : ('none' as const),
    enforcement,
    confine: async (): Promise<never> => {
      throw new HostError('E_SANDBOX_WORKSPACE', 'external provider cannot rewrite host argv')
    },
  })
}

/**
 * The OS-confinement probe of the local sandbox. Only a builtin package may supply it: the posture
 * it reports (backend, enforcement, the argv rewrite) is what the Host trusts as local isolation.
 */
export function localSandboxImplementation(
  profile: Pick<ResolvedProfile, 'packages'>,
  modules: ReadonlyMap<string, PackageModule>,
  platform: string,
): 'implemented' | 'unimplemented' | 'unknown' {
  const probe = localSandboxProbe(profile, modules)
  const supplier = [...modules].find(
    ([id, mod]) =>
      probe !== undefined &&
      mod.sandboxWorkspaceProbe === probe &&
      profile.packages.some((pkg) => pkg.id === id && pkg.trust === 'builtin'),
  )?.[1]
  const support = supplier?.sandboxImplementation?.(platform)
  return support === 'implemented' || support === 'unimplemented' ? support : 'unknown'
}

export function localSandboxProbe(
  profile: Pick<ResolvedProfile, 'packages'>,
  modules: ReadonlyMap<string, PackageModule>,
): PackageModule['sandboxWorkspaceProbe'] {
  const suppliers = [...modules].filter(
    ([id, mod]) =>
      mod.sandboxWorkspaceProbe !== undefined &&
      profile.packages.some((pkg) => pkg.id === id && pkg.trust === 'builtin'),
  )
  if (suppliers.length > 1)
    throw new HostError('E_EXT_LOAD', 'more than one builtin package exports sandboxWorkspaceProbe', {
      detail: { packages: suppliers.map(([id]) => id) },
    })
  return suppliers[0]?.[1].sandboxWorkspaceProbe
}
