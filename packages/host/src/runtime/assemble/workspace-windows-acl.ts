import type { Enforcement, HostSpawnSandboxWorkspaceBackend, SandboxExecBackend } from '@agnes/core'
import type { SandboxExecutionLease } from '@agnes/extension-api'
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
 */
function windowsFacts(
  config: SandboxStaticConfig,
  extraReadIsolation: boolean,
  providerId: string,
): Omit<WindowsExecutionInput, 'localProviderId' | 'availableBoundary'> {
  return {
    access: config.access ?? 'workspace-write',
    windowsMode: config.windowsMode ?? 'require-full',
    required: config.required,
    extraReadIsolation,
    customFsDeny: config.denyPaths.length > 0,
    networkMode: config.loopbackServe ? 'loopback-serve' : config.networkAllow.length > 0 ? 'hosts' : 'allow',
    providerId,
  }
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
  providerId: string
  localProviderId: string
  root: string
  policyDigest: string
}): Promise<HostSpawnSandboxWorkspaceBackend | undefined> {
  if (input.os !== 'win32' || input.staticConfig.windowsMode !== 'write-restricted') return undefined
  const facts = windowsFacts(input.staticConfig, false, input.providerId)
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

/**
 * One session's gate under the Windows write restriction. The decision is taken again with this
 * session's own facts (an explicit private file isolation request refuses it), and the lease is
 * acquired on the first command, then reused; a failed acquisition is retried by the next command.
 */
export function windowsSessionGate(input: {
  execution: WindowsAclExecution | undefined
  hostSpawn: HostSpawnSandboxWorkspaceBackend | undefined
  staticConfig: SandboxStaticConfig
  requiresFileIsolation: boolean
  providerId: string
  sessionExecutionId: string
  root: string
  policyDigest: string
}): WindowsAclGate {
  const { execution, hostSpawn } = input
  if (!execution || !hostSpawn || hostSpawn.policyDigest !== input.policyDigest) throw refusal('unavailable')
  const decision = execution.decide(
    windowsFacts(input.staticConfig, input.requiresFileIsolation, input.providerId),
  )
  if (decision.kind !== 'windows-write-restricted-v1')
    throw refusal(decision.kind === 'refusal' ? decision.reason : 'unconfined')
  let pending: Promise<SandboxExecutionLease> | undefined
  return Object.freeze({
    hostSpawn,
    lease: () => {
      if (!pending) {
        const attempt = execution.acquire({
          sessionExecutionId: input.sessionExecutionId,
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
  })
}

/** What one session's workspace was fitted with, copied from the cached probe. */
export type WorkspacePosture = Readonly<{
  execBackend: SandboxExecBackend
  enforcement: Enforcement
  hostSpawn?: HostSpawnSandboxWorkspaceBackend
  /** The session's Windows gate; created once per session runtime so its lease is reused. */
  windowsAcl?: WindowsAclGate
}>

export function workspacePosture(
  raw: Readonly<{
    execBackend?: SandboxExecBackend
    enforcement?: Readonly<{ level: Enforcement['level']; scope: readonly Enforcement['scope'][number][] }> &
      Pick<Enforcement, 'boundary'>
    hostSpawn?: HostSpawnSandboxWorkspaceBackend
  }>,
  previous: WorkspacePosture | undefined,
  windowsGate: () => WindowsAclGate,
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
