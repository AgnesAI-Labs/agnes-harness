import type { Logger } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import { isPermission, overlayName, type Permission } from '@agnes/host-common/presets/permission'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import {
  type SandboxStaticConfig,
  sandboxStaticConfigHash,
  type WorkspacePolicyPlan,
} from '@agnes/host-common/workspace-policy'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { type SandboxExecutionRecord, SessionSandboxStore } from '@agnes/host-providers/profile/sandbox-state'
import type {
  SessionExecutionGeneration,
  WindowsPermissionIntent,
} from '@agnes/host-providers/profile/session-sandbox-windows'
import type { WindowsObjectIdentity } from '@agnes/system-node/windows-acl'
import type { ProcessServices } from './process-services.js'
import type { WorkspacePosture } from './workspace-windows-acl.js'

/** Where a session's preset came from: its recipe chain and the permission overlay merged after it. */
export type PresetOrigin = Readonly<{ chain: readonly string[]; permission?: Permission }>

/**
 * Preset documents this Host trusts as shipped: provided by a builtin package and not changed by a
 * profile bundle. Only these can prove the official intent of a session saved before a setting existed.
 */
export function officialPresetNames(
  profile: Readonly<{
    packages: readonly Readonly<{ id: string; trust: string }>[]
    bundlePresets?: Readonly<Record<string, unknown>>
  }>,
  modules: ReadonlyMap<string, PackageModule>,
): (name: string) => boolean {
  const builtin = new Set(profile.packages.filter((pkg) => pkg.trust === 'builtin').map((pkg) => pkg.id))
  const names = new Set<string>()
  for (const [id, mod] of modules)
    if (builtin.has(id)) for (const name of Object.keys(mod.presets ?? {})) names.add(name)
  for (const name of Object.keys(profile.bundlePresets ?? {})) names.delete(name)
  return (name) => names.has(name)
}

const windowsModeOf = (doc: PresetDoc | undefined): unknown =>
  (doc?.sandbox as { windows_mode?: unknown } | undefined)?.windows_mode

/** Who wrote `sandbox.windows_mode` into a session's preset; an unknown origin proves nothing. */
export function windowsModeSource(
  origin: PresetOrigin | undefined,
  presets: Readonly<Record<string, PresetDoc>>,
  official: (name: string) => boolean,
): WindowsPermissionIntent['windowsModeSource'] {
  if (!origin) return 'custom'
  const names = [...origin.chain, ...(origin.permission ? [overlayName(origin.permission)] : [])]
  const writers = names.filter((name) => windowsModeOf(presets[name]) !== undefined)
  if (writers.length === 0) return 'absent'
  return writers.every(official) ? 'official' : 'custom'
}

export function windowsPermissionIntent(
  config: SandboxStaticConfig,
  origin: PresetOrigin | undefined,
  source: WindowsPermissionIntent['windowsModeSource'],
): WindowsPermissionIntent {
  return {
    ...(origin?.permission ? { permission: origin.permission } : {}),
    access: config.access ?? 'workspace-write',
    windowsMode: config.windowsMode ?? 'require-full',
    windowsModeSource: source,
    required: config.required,
    onUnavailable: config.onUnavailable,
    customFsDeny: config.denyPaths.length > 0,
    networkMode: config.loopbackServe ? 'loopback-serve' : config.networkAllow.length > 0 ? 'hosts' : 'allow',
  }
}

/** The static config hash a Host without Windows settings computed, which version 1 records hold. */
export function legacyStaticConfigHash(config: SandboxStaticConfig): string {
  const { windowsMode: _windows, ...legacy } = config
  return sandboxStaticConfigHash(legacy)
}

/**
 * Verifies and saves one session's execution record. Off Windows it is the version 1 record and its
 * strict comparison; a Windows session gets version 2 and the generation its commands run under.
 */
