import type { Enforcement, HostSpawnSandboxWorkspaceBackend, SandboxExecBackend } from '@agnes/core'
import type { SandboxExecutionLease, WindowsWriteBoundary } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import type { SandboxStaticConfig } from '@agnes/host-common/workspace-policy'
import {
  sameHostSpawn,
  type WindowsAclExecution,
  type WindowsAclGate,
} from '@agnes/host-infrastructure/windows-acl/execution'
import {
  isWindowsWriteBoundary,
  resolveWindowsExecution,
  WINDOWS_WRITE_BOUNDARY,
  type WindowsExecutionInput,
} from '@agnes/host-infrastructure/windows-acl/policy'

/**
 * The target a static sandbox config is normalized for. Only local execution on Windows reads the
 * Windows settings; every other Host keeps its existing config and digest.
 */
export function sandboxConfigTarget(adapters: { platform: { os: string }; transport?: unknown }): {
  target?: 'win32'
} {
  return adapters.platform.os === 'win32' && adapters.transport === undefined ? { target: 'win32' } : {}
}

/**
 * What the Windows decision reads from one sandbox config. The closed network L1 implies by default
 * is not a Windows requirement; an allowlist or loopback serving is, and an explicit read deny is.
 * `customFsDeny` comes from the plan (`planExplicitDeny`): a plan narrowed by a delegating session
 * lists the default protected paths among its deny paths, and those are not an explicit deny.
 */
function windowsFacts(
  config: SandboxStaticConfig,
  extraReadIsolation: boolean,
  providerId: string,
  customFsDeny: boolean,
): Omit<WindowsExecutionInput, 'localProviderId' | 'availableBoundary'> {
  return {
    access: config.access ?? 'workspace-write',
    windowsMode: config.windowsMode ?? 'require-full',
    required: config.required,
    extraReadIsolation,
    customFsDeny,
    networkMode: config.loopbackServe ? 'loopback-serve' : config.networkAllow.length > 0 ? 'hosts' : 'allow',
    providerId,
  }
}

/**
 * The contract a policy describes on a local Windows Host: the partial boundary where the trusted
 * local provider would run it, otherwise none (explicit full access, another provider or a policy
 * the partial contract refuses keep their own description). It describes; it admits nothing, and
 * a session's actual boundary still comes from its own probe.
 */
export function windowsPolicyBoundary(
  config: SandboxStaticConfig,
  providerId: string,
  localProviderId: string,
): WindowsWriteBoundary | undefined {
  if (config.windowsMode !== 'write-restricted') return undefined
  const decision = resolveWindowsExecution({
    ...windowsFacts(config, false, providerId, config.denyPaths.length > 0),
    localProviderId,
    availableBoundary: WINDOWS_WRITE_BOUNDARY,
  })
  return decision.kind === 'windows-write-restricted-v1' ? decision.boundary : undefined
}

const refusal = (reason: string): HostError =>
  new HostError('E_SANDBOX_WORKSPACE', `the Windows write restriction cannot run this policy: ${reason}`, {
    detail: { reason: `windows-acl-${reason}` },
  })

/**
 * The Host-started offer for one workspace policy, or undefined where the existing path applies:
 * another platform, no Windows opt-in, or the explicit full-access contract. A write-restricted
 * policy the partial contract cannot satisfy is refused here, before any provider is asked.
 */
export async function windowsHostSpawnOffer(input: {
  execution: WindowsAclExecution | undefined
  os: string
  staticConfig: SandboxStaticConfig
  /** An explicit deny beyond the default protected paths (`planExplicitDeny`). */
  customFsDeny: boolean
  providerId: string
  localProviderId: string
  root: string
  policyDigest: string
}): Promise<HostSpawnSandboxWorkspaceBackend | undefined> {
  if (input.os !== 'win32' || input.staticConfig.windowsMode !== 'write-restricted') return undefined
  const facts = windowsFacts(input.staticConfig, false, input.providerId, input.customFsDeny)
  const decision = input.execution
    ? input.execution.decide(facts)
    : resolveWindowsExecution({ ...facts, localProviderId: input.localProviderId })
  if (decision.kind === 'unconfined') return undefined
  if (decision.kind === 'refusal' || !input.execution)
    throw refusal(decision.kind === 'refusal' ? decision.reason : 'unavailable')
  return input.execution.offer(input.root, input.policyDigest)
}

/** The probe must return exactly what was offered; Base never selects this backend unasked. */
export function assertHostSpawnProbe(
  raw: Readonly<{ execBackend?: string; hostSpawn?: unknown; enforcement?: Enforcement }>,
  offer: HostSpawnSandboxWorkspaceBackend | undefined,
): void {
  const windows = raw.execBackend === 'windows-acl' || raw.hostSpawn !== undefined
  if (!offer && !windows) return
  if (
    !offer ||
    raw.execBackend !== 'windows-acl' ||
    !sameHostSpawn(raw.hostSpawn, offer) ||
    raw.enforcement?.level !== 'partial' ||
    !isWindowsWriteBoundary(raw.enforcement.boundary)
  )
    throw new HostError(
      'E_SANDBOX_WORKSPACE',
      'the sandbox probe did not confirm the Host-started boundary',
      {
        detail: { reason: 'windows-acl-probe-mismatch' },
      },
    )
}

