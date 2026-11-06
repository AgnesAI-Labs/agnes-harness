// Host-side dispatch of Windows write-restricted commands. The Host decides the contract and
// acquires one lease per session here; the local provider can only redeem a lease registered here,
// and every call it runs is checked again against the same decision. The partial process policy is
// compiled only for the contract the Host decided, never by clearing a stronger request.
import type { FsPolicy, HostSpawnSandboxWorkspaceBackend } from '@agnes/core'
import {
  type SandboxEnforcement,
  type SandboxExecutionLease,
  type SandboxExecutionPolicy,
  sandboxUnavailable,
} from '@agnes/extension-api'
import type { WindowsObjectIdentity } from '@agnes/system-node/windows-acl'
import type { SandboxExecBinding } from '../adapters/exec.js'
import type { WindowsExecutionAuthority, WindowsExecutionLease, WindowsLeaseInput } from './authority.js'
import {
  isWindowsWriteBoundary,
  resolveWindowsExecution,
  WINDOWS_WRITE_BOUNDARY,
  type WindowsExecutionDecision,
  type WindowsExecutionInput,
} from './policy.js'

const CONTRACT = 'windows-write-restricted-v1'

/** What a Windows write-restricted command requires and reports: partial, exactly this contract. */
export const WINDOWS_ACL_ENFORCEMENT: SandboxEnforcement = Object.freeze({
  level: 'partial',
  scope: Object.freeze(['file'] as const),
  boundary: WINDOWS_WRITE_BOUNDARY,
})

const isEnforcement = (value: SandboxEnforcement | undefined): boolean =>
  value?.level === 'partial' &&
  value.scope.length === 1 &&
  value.scope[0] === 'file' &&
  isWindowsWriteBoundary(value.boundary)

/** Exact match of a Host-started offer; a near miss is a different boundary. */
export function sameHostSpawn(value: unknown, expected: HostSpawnSandboxWorkspaceBackend): boolean {
  if (typeof value !== 'object' || value === null) return false
  const offer = value as Record<string, unknown>
  return (
    Object.keys(offer).length === 4 &&
    offer.enforcementLocation === 'host-spawn' &&
    isWindowsWriteBoundary(offer.boundary) &&
    offer.owner === expected.owner &&
    offer.policyDigest === expected.policyDigest
  )
}

const sameLease = (held: SandboxExecutionLease, value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const ref = value as Partial<SandboxExecutionLease>
  return (
    ref.id === held.id &&
    ref.contract === held.contract &&
    ref.policyDigest === held.policyDigest &&
    ref.mode === held.mode &&
    ref.tempRoot === held.tempRoot &&
    ref.rootIdentity?.volumeId === held.rootIdentity.volumeId &&
    ref.rootIdentity?.fileId === held.rootIdentity.fileId
  )
}

/**
 * The process policy of the partial contract: reads cover what the account can read, the network
 * is open, and writes name only the workspace root and the lease's temp. The file tools keep their
 * own FsPolicy denies; they are not claimed here as a protection of scripts.
 */
export function windowsPartialPolicy(
  workspaceRoot: string,
  digest: string,
  lease: SandboxExecutionLease,
): SandboxExecutionPolicy {
  const writable =
    lease.mode === 'read-only'
      ? []
      : [workspaceRoot, ...(lease.tempRoot === undefined ? [] : [lease.tempRoot])]
  return Object.freeze({
    workspaceRoot,
    digest,
    fsRead: Object.freeze({ allow: Object.freeze(['/']), deny: Object.freeze([]) }),
    fsWrite: Object.freeze({ allow: Object.freeze(writable), deny: Object.freeze([]) }),
    network: Object.freeze({ mode: 'allow' as const, hosts: Object.freeze([]) }),
    requiredEnforcement: WINDOWS_ACL_ENFORCEMENT,
  })
}

export type WindowsAclExecutionOptions = Readonly<{
  authority: Pick<WindowsExecutionAuthority, 'acquire'>
  /** Cheap identity read of a workspace root; refuses links, drive roots and unsupported volumes. */
  rootIdentity(path: string): Promise<WindowsObjectIdentity>
  /** The Host's built-in provider id; only that provider runs the ACL path. */
  localProviderId: string
}>

type HostFacts = Omit<WindowsExecutionInput, 'localProviderId' | 'availableBoundary'>

/**
 * The trusted local facade of the Windows execution authority. It holds the leases the Host
 * acquired, by id; a lease identity it does not hold, or one that differs in any field, is refused.
 */
export class WindowsAclExecution {
  readonly #options: WindowsAclExecutionOptions
  readonly #leases = new Map<string, { ref: SandboxExecutionLease; lease: WindowsExecutionLease }>()

  constructor(options: WindowsAclExecutionOptions) {
    this.#options = options
  }

  get localProviderId(): string {
    return this.#options.localProviderId
  }

  /** The boundary this facade can apply; the decision never reads it from configuration. */
  get boundary(): typeof WINDOWS_WRITE_BOUNDARY {
    return WINDOWS_WRITE_BOUNDARY
  }