export function verifySessionRecord(input: {
  store: Pick<SessionSandboxStore, 'verify' | 'verifyWindowsExecution'>
  key: string
  execution: SandboxExecutionRecord
  hasHistory: boolean
  windows?: Readonly<{
    staticConfig: SandboxStaticConfig
    origin?: PresetOrigin
    windowsModeSource: WindowsPermissionIntent['windowsModeSource']
    recordedPermission?: Permission
    rootIdentity?: WindowsObjectIdentity
  }>
}): SessionExecutionGeneration | undefined {
  const { windows } = input
  if (!windows) {
    input.store.verify(input.key, input.execution, input.hasHistory)
    return undefined
  }
  return input.store.verifyWindowsExecution(
    input.key,
    {
      currentExecution: input.execution,
      permissionEvidence: {
        intent: windowsPermissionIntent(windows.staticConfig, windows.origin, windows.windowsModeSource),
        ...(windows.recordedPermission ? { recordedPermission: windows.recordedPermission } : {}),
        legacyStaticConfigHash: legacyStaticConfigHash(windows.staticConfig),
      },
      ...(windows.rootIdentity ? { rootIdentity: windows.rootIdentity } : {}),
    },
    input.hasHistory,
  )
}

/**
 * The `verifySession` of one workspace runtime: reads the session's own history facts and saves its
 * execution record before the session opens. On Windows the generation it returns is bound to the
 * session's gate, so no command of the runtime's own session can take a lease before the record is
 * durable.
 */
export function sessionRecordVerifier(input: {
  profileDir: string
  log?: Pick<Logger, 'info'>
  proc: Pick<ProcessServices, 'adapters' | 'sandboxProviderSlot' | 'windowsAcl'>
  providerId: string
  ownerKey: string
  workspaceId: string
  implementation: SandboxExecutionRecord['implementation']
  requestedLevel: SandboxStaticConfig['level']
  /** Present on a local Windows Host: the preset's origin and who wrote its Windows setting. */
  windows?: Readonly<{
    origin?: PresetOrigin
    windowsModeSource: WindowsPermissionIntent['windowsModeSource']
  }>
  state(): Readonly<{ plan?: WorkspacePolicyPlan; posture?: WorkspacePosture }>
}): (key: string) => Promise<void> {
  const { adapters, sandboxProviderSlot } = input.proc
  return async (key) => {
    const { plan, posture } = input.state()
    if (!plan || !posture) throw new HostError('E_SANDBOX_WORKSPACE', 'execution policy is not ready')
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
    const provider = sandboxProviderSlot.registry?.catalog().find((entry) => entry.id === input.providerId)
    if (!provider) throw new HostError('E_SANDBOX_WORKSPACE', 'sandbox provider identity is missing')
    const execution: SandboxExecutionRecord = {
      workspaceId: input.workspaceId,
      workspaceRoot: plan.policy.workspaceRoot,
      policyDigest: plan.policy.digest,
      staticConfigHash: plan.staticConfigHash,
      provider: provider.id,
      providerVersion: provider.version,
      target: adapters.transport ? 'remote' : adapters.platform.os,
      implementation: input.implementation,
      probeState:
        posture.execBackend === 'l1' || posture.execBackend === 'windows-acl'
          ? 'ready'
          : input.requestedLevel === 'L1' && input.implementation === 'implemented'
            ? 'failed'
            : 'unprobed',
      backend: posture.execBackend,
      enforcement: posture.enforcement,
    }
    const recorded = (history?.data as { permission?: unknown } | null | undefined)?.permission
    const rootIdentity =
      input.windows && posture.execBackend === 'windows-acl'
        ? await input.proc.windowsAcl?.rootIdentity(plan.policy.workspaceRoot)
        : undefined
    const generation = verifySessionRecord({
      store: new SessionSandboxStore(input.profileDir, input.log),
      key,
      execution,
      hasHistory: history !== undefined && !inheritedStart,
      ...(input.windows
        ? {
            windows: {
              staticConfig: plan.staticConfig,
              ...(input.windows.origin ? { origin: input.windows.origin } : {}),
              windowsModeSource: input.windows.windowsModeSource,
              ...(isPermission(recorded) ? { recordedPermission: recorded } : {}),
              ...(rootIdentity ? { rootIdentity } : {}),
            },
          }
        : {}),
    })
    // A child sharing this runtime runs under the owner's lease and generation.
    if (generation && key === input.ownerKey) posture.windowsAcl?.bind(generation.generationId)
  }
}
