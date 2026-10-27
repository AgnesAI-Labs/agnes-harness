import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { Enforcement, SandboxExecBackend, SeamImplementations } from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import { privateStateRoots } from '@agnes/host-common/paths'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { commandHookInvocationSnapshot } from '@agnes/host-common/profile-policy'
import type { WorkspaceBinding } from '@agnes/host-common/workspace-authority'
import {
  compileWorkspacePolicy,
  intersectWorkspacePlan,
  memoryFileIsolation,
  normalizeSandboxStaticConfig,
} from '@agnes/host-common/workspace-policy'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { powerShellCommand } from '@agnes/host-infrastructure/adapters/powershell-command'
import type { SessionWorkspaceFence } from '@agnes/host-infrastructure/adapters/session-workspace'
import { sandboxReadPaths } from '@agnes/host-infrastructure/sandbox-read-paths'
import { SandboxReadinessManager } from '@agnes/host-infrastructure/sandbox-readiness-manager'
import { prepareSandboxWorkspaceAncestor } from '@agnes/host-infrastructure/sandbox-workspace-ancestor'
import {
  createSessionWorkspaceRuntime,
  type SessionWorkspaceRuntime,
  type WorkspaceRuntimeFence,
} from '@agnes/host-infrastructure/session-workspace-runtime'
import { WorkspaceHookLoader } from '@agnes/host-infrastructure/workspace-hook-loader'
import {
  openWorkspaceSeamContexts,
  type WorkspaceSeamContexts,
} from '@agnes/host-infrastructure/workspace-seam-contexts'
import {
  bindStartupSandboxProvider,
  sandboxProviderIdFrom,
} from '@agnes/host-providers/adapters/sandbox-providers'
import { SessionSandboxStore } from '@agnes/host-providers/profile/sandbox-state'
import { isWorkspaceHooksTrusted, RELEASE_DEFAULTS } from '@agnes/package-manager'
import { remoteSandboxModule } from '../adapters/index.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { PresetCatalog } from './presets.js'
import type { ProcessServices } from './process-services.js'
import type { SeamContexts } from './seam-contexts.js'
import { trustedHookCommands } from './trusted-hooks.js'

type WorkspacePlans = Map<string, Awaited<ReturnType<typeof compileWorkspacePolicy>>>

/** Reviewed `sandbox.loopback_serve` needs the local macOS Seatbelt backend; every other host refuses the session. */
export const loopbackServeSupported = (os: string, remote: boolean): boolean => os === 'darwin' && !remote

/**
 * Decides, per workspace, which sandbox posture a session gets: remote, an external provider's
 * enforcement, or the sandbox package's own probe of the local backend. The probe is revoked with the assembly.
 */