  decide(facts: HostFacts): WindowsExecutionDecision {
    return resolveWindowsExecution({
      ...facts,
      localProviderId: this.#options.localProviderId,
      availableBoundary: WINDOWS_WRITE_BOUNDARY,
    })
  }

  /** Probes the actual root, then offers the Host-started boundary for exactly this policy. */
  async offer(root: string, policyDigest: string): Promise<HostSpawnSandboxWorkspaceBackend> {
    await this.#options.rootIdentity(root)
    return Object.freeze({
      enforcementLocation: 'host-spawn',
      boundary: WINDOWS_WRITE_BOUNDARY,
      owner: this.#options.localProviderId,
      policyDigest,
    })
  }

  async acquire(input: WindowsLeaseInput): Promise<SandboxExecutionLease> {
    const lease = await this.#options.authority.acquire(input)
    const ref: SandboxExecutionLease = Object.freeze({
      id: lease.id,
      contract: CONTRACT,
      policyDigest: lease.policyDigest,
      rootIdentity: Object.freeze({
        volumeId: lease.rootIdentity.volumeId,
        fileId: lease.rootIdentity.fileId,
      }),
      mode: lease.mode,
      ...(lease.tempRoot === undefined ? {} : { tempRoot: lease.tempRoot }),
    })
    this.#leases.set(lease.id, { ref, lease })
    return ref
  }

  /** The Host-held lease this identity names; anything else is refused before a permit exists. */
  lease(ref: unknown): WindowsExecutionLease {
    const id = typeof ref === 'object' && ref !== null ? (ref as { id?: unknown }).id : undefined
    const held = typeof id === 'string' ? this.#leases.get(id) : undefined
    if (!held || !sameLease(held.ref, ref))
      throw sandboxUnavailable('the Windows execution lease is not one this Host holds')
    return held.lease
  }

  /** Closes a lease after its provider stopped its processes; a refused close keeps it held. */
  async release(ref: SandboxExecutionLease): Promise<void> {
    const lease = this.lease(ref)
    await lease.close()
    this.#leases.delete(ref.id)
  }

  /**
   * Re-decides one call from its own policy with the real decider. A call that requires full
   * isolation, read denies or a closed network, or names another mode or more writable roots than
   * its lease, is refused before any permit is issued.
   */
  check(
    request: Readonly<{ policy?: SandboxExecutionPolicy; enforcement?: SandboxEnforcement }>,
    lease: SandboxExecutionLease,
  ): void {
    const policy = request.policy
    if (!policy || !isEnforcement(request.enforcement) || !isEnforcement(policy.requiredEnforcement))
      throw sandboxUnavailable('the call does not carry the Windows write-restricted contract')
    const network = policy.network
    const decision = this.decide({
      access: lease.mode,
      windowsMode: 'write-restricted',
      required: false,
      extraReadIsolation: false,
      customFsDeny: policy.fsRead.deny.length > 0 || policy.fsWrite.deny.length > 0,
      networkMode: network.mode === 'allow' && network.hosts.length > 0 ? 'hosts' : network.mode,
      providerId: this.#options.localProviderId,
    })
    if (decision.kind !== CONTRACT || decision.mode !== lease.mode)
      throw sandboxUnavailable(
        `the Windows write restriction cannot run this call: ${decision.kind === 'refusal' ? decision.reason : 'mode'}`,
      )
    const writable = new Set(windowsPartialPolicy(policy.workspaceRoot, policy.digest, lease).fsWrite.allow)
    if (policy.digest !== lease.policyDigest || policy.fsWrite.allow.some((path) => !writable.has(path)))
      throw sandboxUnavailable('the call names writable roots outside its Windows execution lease')
  }
}

/** Host-owned gate state of a session bound to the Windows write restriction. */
export type WindowsAclGate = Readonly<{
  hostSpawn: HostSpawnSandboxWorkspaceBackend
  /** The session's lease, acquired on first use; a failure is a refusal, retried on the next call. */
  lease(): Promise<SandboxExecutionLease>
}>

/**
 * The gate half for the `windows-acl` backend: the request must carry the exact offer this session
 * was bound with and the exact partial enforcement; the lease and the process policy come from the
 * Host, never from the request.
 */
export async function windowsAclBinding(
  request: SandboxExecBinding,
  gate: WindowsAclGate,
  policy: FsPolicy,
  bound: string,
): Promise<SandboxExecBinding> {
  if (
    request.provider !== undefined ||
    gate.hostSpawn.policyDigest !== bound ||
    !sameHostSpawn(request.hostSpawn, gate.hostSpawn) ||
    !isEnforcement(request.enforcement)
  )
    throw sandboxUnavailable('the request does not carry this workspace Windows write restriction')
  const lease = await gate.lease()
  if (lease.contract !== CONTRACT || lease.policyDigest !== bound)
    throw sandboxUnavailable('the Windows execution lease was issued for another policy')
  return Object.freeze({
    policyDigest: bound,
    backend: 'windows-acl',
    hostSpawn: gate.hostSpawn,
    policy: windowsPartialPolicy(policy.workspaceRoot, policy.digest, lease),
    enforcement: WINDOWS_ACL_ENFORCEMENT,
    lease,
  })
}
