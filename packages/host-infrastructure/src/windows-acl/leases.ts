// Execution leases: the per-session resources behind a Windows write-restricted command. Each lease
// owns a random directory under one fixed Host-private temp root, a launch permit that only this
// module can mint, and the exit of every process it launched. Nothing here guesses by process ID
// or directory age: a lease's resources go only after its own processes are known to have exited,
// and another Host's leftovers only once that Host is proven gone.
import { randomBytes } from 'node:crypto'
import type { WindowsObjectIdentity } from '@agnes/system-node/windows-acl'
import type { ProcessIdentity } from '../adapters/process-identity.js'
import { aclError, type WindowsLeaseOwner, type WindowsLeaseRecord } from './journal.js'

/** Path rules of the platform the authority runs on. Windows compares paths case-insensitively. */
export type WindowsAclPaths = Readonly<{
  join(...parts: string[]): string
  relative(from: string, to: string): string
  isAbsolute(path: string): boolean
  dirname(path: string): string
  basename(path: string): string
  caseInsensitive: boolean
}>

/** True when one path is the other or lies inside it, in either direction. */
export function pathsOverlap(paths: WindowsAclPaths, a: string, b: string): boolean {
  const fold = (path: string) => (paths.caseInsensitive ? path.toLowerCase() : path)
  const inside = (parent: string, child: string) => {
    const rest = paths.relative(fold(parent), fold(child))
    return rest === '' || (!rest.startsWith('..') && !paths.isAbsolute(rest))
  }
  return inside(a, b) || inside(b, a)
}