/** A session's Windows gate with the Host-side half of its lease lifetime. */
export type WindowsSessionGate = WindowsAclGate &
  Readonly<{
    /**
     * Binds the execution generation the session's record was verified and saved with. No lease is
     * taken before; a running lease is never moved to another generation.
     */
    bind(generationId: string): void
    /**
     * Releases the session's lease when its runtime is released: the provider instance created for
     * the lease stops its own processes and then closes it; without one, the lease closes here.
     */
    close(): Promise<void>
  }>

/**
 * One session's gate under the Windows write restriction. The decision is taken again with this
 * session's own facts (an explicit private file isolation request refuses it), and the lease is
 * acquired on the first command, then reused; a failed acquisition is retried by the next command.
 * Finishing a reply or a command never releases it; only the runtime's own release does.
 */
export function windowsSessionGate(input: {
  execution: WindowsAclExecution | undefined
  hostSpawn: HostSpawnSandboxWorkspaceBackend | undefined
  staticConfig: SandboxStaticConfig
  /** An explicit deny beyond the default protected paths (`planExplicitDeny`). */
  customFsDeny: boolean
  requiresFileIsolation: boolean
  providerId: string
  root: string
  policyDigest: string
  /** Disposes the provider instance created for a lease; false when there is none. */
  releaseInstance?(lease: SandboxExecutionLease): Promise<boolean>
}): WindowsSessionGate {
  const { execution, hostSpawn } = input
  if (!execution || !hostSpawn || hostSpawn.policyDigest !== input.policyDigest) throw refusal('unavailable')
  const decision = execution.decide(
    windowsFacts(input.staticConfig, input.requiresFileIsolation, input.providerId, input.customFsDeny),
  )
  if (decision.kind !== 'windows-write-restricted-v1')
    throw refusal(decision.kind === 'refusal' ? decision.reason : 'unconfined')
  let pending: Promise<SandboxExecutionLease> | undefined
  let generation: string | undefined
  let closed = false
  return Object.freeze({
    hostSpawn,
    bind: (generationId: string) => {
      if (generation !== undefined && generation !== generationId) throw refusal('generation-changed')
      generation = generationId
    },
    lease: () => {
      if (closed) return Promise.reject(refusal('released'))
      if (generation === undefined) return Promise.reject(refusal('unverified'))
      if (!pending) {
        const attempt = execution.acquire({
          sessionExecutionId: generation,
          canonicalRoot: input.root,
          policyDigest: input.policyDigest,
          mode: decision.mode,
        })
        pending = attempt
        attempt.catch(() => {
          if (pending === attempt) pending = undefined
        })
      }
      return pending
    },
    close: async () => {
      closed = true
      const attempt = pending
      pending = undefined
      if (!attempt) return
      let lease: SandboxExecutionLease
      try {
        lease = await attempt
      } catch {
        return
      }
      if (await input.releaseInstance?.(lease)) return
      await execution.release(lease)
    },
  })
}

/** What one session's workspace was fitted with, copied from the cached probe. */
export type WorkspacePosture = Readonly<{
  execBackend: SandboxExecBackend
  enforcement: Enforcement
  hostSpawn?: HostSpawnSandboxWorkspaceBackend
  /** The session's Windows gate; created once per session runtime so its lease is reused. */
  windowsAcl?: WindowsSessionGate
}>

export function workspacePosture(
  raw: Readonly<{
    execBackend?: SandboxExecBackend
    enforcement?: Readonly<{ level: Enforcement['level']; scope: readonly Enforcement['scope'][number][] }> &
      Pick<Enforcement, 'boundary'>
    hostSpawn?: HostSpawnSandboxWorkspaceBackend
  }>,
  previous: WorkspacePosture | undefined,
  windowsGate: () => WindowsSessionGate,
): WorkspacePosture {
  const { execBackend, enforcement } = raw
  if (!execBackend || !enforcement)
    throw new HostError('E_SANDBOX_WORKSPACE', 'cached sandbox posture is unavailable', {
      detail: { reason: 'workspace-posture-missing' },
    })
  return Object.freeze({
    execBackend,
    enforcement: {
      level: enforcement.level,
      scope: [...enforcement.scope],
      ...(enforcement.boundary ? { boundary: { ...enforcement.boundary } } : {}),
    },
    ...(raw.hostSpawn ? { hostSpawn: raw.hostSpawn } : {}),
    ...(execBackend === 'windows-acl' ? { windowsAcl: previous?.windowsAcl ?? windowsGate() } : {}),
  })
}