function createReadinessManager(
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
      const capabilities = selected.capabilities
      const enforcement = capabilities.enforcement ?? { level: 'none' as const, scope: [] }
      const full =
        enforcement.level === 'full' &&
        ['file', 'network', 'process'].every((scope) =>
          enforcement.scope.includes(scope as 'file' | 'network' | 'process'),
        )
      if (
        !capabilities.available ||
        (!full &&
          (plan.staticConfig.required ||
            (plan.staticConfig.level === 'L1' && plan.staticConfig.onUnavailable !== 'allow')))
      )
        throw new HostError(
          'E_SANDBOX_WORKSPACE',
          `sandbox provider ${providerId} cannot enforce the required L1 policy`,
        )
      return Object.freeze({
        execBackend: full && plan.staticConfig.level === 'L1' ? ('l1' as const) : ('none' as const),
        enforcement,
        confine: async () => {
          throw new HostError('E_SANDBOX_WORKSPACE', 'external provider cannot rewrite host argv')
        },
      })
    }
    if (!workspaceProbe)
      throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox workspace probe is unavailable', {
        detail: { reason: 'workspace-probe-missing' },
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
    })
    if (plan.staticConfig.onUnavailable === 'allow-if-unimplemented') {
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

/**
 * Packages whose code is the process's sandbox backend: the builtin that supplies the local probe
 * and the package that exports the selected sandbox provider. Their code cannot change live.
 */
export function sandboxBackendPackages(
  profile: Pick<ResolvedProfile, 'packages' | 'sandbox'>,
  modules: ReadonlyMap<string, PackageModule>,
): readonly string[] {
  const selected = sandboxProviderIdFrom(profile)
  return [...modules]
    .filter(
      ([id, mod]) =>
        mod.sandboxProvider?.id === selected ||
        (mod.sandboxWorkspaceProbe !== undefined &&
          profile.packages.some((pkg) => pkg.id === id && pkg.trust === 'builtin')),
    )
    .map(([id]) => id)
}

/** Derive one workspace's posture from the current provider and memory catalog. */
function workspaceSandboxPolicy(
  ctx: AssemblyContext,
  pkgs: PackageSet,
  proc: ProcessServices,
  preset: PresetDoc,
) {
  const { adapters } = proc
  const requestedSandbox = normalizeSandboxStaticConfig(preset)
  const implementation =
    !adapters.transport && sandboxProviderIdFrom(ctx.profile) === RELEASE_DEFAULTS.sandboxProvider
      ? localSandboxImplementation(ctx.profile, pkgs.modules, adapters.platform.os)
      : 'unknown'
  const unconfined =
    implementation === 'unimplemented' &&
    !requestedSandbox.required &&
    ((requestedSandbox.level === 'L1' && requestedSandbox.onUnavailable === 'allow-if-unimplemented') ||
      (requestedSandbox.level === 'L0' && requestedSandbox.onUnavailable === 'allow'))
  const memoryIsolation = memoryFileIsolation(
    ctx.live.pluginTree
      .get()
      .root.providers.catalog()
      .some((entry) => entry.kind === 'memory'),
    implementation,
    requestedSandbox,
  )
  // Preferred isolation still requests L1 so an available OS boundary denies the memory tree; only
  // required isolation refuses execution when that boundary is missing.
  const requiresFileIsolation = memoryIsolation === 'required'
  const sandboxConfig =
    memoryIsolation !== 'none'
      ? {
          ...requestedSandbox,
          level: 'L1' as const,
          onUnavailable:
            requestedSandbox.level === 'L1' ? requestedSandbox.onUnavailable : ('allow' as const),
        }
      : requestedSandbox
  return { implementation, unconfined, requiresFileIsolation, sandboxConfig }
}

export type WorkspaceRuntimeFactory = Readonly<{
  /** Compiled policies by workspace root identity; the Skill installer reads the one a session runs under. */
  workspacePlans: ReadonlyMap<string, Awaited<ReturnType<typeof compileWorkspacePolicy>>>
  /** Production per-binding constructor used when HostOptions does not supply a test override. */
  openWorkspaceRuntime(
    binding: WorkspaceBinding,
    preset?: PresetDoc,
    invocation?: import('@agnes/core').WorkspaceInvocationPort,
    ceiling?: import('@agnes/core').FsPolicy,
  ): Promise<SessionWorkspaceRuntime>
}>

/**
 * Step `seams`, second half: the sandbox readiness manager and the per-workspace runtime
 * constructor. The tree and the bound seams do not exist yet; the constructor reads them
 * through `ctx.live` when a session opens a workspace.
 */
export function createWorkspaceRuntimeFactory(
  ctx: AssemblyContext,
  pkgs: PackageSet,
  proc: ProcessServices,
  presets: PresetCatalog,
  seamContexts: SeamContexts,
  seams: SeamImplementations,
): WorkspaceRuntimeFactory {
  const { deps, dataDir } = ctx
  const { hotPolicy } = ctx.gates
  const { adapters, sandboxProviderSlot } = proc
  const workspacePlans = new Map<string, Awaited<ReturnType<typeof compileWorkspacePolicy>>>()
  const readinessManager = createReadinessManager(ctx, pkgs, proc, workspacePlans)
  const openWorkspaceRuntime = async (
    binding: WorkspaceBinding,
    preset: PresetDoc = presets.defaultPreset.doc,
    invocation?: import('@agnes/core').WorkspaceInvocationPort,
    ceiling?: import('@agnes/core').FsPolicy,
  ): Promise<SessionWorkspaceRuntime> => {
    const { implementation, unconfined, requiresFileIsolation, sandboxConfig } = workspaceSandboxPolicy(
      ctx,
      pkgs,
      proc,
      preset,
    )
    let savedPlan: Awaited<ReturnType<typeof compileWorkspacePolicy>> | undefined
    let fence: SessionWorkspaceFence | undefined
    let posture: Readonly<{ execBackend: SandboxExecBackend; enforcement: Enforcement }> | undefined
    return createSessionWorkspaceRuntime({
      binding,
      ...(invocation ? { invocation } : {}),
      verifySession: async (key) => {
        if (!savedPlan || !posture)
          throw new HostError('E_SANDBOX_WORKSPACE', 'execution policy is not ready')
        const [history] = await adapters.storage.scan(key, {
          type: ['session/start'],
          order: 'desc',
          limit: 1,
        })
        // A newly reserved child reads its parent's prefix before it writes its own session/start.
        // Use the storage-owned origin, not a key asserted in event data, to distinguish that prefix.
        const [origin] = history
          ? await adapters.storage.scanIntegrity(key, { fromSeq: history.seq, toSeq: history.seq, limit: 1 })
          : []
        const inheritedStart =
          origin?.event.id === history?.id && origin !== undefined && origin.sessionKey !== key
        const provider = sandboxProviderSlot.registry
          ?.catalog()
          .find((entry) => entry.id === sandboxProviderIdFrom(ctx.profile))
        if (!provider) throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox provider identity is missing')
        new SessionSandboxStore(deps.profileDir, deps.log).verify(
          key,
          {
            workspaceId: binding.workspaceId,
            workspaceRoot: savedPlan.policy.workspaceRoot,
            policyDigest: savedPlan.policy.digest,
            staticConfigHash: savedPlan.staticConfigHash,
            provider: provider.id,
            providerVersion: provider.version,
            target: adapters.transport ? 'remote' : adapters.platform.os,
            implementation,
            probeState:
              posture.execBackend === 'l1'
                ? 'ready'
                : sandboxConfig.level === 'L1' && implementation === 'implemented'
                  ? 'failed'
                  : 'unprobed',
            backend: posture.execBackend,
            enforcement: posture.enforcement,
          },
          history !== undefined && !inheritedStart,
        )
      },
      openWorkspace: adapters.openWorkspace,
      openFence: async (workspace) => {
        fence = await adapters.openFence(workspace)
        return fence
      },
      compilePolicy: async (openedFence: WorkspaceRuntimeFence) => {
        const sessionFence = openedFence as SessionWorkspaceFence
        if (!adapters.transport && adapters.platform.os === 'linux')
          await prepareSandboxWorkspaceAncestor(sessionFence.root)
        const compiled = await compileWorkspacePolicy({
          canonicalRoot: sessionFence.root,
          dataDir,
          homeDir: deps.homeDir ?? homedir(),
          protectedPaths: privateStateRoots({
            home: dirname(dirname(deps.profileDir)),
            dataDir,
            profileDir: deps.profileDir,
            ...(ctx.profile.adapters?.secrets.path ? { secretsDir: ctx.profile.adapters.secrets.path } : {}),
          }),
          semantics: sessionFence.semantics,
          ...(binding.extraRoots.length ? { extraRoots: binding.extraRoots } : {}),
          staticConfig: sandboxConfig,
          canonicalize: (path, options) => sessionFence.fs.canonicalize(path, options),
        })
        const plan = ceiling ? intersectWorkspacePlan(compiled, ceiling) : compiled
        const rootIdentity = plan.semantics.caseSensitive
          ? plan.policy.workspaceRoot
          : plan.policy.workspaceRoot.toLocaleLowerCase('en-US')
        savedPlan = plan
        workspacePlans.set(JSON.stringify([rootIdentity, plan.staticConfigHash]), plan)
        return plan
      },
      bindReadiness: ({ workspace, plan }) =>
        readinessManager.bind(
          {
            backendId: sandboxProviderIdFrom(ctx.profile),
            canonicalRoot: workspace.root,
            staticConfigHash: plan.staticConfigHash,
            caseSensitive: plan.semantics.caseSensitive,
          },
          (raw) => {
            const execBackend = raw.execBackend
            const enforcement = raw.enforcement
            if (!execBackend || !enforcement)
              throw new HostError('E_SANDBOX_WORKSPACE', 'cached sandbox posture is unavailable', {
                detail: { reason: 'workspace-posture-missing' },
              })
            posture = Object.freeze({
              execBackend,
              enforcement: {
                level: enforcement.level,
                scope: [...enforcement.scope],
              },
            })
            if (raw.name)
              adapters.reportSandboxBackend({
                name: raw.name,
                enforcement: posture.enforcement,
              })
            fence?.activateGate({
              backend: raw.execBackend,
              onUnavailable:
                raw.execBackend === 'remote'
                  ? 'deny'
                  : plan.staticConfig.onUnavailable === 'allow-if-unimplemented'
                    ? raw.execBackend === 'none' && unconfined
                      ? 'allow'
                      : 'deny'
                    : plan.staticConfig.onUnavailable,
              access: plan.staticConfig.access ?? 'workspace-write',
              requiredFileIsolation: requiresFileIsolation,
            })
          },
        ),
      fitSandbox: async (runtime) => {
        if (!fence || !posture)
          throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox posture was not activated', {
            detail: { reason: 'workspace-posture-inactive' },
          })
        const providerId = await bindStartupSandboxProvider(
          sandboxProviderSlot,
          ctx.profile,
          runtime.root,
          remoteSandboxModule(ctx.profile, pkgs.modules)?.provider.id,
        )
        const powerShell = adapters.powerShell
        const shellCommand = powerShell
          ? (command: string): string[] => powerShellCommand(powerShell, command)
          : undefined
        return seamContexts.staticSeams.sandbox.forWorkspace({
          root: runtime.root,
          ...(runtime.invocation ? { invocation: runtime.invocation } : {}),
          policy: runtime.policy,
          readiness: runtime.sandbox,
          shell: adapters.platform.shell(),
          ...(shellCommand ? { shellCommand } : {}),
          execBackend: posture.execBackend,
          enforcement: posture.enforcement,
          requiredFileIsolation: requiresFileIsolation,
          ...(providerId === RELEASE_DEFAULTS.sandboxProvider ? {} : { providerId }),
          exec: fence.exec,
          openProcess: fence.openProcess,
          binding: fence.binding,
        })
      },
      openHooks: async (runtime) => {
        const loader = new WorkspaceHookLoader(
          runtime.fs,
          () => commandHookInvocationSnapshot(hotPolicy).revision,
          (digest) =>
            ctx.profile.policy.workspacePackages !== 'deny' &&
            (isWorkspaceHooksTrusted(deps.profileDir, binding.canonicalRoot, digest) ||
              trustedHookCommands(
                ctx.profile.commandHooks,
                binding.canonicalRoot,
                adapters.platform.fs(),
              )?.allowsUnconfined('workspace', digest) === true),
        )
        return Object.freeze({ snapshot: () => loader.snapshot() })
      },
      openServices: (runtime) => openWorkspaceSeamContexts(seams, runtime),
      closeServices: (services) => (services as WorkspaceSeamContexts).close(),
    })
  }
  return { workspacePlans, openWorkspaceRuntime }
}