export function samePath(paths: WindowsAclPaths, a: string, b: string): boolean {
  return paths.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Refuses a workspace that contains, or lies inside, any directory the Host keeps for itself: the
 * temp root (a grant would flow into every lease's temp), the ACL state root, or a private data root.
 */
export function assertWorkspaceDisjoint(
  paths: WindowsAclPaths,
  workspace: string,
  reserved: readonly Readonly<{ path: string; role: string }>[],
): void {
  for (const { path, role } of reserved)
    if (pathsOverlap(paths, workspace, path))
      throw aclError('E_ACL_ROOT_OVERLAP', `The workspace ${workspace} overlaps the Host ${role} ${path}`)
}

/** Refuses a workspace that is, or contains, any of `roots`; lying inside one is allowed. */
export function assertWorkspaceExcludes(
  paths: WindowsAclPaths,
  workspace: string,
  roots: readonly Readonly<{ path: string; role: string }>[],
  next?: string,
): void {
  const fold = (path: string) => (paths.caseInsensitive ? path.toLowerCase() : path)
  for (const { path, role } of roots) {
    const rest = paths.relative(fold(workspace), fold(path))
    if (rest === '' || (rest.split(/[\\/]/)[0] !== '..' && !paths.isAbsolute(rest)))
      throw aclError(
        'E_ACL_ROOT_OVERLAP',
        `The workspace ${workspace} contains the Host ${role} ${path}${next ? `; ${next}` : ''}`,
      )
  }
}

const TEMP_NAME = /^lease-[0-9a-f]{32}$/

/** A fresh, unguessable directory name for one lease; never derived from the session or reused. */
export function leaseTempName(): string {
  return `lease-${randomBytes(16).toString('hex')}`
}

/** Only a lease directory directly under the temp root is ever removed. */
export function isLeaseTemp(paths: WindowsAclPaths, tempRoot: string, path: string): boolean {
  return samePath(paths, paths.dirname(path), tempRoot) && TEMP_NAME.test(paths.basename(path))
}

/** A fresh capability SID (S-1-4-...) with 128 random bits, one per grant generation. */
export function freshWriteSid(): string {
  const bytes = randomBytes(16)
  return `S-1-4-${[0, 4, 8, 12].map((offset) => bytes.readUInt32BE(offset)).join('-')}`
}

export type LeaseUsage =
  | Readonly<{ kind: 'none'; stale: readonly WindowsLeaseRecord[] }>
  | Readonly<{ kind: 'active' | 'unknown'; lease: string; reason: string }>

/**
 * Proves whether any Host still uses a grant. A lease of this process counts while it is open here;
 * another process's lease counts while that process runs or its state cannot be determined. A lease
 * whose owner is proven gone is stale. A damaged lease record makes every grant's usage unknown.
 */
export async function grantUsage(
  grant: Readonly<{ grantId: string; lease?: string }>,
  leases: readonly WindowsLeaseRecord[],
  damaged: number,
  self: WindowsLeaseOwner,
  ownOpen: ReadonlySet<string>,
  processIdentity: (pid: number) => Promise<ProcessIdentity>,
): Promise<LeaseUsage> {
  if (damaged > 0) return { kind: 'unknown', lease: '', reason: 'a lease record is damaged' }
  const stale: WindowsLeaseRecord[] = []
  for (const lease of leases) {
    const uses =
      lease.workspaceGrantId === grant.grantId ||
      lease.tempGrantId === grant.grantId ||
      lease.leaseId === grant.lease
    if (!uses) continue
    const state = await ownerState(lease.owner, self, ownOpen.has(lease.leaseId), processIdentity)
    if (state === 'gone') stale.push(lease)
    else
      return {
        kind: state,
        lease: lease.leaseId,
        reason:
          state === 'active'
            ? 'in-use: an open lease still uses this grant'
            : 'usage-unknown: whether the owning Host still runs cannot be determined',
      }
  }
  return { kind: 'none', stale }
}

/** 'gone' only with proof: the owning process has exited or its ID now belongs to another process. */
export async function ownerState(
  owner: WindowsLeaseOwner,
  self: WindowsLeaseOwner,
  openHere: boolean,
  processIdentity: (pid: number) => Promise<ProcessIdentity>,
): Promise<'active' | 'unknown' | 'gone'> {
  if (owner.pid === self.pid && owner.startId === self.startId) return openHere ? 'active' : 'unknown'
  const identity = await processIdentity(owner.pid)
  if (identity.state === 'dead') return 'gone'
  if (identity.state === 'alive') return identity.startId === owner.startId ? 'active' : 'gone'
  return 'unknown'
}

/** What a launcher needs to build the restricted token and environment for one process. */
export type WindowsAclLaunchClaim = Readonly<{
  leaseId: string
  grantId?: string
  mode: 'read-only' | 'workspace-write'
  root: string
  rootIdentity: WindowsObjectIdentity
  policyDigest: string
  /** Capability SIDs the token may write with: the workspace grant's, then the lease temp's. */
  writeSids: readonly string[]
  tempRoot?: string
  /** The process was created; the lease keeps its temp until `exited` settles. */
  started(exited: PromiseLike<unknown>): void
  /** No process was created for this permit. */
  abandoned(): void
}>

/** Opaque proof that a lease checked its grant for one launch. Only this module can create one. */
export type WindowsAclLaunchPermit = Readonly<{ leaseId: string }> & {
  readonly __windowsAclPermit: unique symbol
}

type PermitState = { owner: LeaseProcesses; payload: Omit<WindowsAclLaunchClaim, 'started' | 'abandoned'> }
const permits = new WeakMap<object, PermitState>()

/**
 * Redeems a permit exactly once. A copy, a deserialized object or a permit whose lease is closing
 * is refused; a refused permit of a real lease is settled as abandoned.
 */
export function claimWindowsLaunchPermit(permit: WindowsAclLaunchPermit): WindowsAclLaunchClaim {
  const state = typeof permit === 'object' && permit !== null ? permits.get(permit) : undefined
  if (!state) throw aclError('E_ACL_PERMIT_INVALID', 'Not a launch permit issued by this Host')
  permits.delete(permit)
  return state.owner.claim(permit, state.payload)
}

/**
 * Tracks the permits a lease issued and the processes started under them. Closing waits for every
 * started process to exit; an issued permit that was neither started nor abandoned keeps the lease's
 * resources, because a process might still be created from it.
 */
export class LeaseProcesses {
  readonly #pending = new Set<object>()
  readonly #exits = new Set<Promise<'exited' | 'unproven'>>()
  #closing = false

  get closing(): boolean {
    return this.#closing
  }

  issue(payload: PermitState['payload']): WindowsAclLaunchPermit {
    if (this.#closing) throw aclError('E_ACL_LEASE_CLOSED', 'The execution lease is closing')
    const permit = Object.freeze({ leaseId: payload.leaseId }) as WindowsAclLaunchPermit
    permits.set(permit, { owner: this, payload })
    this.#pending.add(permit)
    return permit
  }

  claim(permit: object, payload: PermitState['payload']): WindowsAclLaunchClaim {
    if (this.#closing) {
      this.#pending.delete(permit)
      throw aclError('E_ACL_LEASE_CLOSED', 'The execution lease is closing')
    }
    let settled = false
    const settle = () => {
      if (settled) throw aclError('E_ACL_PERMIT_USED', 'This launch permit was already settled')
      settled = true
      this.#pending.delete(permit)
    }
    return Object.freeze({
      ...payload,
      started: (exited: PromiseLike<unknown>) => {
        settle()
        this.#exits.add(
          Promise.resolve(exited).then(
            () => 'exited' as const,
            () => 'unproven' as const,
          ),
        )
      },
      abandoned: settle,
    })
  }

  /**
   * Stops issuing permits and waits for every started process. Throws, keeping everything, while a
   * permit is unsettled or a process's exit could not be proven; a later call tries again.
   */
  async drain(): Promise<void> {
    this.#closing = true
    if (this.#pending.size > 0)
      throw aclError('E_ACL_LEASE_BUSY', 'A launch permit of this lease is still unsettled')
    const outcomes = await Promise.all(this.#exits)
    if (outcomes.includes('unproven'))
      throw aclError('E_ACL_PROCESS_UNSETTLED', 'A process of this lease could not be proven to have exited')
  }
}
