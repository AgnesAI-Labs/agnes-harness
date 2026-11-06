import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { SeamImplementations } from '@agnes/core'
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
  planExplicitDeny,
} from '@agnes/host-common/workspace-policy'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { powerShellCommand } from '@agnes/host-infrastructure/adapters/powershell-command'
import type { SessionWorkspaceFence } from '@agnes/host-infrastructure/adapters/session-workspace'
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
import { isWorkspaceHooksTrusted, RELEASE_DEFAULTS } from '@agnes/package-manager'
import { remoteSandboxModule } from '../adapters/index.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { PresetCatalog } from './presets.js'
import type { ProcessServices } from './process-services.js'
import type { SeamContexts } from './seam-contexts.js'
import { trustedHookCommands } from './trusted-hooks.js'
import {
  createReadinessManager,
  localSandboxImplementation,
  requestedSandboxConfig,
} from './workspace-readiness.js'
import {
  officialPresetNames,
  type PresetOrigin,
  sessionRecordVerifier,
  windowsModeSource,
} from './workspace-session-record.js'
import {
  sandboxConfigTarget,
  type WorkspacePosture,
  windowsSessionGate,
  workspacePosture,
} from './workspace-windows-acl.js'

export {
  degradeLoopbackServe,
  localSandboxImplementation,
  localSandboxProbe,
  loopbackServeSupported,
} from './workspace-readiness.js'

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
  const localProvider = sandboxProviderIdFrom(ctx.profile) === RELEASE_DEFAULTS.sandboxProvider
  const requestedSandbox = requestedSandboxConfig(preset, adapters, localProvider)
  const implementation =
    !adapters.transport && localProvider
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
    origin?: PresetOrigin,
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
  const official = officialPresetNames(ctx.profile, pkgs.modules)
  const windowsHost = sandboxConfigTarget(adapters).target === 'win32'
  const openWorkspaceRuntime = async (
    binding: WorkspaceBinding,
    preset: PresetDoc = presets.defaultPreset.doc,
    invocation?: import('@agnes/core').WorkspaceInvocationPort,
    ceiling?: import('@agnes/core').FsPolicy,
    origin: PresetOrigin | undefined = preset === presets.defaultPreset.doc
      ? presets.defaultPreset
      : undefined,
  ): Promise<SessionWorkspaceRuntime> => {
    const { implementation, unconfined, requiresFileIsolation, sandboxConfig } = workspaceSandboxPolicy(
      ctx,
      pkgs,
      proc,
      preset,
    )
    let savedPlan: Awaited<ReturnType<typeof compileWorkspacePolicy>> | undefined
    let fence: SessionWorkspaceFence | undefined
    let posture: WorkspacePosture | undefined
    return createSessionWorkspaceRuntime({
      binding,
      allowsUnconfined: unconfined && !requiresFileIsolation,
      ...(invocation ? { invocation } : {}),
      verifySession: sessionRecordVerifier({
        profileDir: deps.profileDir,
        ...(deps.log ? { log: deps.log } : {}),
        proc,
        providerId: sandboxProviderIdFrom(ctx.profile),
        ownerKey: binding.sessionKey,
        workspaceId: binding.workspaceId,
        implementation,
        requestedLevel: sandboxConfig.level,
        ...(windowsHost
          ? {
              windows: {
                ...(origin ? { origin } : {}),
                windowsModeSource: windowsModeSource(origin, presets.presets, official),
              },
            }
          : {}),
        state: () => ({ ...(savedPlan ? { plan: savedPlan } : {}), ...(posture ? { posture } : {}) }),
      }),
      openWorkspace: async (workspaceBinding) => {
        // The Linux mount anchor exists before the workspace measures its case semantics. The probe
        // needs an entry to respell: creating `.agh` later would turn a fresh, empty workspace from
        // case-insensitive to case-sensitive between two opens and change its policy digest.
        if (!adapters.transport && adapters.platform.os === 'linux')
          await prepareSandboxWorkspaceAncestor(workspaceBinding.canonicalRoot)
        return adapters.openWorkspace(workspaceBinding)
      },
      openFence: async (workspace) => {
        fence = await adapters.openFence(workspace)
        return fence
      },
      compilePolicy: async (openedFence: WorkspaceRuntimeFence) => {
        const sessionFence = openedFence as SessionWorkspaceFence
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
            posture = workspacePosture(raw, posture, () =>
              windowsSessionGate({
                execution: proc.windowsAcl,
                hostSpawn: raw.hostSpawn,
                staticConfig: plan.staticConfig,
                customFsDeny: planExplicitDeny(plan),
                requiresFileIsolation,
                providerId: sandboxProviderIdFrom(ctx.profile),
                root: plan.policy.workspaceRoot,
                policyDigest: plan.policy.digest,
                releaseInstance: async (lease) =>
                  (await sandboxProviderSlot.registry?.releaseLease(lease.id)) ?? false,
              }),
            )
            if (raw.name)
              adapters.reportSandboxBackend({
                name: raw.name,
                enforcement: posture.enforcement,
              })
            fence?.activateGate({
              backend: posture.execBackend,
              onUnavailable:
                posture.execBackend === 'remote'
                  ? 'deny'
                  : plan.staticConfig.onUnavailable === 'allow-if-unimplemented'
                    ? posture.execBackend === 'none' && unconfined
                      ? 'allow'
                      : 'deny'
                    : plan.staticConfig.onUnavailable,
              access: plan.staticConfig.access ?? 'workspace-write',
              requiredFileIsolation: requiresFileIsolation,
              ...(posture.windowsAcl ? { windowsAcl: posture.windowsAcl } : {}),
            })
          },
        ),
      closeSandbox: () => posture?.windowsAcl?.close(),
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
          ...(posture.hostSpawn ? { hostSpawn: posture.hostSpawn } : {}),
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
