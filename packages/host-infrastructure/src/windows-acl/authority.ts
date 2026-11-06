// Host-side owner of Windows write-restricted execution. It decides nothing about policy (see
// policy.ts); given a decided lease request it grants the workspace root once and keeps that grant
// standing, gives every lease its own temp directory and capability SID, and only hands out a
// launch permit after re-checking the grant. Native ACL primitives and the file system are
// injected, so the same transaction rules run against fakes in tests and against NTFS in the Host.
import { randomUUID } from 'node:crypto'
import {
  type WindowsAclApply,
  type WindowsAclMutation,
  type WindowsAclRestore,
  type WindowsAclSnapshot,
  type WindowsObjectIdentity,
  windowsAclGrantEntries,
} from '@agnes/system-node/windows-acl'
import type { ProcessIdentity } from '../adapters/process-identity.js'
import {
  aclError,
  durableStateFiles,
  identityKey,
  planGrantRestore,
  sameIdentity,
  type WindowsAclIssue,
  WindowsAclJournal,
  type WindowsAclStateFiles,
  type WindowsGrantEntry,
  type WindowsGrantKind,
  type WindowsGrantRecord,
  type WindowsLeaseOwner,
  type WindowsLeaseRecord,
  windowsAclSteps,
} from './journal.js'
import {
  assertWorkspaceDisjoint,
  claimWindowsLaunchPermit,
  freshWriteSid,
  grantUsage,
  isLeaseTemp,
  LeaseProcesses,
  leaseTempName,
  ownerState,
  pathsOverlap,
  samePath,
  type WindowsAclLaunchPermit,
  type WindowsAclPaths,
} from './leases.js'

export type { WindowsAclLaunchClaim, WindowsAclLaunchPermit, WindowsAclPaths } from './leases.js'
export { claimWindowsLaunchPermit }

/** The native primitives of `@agnes/system-node/windows-acl`; synchronous and tree-walking. */
export type WindowsAclNative = Readonly<{
  inspect(path: string): WindowsAclSnapshot
  apply(input: WindowsAclApply): WindowsAclMutation
  restore(input: WindowsAclRestore): WindowsAclMutation
}>

/** File system and process facts the authority relies on, provided by the Host. */
export type WindowsAclPlatform = Readonly<{
  paths: WindowsAclPaths
  /** Final path of an existing directory with every link resolved; ENOENT when it is missing. */
  canonicalPath(path: string): Promise<string>
  /** Volume and file ID of the directory at `path`, without following a link at the end. */
  rootIdentity(path: string): Promise<WindowsObjectIdentity>
  /** Creates the directory if needed, then proves it is this account's, private and not a link. */
  ensurePrivateDirectory(path: string): Promise<void>
  /** Creates one directory that must not exist yet; it inherits its parent's permissions. */
  createDirectory(path: string): Promise<void>
  /** Removes a directory tree; a missing directory is success. */
  removeDirectory(path: string): Promise<void>
  /** This process, as recorded in lock and lease records. */
  self: WindowsLeaseOwner
  processIdentity(pid: number): Promise<ProcessIdentity>
}>

export type WindowsExecutionAuthorityOptions = Readonly<{
  /** Account-private journal directory, `LocalAppData/AgnesHarness/acl-state/v1` on Windows. */
  stateRoot: string
  /** Fixed Host-private parent of every lease temp directory. */
  tempRoot: string
  /** AGH private data roots; a workspace may neither contain nor lie inside one. */
  privateRoots: readonly string[]
  native: WindowsAclNative
  platform: WindowsAclPlatform
  files?: WindowsAclStateFiles
  lockWaitMs?: number
}>

/** The fixed locations under the account's LocalAppData folder. */
export function windowsAclLocations(
  localAppData: string,
  paths: Pick<WindowsAclPaths, 'join'>,
): Readonly<{ stateRoot: string; tempRoot: string }> {
  return {
    stateRoot: paths.join(localAppData, 'AgnesHarness', 'acl-state', 'v1'),
    tempRoot: paths.join(localAppData, 'AgnesHarness', 'acl-temp', 'v1'),
  }
}

export type WindowsLeaseInput = Readonly<{
  sessionExecutionId: string
  canonicalRoot: string
  policyDigest: string
  mode: 'read-only' | 'workspace-write'
}>

export type WindowsExecutionLease = Readonly<{
  id: string
  rootIdentity: WindowsObjectIdentity
  policyDigest: string
  mode: 'read-only' | 'workspace-write'
  /** This lease's own temp directory; read-only leases have none. */
  tempRoot?: string
  /** Re-checks the root and the grant, then issues a permit for one process. */
  prepareLaunch(): Promise<WindowsAclLaunchPermit>
  /** Waits for the lease's processes, then revokes and removes its temp. The workspace grant stays. */
  close(): Promise<void>
}>

export type WindowsAclReport = Readonly<{
  state: 'active' | 'needs-attention' | 'revoked' | 'unavailable'
  grantId?: string
  recordDigest?: string
  issues: readonly WindowsAclIssue[]
  repairable: boolean
  /** What the user can do next, most specific first. */
  steps: readonly string[]
}>

export type WindowsAclRepairRequest = Readonly<{
  root: string
  grantId: string
  expectedRecordDigest: string
  signal?: AbortSignal
}>

type LeaseState = {
  record: WindowsLeaseRecord
  rootIdentity: WindowsObjectIdentity
  policyDigest: string
  workspace?: WindowsGrantEntry
  temp?: WindowsGrantEntry
  processes: LeaseProcesses
  closed: boolean
}

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
/** An issue with the stable code of the error behind it, when it has one. */
const issueOf = (object: string, reason: string, error: unknown): WindowsAclIssue => {
  const code = codeOf(error)
  return code ? { object, reason, code } : { object, reason }
}
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')

export class WindowsExecutionAuthority {
  readonly #options: WindowsExecutionAuthorityOptions
  readonly #journal: WindowsAclJournal
  readonly #leases = new Map<string, LeaseState>()
  #disposed = false

  constructor(options: WindowsExecutionAuthorityOptions) {
    this.#options = options
    const { platform } = options
    this.#journal = new WindowsAclJournal({
      root: options.stateRoot,
      files: options.files ?? durableStateFiles,
      ensurePrivateDirectory: (path) => platform.ensurePrivateDirectory(path),
      self: platform.self,
      processIdentity: (pid) => platform.processIdentity(pid),
      lockWaitMs: options.lockWaitMs ?? 30_000,
    })
  }

  /**
   * Returns a lease only after the workspace grant is recorded, applied and read back, and the
   * lease's temp grant likewise. Any refusal leaves no lease and starts nothing.
   */
  async acquire(input: WindowsLeaseInput): Promise<WindowsExecutionLease> {
    if (
      !input ||
      !validText(input.sessionExecutionId, 256) ||
      !validText(input.policyDigest, 256) ||
      !validText(input.canonicalRoot, 32_000) ||
      (input.mode !== 'read-only' && input.mode !== 'workspace-write')
    )
      throw aclError('EINVAL', 'Invalid Windows execution lease request')
    if (this.#disposed) throw aclError('E_ACL_DISPOSED', 'The Windows execution authority was disposed')
    const root = await this.#workspaceRoot(input.canonicalRoot)
    const leaseId = randomUUID()
    if (input.mode === 'read-only') {
      const rootIdentity = await this.#options.platform.rootIdentity(root)
      return this.#lease({
        record: { version: 1, leaseId, owner: this.#options.platform.self, ...input, root },
        rootIdentity,
        policyDigest: input.policyDigest,
        processes: new LeaseProcesses(),
        closed: false,
      })
    }
    return this.#journal.locked(async () => {
      const grants = this.#journal.grants()
      if (grants.corrupt.length > 0)
        throw aclError('E_ACL_JOURNAL_CORRUPT', 'A Windows ACL record is damaged; inspect before granting')
      await this.#assertTempRootFree(grants.entries.map(({ record }) => record))
      await this.#sweepStaleLeases()
      const workspace = this.#workspaceGrant(root)
      const { join } = this.#options.platform.paths
      await this.#options.platform.ensurePrivateDirectory(this.#options.tempRoot)
      const tempPath = join(await this.#resolve(this.#options.tempRoot), leaseTempName())
      let record: WindowsLeaseRecord = {
        version: 1,
        leaseId,
        owner: this.#options.platform.self,
        sessionExecutionId: input.sessionExecutionId,
        root,
        mode: input.mode,
        workspaceGrantId: workspace.record.grantId,
        tempPath,
      }
      this.#journal.writeLease(record)
      let temp: WindowsGrantEntry | undefined
      try {
        await this.#options.platform.createDirectory(tempPath)
        temp = this.#grant(this.#options.native.inspect(tempPath), tempPath, 'temp', leaseId)
        record = { ...record, tempGrantId: temp.record.grantId }
        this.#journal.writeLease(record)
      } catch (error) {
        // A temp grant that cannot be undone stays recorded for inspect and repair; the lease record
        // goes either way, so it does not hold the workspace grant in use.
        await this.#releaseTemp(record, temp).catch(() => {
          try {
            this.#journal.removeLease(record.leaseId)
          } catch {}
        })
        throw error
      }
      return this.#lease({
        record,
        rootIdentity: workspace.record.rootIdentity,
        policyDigest: input.policyDigest,
        workspace,
        temp,
        processes: new LeaseProcesses(),
        closed: false,
      })
    })
  }

  /** Read-only check of what AGH recorded for a root against the permissions it has now. */
  async inspect(root: string): Promise<WindowsAclReport> {
    if (!validText(root, 32_000)) throw aclError('EINVAL', 'Invalid Windows workspace root')
    await this.#journal.open()
    const path = await this.#resolve(root)
    const identity = await this.#options.platform.rootIdentity(path).catch(() => undefined)
    const { entries, corrupt } = this.#journal.grants()
    const chosen = this.#choose(entries, path, identity)
    if (!chosen) {
      const issues =
        corrupt.length > 0 ? corrupt : [{ object: path, reason: 'no-grant: AGH has no grant here' }]
      return reportOf(corrupt.length > 0 ? 'needs-attention' : 'unavailable', undefined, issues, false, path)
    }
    const { record } = chosen
    const issues: WindowsAclIssue[] = [...corrupt]
    let state: WindowsAclReport['state'] = record.state === 'prepared' ? 'needs-attention' : record.state
    if (record.state === 'prepared')
      issues.push({ object: record.root, reason: 'interrupted: the grant is in progress or was interrupted' })
    if (record.state === 'needs-attention') issues.push(...record.issues)
    if (record.state === 'active') {
      const live = this.#liveCheck(record)
      if (live) {
        state = 'needs-attention'
        issues.push(live)
      }
    }
    return reportOf(state, chosen, issues, state !== 'revoked' && corrupt.length === 0, record.root)
  }

  /**
   * Removes exactly the increments this grant provably made, once no Host can still be using it.
   * Refuses without changing anything when the record moved on, the root is not the recorded one,
   * or any lease of any Host uses the grant or cannot be proven gone.
   */
  async repair(request: WindowsAclRepairRequest): Promise<WindowsAclReport> {
    if (
      !request ||
      !validText(request.root, 32_000) ||
      !validText(request.grantId, 128) ||
      !validText(request.expectedRecordDigest, 128)
    )
      throw aclError('EINVAL', 'Invalid Windows ACL repair request')
    request.signal?.throwIfAborted()
    const path = await this.#resolve(request.root)
    return this.#journal.locked(async () => {
      let entry: WindowsGrantEntry | undefined
      try {
        entry = this.#journal.grant(request.grantId)
      } catch (error) {
        const issue = issueOf(request.grantId, 'corrupt: the record is damaged', error)
        return reportOf('needs-attention', undefined, [issue], false, path)
      }
      if (!entry)
        return reportOf('unavailable', undefined, [{ object: path, reason: 'no-grant' }], false, path)
      const refuse = (reason: string) =>
        reportOf(this.#reportState(entry.record), entry, [{ object: path, reason }], false, entry.record.root)
      if (entry.digest !== request.expectedRecordDigest)
        return refuse('record-changed: the record changed since it was inspected; inspect again')
      if (!samePath(this.#options.platform.paths, path, entry.record.root))
        return refuse('root-mismatch: the grant belongs to another root')
      if (entry.record.state === 'revoked') return reportOf('revoked', entry, [], false, entry.record.root)
      const leases = this.#journal.leases()
      const usage = await grantUsage(
        entry.record,
        leases.entries,
        leases.corrupt.length,
        this.#options.platform.self,
        this.#openLeases(),
        (pid) => this.#options.platform.processIdentity(pid),
      )
      if (usage.kind !== 'none') return refuse(usage.reason)
      request.signal?.throwIfAborted()
      const result = this.#restore(entry)
      if (result.entry.record.state === 'revoked' && result.entry.record.kind === 'temp')
        await this.#forgetTemp(result.entry.record, usage.stale)
      return reportOf(this.#reportState(result.entry.record), result.entry, result.issues, true, path)
    })
  }

  /** Closes every lease of this authority; retry after a failure keeps what could not be released. */
  async dispose(): Promise<void> {
    this.#disposed = true
    const failures: unknown[] = []
    for (const state of [...this.#leases.values()])
      await this.#close(state).catch((error: unknown) => failures.push(error))
    if (failures.length > 0)
      throw Object.assign(new AggregateError(failures, 'Some execution leases could not be released'), {
        code: 'E_ACL_DISPOSE_INCOMPLETE',
      })
  }

  #lease(state: LeaseState): WindowsExecutionLease {
    this.#leases.set(state.record.leaseId, state)
    const { record } = state
    return Object.freeze({
      id: record.leaseId,
      rootIdentity: state.rootIdentity,
      policyDigest: state.policyDigest,
      mode: record.mode,
      ...(record.tempPath ? { tempRoot: record.tempPath } : {}),
      prepareLaunch: () => this.#prepareLaunch(state),
      close: () => this.#close(state),
    })
  }

  async #prepareLaunch(state: LeaseState): Promise<WindowsAclLaunchPermit> {
    if (state.closed || state.processes.closing)
      throw aclError('E_ACL_LEASE_CLOSED', 'The execution lease is closing')
    const identity = await this.#options.platform.rootIdentity(state.record.root)
    if (!sameIdentity(identity, state.rootIdentity))
      throw aclError('E_ACL_IDENTITY_MISMATCH', 'The workspace root is no longer the leased directory')
    const writeSids: string[] = []
    for (const held of [state.workspace, state.temp]) {
      if (!held) continue
      const current = this.#journal.grant(held.record.grantId)
      if (!current || current.digest !== held.digest || current.record.state !== 'active')
        throw aclError('E_ACL_GRANT_CHANGED', 'The Windows ACL grant changed since this lease verified it')
      writeSids.push(current.record.writeSid)
    }
    return state.processes.issue({
      leaseId: state.record.leaseId,
      ...(state.workspace ? { grantId: state.workspace.record.grantId } : {}),
      mode: state.record.mode,
      root: state.record.root,
      rootIdentity: state.rootIdentity,
      policyDigest: state.policyDigest,
      writeSids: Object.freeze(writeSids),
      ...(state.record.tempPath ? { tempRoot: state.record.tempPath } : {}),
    })
  }

  async #close(state: LeaseState): Promise<void> {
    if (state.closed) return
    await state.processes.drain()
    if (state.record.mode === 'workspace-write')
      await this.#journal.locked(async () => {
        const temp = state.temp && this.#journal.grant(state.temp.record.grantId)
        await this.#releaseTemp(state.record, temp)
      })
    state.closed = true
    this.#leases.delete(state.record.leaseId)
  }

  /** Revokes a lease's temp grant, removes its directory and then its record, in that order. */
  async #releaseTemp(record: WindowsLeaseRecord, temp: WindowsGrantEntry | undefined): Promise<void> {
    const grants = this.#journal
      .grants()
      .entries.filter((entry) => entry.record.kind === 'temp' && entry.record.lease === record.leaseId)
    if (temp && !grants.some((entry) => entry.record.grantId === temp.record.grantId)) grants.push(temp)
    for (const entry of grants) {
      if (entry.record.state === 'revoked') continue
      const result = this.#restore(entry)
      if (result.entry.record.state !== 'revoked')
        throw aclError('E_ACL_TEMP_RESTORE', `The temp grant ${entry.record.grantId} could not be revoked`)
    }
    const tempRoot = await this.#resolve(this.#options.tempRoot)
    if (record.tempPath && isLeaseTemp(this.#options.platform.paths, tempRoot, record.tempPath))
      await this.#options.platform.removeDirectory(record.tempPath)
    this.#journal.removeLease(record.leaseId)
  }

  /** Releases the temp of every lease whose owning Host is proven gone; anything unproven stays. */
  async #sweepStaleLeases(): Promise<void> {
    const { platform } = this.#options
    for (const lease of this.#journal.leases().entries) {
      const owner = await ownerState(lease.owner, platform.self, this.#leases.has(lease.leaseId), (pid) =>
        platform.processIdentity(pid),
      )
      if (owner === 'gone') await this.#releaseTemp(lease, undefined).catch(() => {})
    }
  }

  async #forgetTemp(record: WindowsGrantRecord, stale: readonly WindowsLeaseRecord[]): Promise<void> {
    const { paths } = this.#options.platform
    if (isLeaseTemp(paths, await this.#resolve(this.#options.tempRoot), record.root))
      await this.#options.platform.removeDirectory(record.root)
    for (const lease of stale)
      if (lease.tempGrantId === record.grantId || lease.leaseId === record.lease)
        this.#journal.removeLease(lease.leaseId)
  }

  /** Reuses the standing grant of this root object, or makes a new one. */
  #workspaceGrant(root: string): WindowsGrantEntry {
    const snapshot = this.#options.native.inspect(root)
    const related = this.#journal
      .grants()
      .entries.filter(
        ({ record }) => record.state !== 'revoked' && sameIdentity(record.rootIdentity, snapshot.identity),
      )
    const blocked = related.find(({ record }) => record.state !== 'active' || record.kind !== 'workspace')
    if (blocked)
      throw aclError(
        'E_ACL_NEEDS_ATTENTION',
        `The Windows ACL grant ${blocked.record.grantId} on ${root} needs attention; inspect and repair it first`,
      )
    const active = related[0]
    if (!active) return this.#grant(snapshot, root, 'workspace')
    if (snapshot.fingerprint !== active.record.applied?.fingerprint) {
      this.#journal.write({
        ...active.record,
        state: 'needs-attention',
        issues: [
          { object: root, reason: 'changed: permissions changed after the grant; nothing was overwritten' },
        ],
      })
      throw aclError(
        'E_ACL_CHANGED',
        `Permissions of ${root} changed after AGH granted it; inspect and repair it`,
      )
    }
    return active
  }

  /**
   * One grant transaction: durable prepared record (with the complete snapshot), then the native
   * change, then the recorded result, then an independent read-back, and only then active.
   */
  #grant(
    before: WindowsAclSnapshot,
    root: string,
    kind: WindowsGrantKind,
    lease?: string,
  ): WindowsGrantEntry {
    const { native } = this.#options
    const grantId = randomUUID()
    const writeSid = freshWriteSid()
    let entry = this.#journal.write({
      grantId,
      kind,
      root,
      rootIdentity: before.identity,
      writeSid,
      ...(lease ? { lease } : {}),
      state: 'prepared',
      before,
      issues: [],
    })
    let mutation: WindowsAclMutation
    try {
      mutation = native.apply({ before, grantId, writeSid })
    } catch (error) {
      this.#settleFailedApply(entry, error)
      throw error
    }
    const change = mutation.changes.find((item) => sameIdentity(item.identity, before.identity))
    const failures = mutation.failures.map((failure) =>
      issueOf(failure.path, 'apply-failed: the grant did not complete here', failure),
    )
    entry = this.#journal.write({
      ...entry.record,
      ...(change ? { applied: { fingerprint: change.afterFingerprint, added: change.added } } : {}),
      issues: failures,
    })
    if (!mutation.complete || !change) {
      entry = this.#journal.write({ ...entry.record, state: 'needs-attention' })
      this.#restore(entry)
      throw aclError('E_ACL_GRANT_INCOMPLETE', `The Windows ACL grant on ${root} did not complete`)
    }
    const after = native.inspect(root)
    if (!sameIdentity(after.identity, before.identity) || after.fingerprint !== change.afterFingerprint) {
      this.#journal.write({
        ...entry.record,
        state: 'needs-attention',
        issues: [{ object: root, reason: 'unverified: the root did not read back as granted' }],
      })
      throw aclError('E_ACL_VERIFY_FAILED', `The Windows ACL grant on ${root} did not read back`)
    }
    return this.#journal.write({ ...entry.record, state: 'active' })
  }

  /** After a native refusal, a record whose objects all read as before is revoked; anything else needs attention. */
  #settleFailedApply(entry: WindowsGrantEntry, error: unknown): void {
    const { record } = entry
    const issue = issueOf(record.root, 'apply-failed: the grant was refused', error)
    try {
      const now = this.#options.native.inspect(record.root)
      const prints = (snapshot: WindowsAclSnapshot) =>
        [
          snapshot.fingerprint,
          ...snapshot.descendants.map((item) => `${identityKey(item.identity)}:${item.fingerprint}`).sort(),
        ].join('\n')
      const untouched =
        sameIdentity(now.identity, record.rootIdentity) && prints(now) === prints(record.before)
      this.#journal.write({ ...record, state: untouched ? 'revoked' : 'needs-attention', issues: [issue] })
    } catch {
      // The record stays prepared or is written as needs-attention; both refuse use.
      try {
        this.#journal.write({ ...record, state: 'needs-attention', issues: [issue] })
      } catch {}
    }
  }

  /**
   * Restores one grant under the lock. The record reads needs-attention from before the native call
   * until the result is confirmed, so a crash in between never reads as active or as revoked.
   */
  #restore(entry: WindowsGrantEntry): { entry: WindowsGrantEntry; issues: readonly WindowsAclIssue[] } {
    const { native } = this.#options
    const { record } = entry
    const settle = (state: WindowsGrantRecord['state'], issues: WindowsAclIssue[], extra = {}) => {
      const next = this.#journal.write({
        ...record,
        ...extra,
        generation: entry.record.generation,
        state,
        issues,
      })
      entry = next
      return { entry: next, issues }
    }
    let current: WindowsAclSnapshot
    try {
      current = native.inspect(record.root)
    } catch (error) {
      return settle('needs-attention', [
        issueOf(record.root, 'unreadable: the root cannot be inspected', error),
      ])
    }
    const others = this.#journal.grants().entries.map((item) => item.record)
    const plan = planGrantRestore(record, current, others, windowsAclGrantEntries)
    if (plan.kind === 'unchanged') return settle('revoked', [])
    if (plan.kind === 'refuse') return settle('needs-attention', [...plan.issues])
    const issues: WindowsAclIssue[] = [...plan.issues]
    for (const kept of plan.kept)
      issues.push({ object: current.path, reason: `shared: the ${kept.kind} entry stays for another grant` })
    if (plan.removable.length === 0) return settle('needs-attention', issues)
    entry = this.#journal.write({
      ...record,
      state: 'needs-attention',
      issues: [
        ...issues,
        { object: current.path, reason: 'restoring: removal started and is not confirmed' },
      ],
    })
    let mutation: WindowsAclMutation
    try {
      mutation = native.restore({
        before: current,
        grantId: record.grantId,
        expectedCurrentFingerprint: current.fingerprint,
        removableChanges: plan.removable,
      })
    } catch (error) {
      return settle('needs-attention', [
        ...issues,
        issueOf(current.path, 'restore-refused: nothing was removed', error),
      ])
    }
    if (!mutation.complete)
      return settle('needs-attention', [
        ...issues,
        ...mutation.failures.map((failure) =>
          issueOf(failure.path, 'restore-failed: the removal did not complete here', failure),
        ),
      ])
    const after =
      mutation.changes.find((item) => sameIdentity(item.identity, current.identity))?.afterFingerprint ??
      current.fingerprint
    this.#rebase(record, current.fingerprint, after)
    // Without a recorded result the deny and label may still be this grant's: only the original
    // state proves everything is gone.
    const residue = !record.applied && after !== record.before.fingerprint
    return settle(residue ? 'needs-attention' : 'revoked', issues, {
      removed: [...(record.removed ?? []), ...plan.removable],
      ...(record.applied ? { applied: { ...record.applied, fingerprint: after } } : {}),
    })
  }

  /** Other grants on the same object follow AGH's own change, so it never reads as a third-party one. */
  #rebase(record: WindowsGrantRecord, from: string, to: string): void {
    for (const { record: other } of this.#journal.grants().entries)
      if (
        other.grantId !== record.grantId &&
        other.state !== 'revoked' &&
        sameIdentity(other.rootIdentity, record.rootIdentity) &&
        other.applied?.fingerprint === from
      )
        this.#journal.write({ ...other, applied: { ...other.applied, fingerprint: to } })
  }

  #liveCheck(record: WindowsGrantRecord): WindowsAclIssue | undefined {
    try {
      const now = this.#options.native.inspect(record.root)
      if (!sameIdentity(now.identity, record.rootIdentity))
        return { object: record.root, reason: 'replaced: another directory now has this path' }
      if (now.fingerprint !== record.applied?.fingerprint)
        return { object: record.root, reason: 'changed: permissions changed after the grant' }
    } catch (error) {
      return issueOf(record.root, 'unreadable: the root cannot be inspected', error)
    }
    return undefined
  }

  #choose(entries: readonly WindowsGrantEntry[], path: string, identity: WindowsObjectIdentity | undefined) {
    const { paths } = this.#options.platform
    const matching = entries.filter(
      ({ record }) =>
        (identity && sameIdentity(record.rootIdentity, identity)) || samePath(paths, record.root, path),
    )
    const rank = { 'needs-attention': 0, prepared: 1, active: 2, revoked: 3 } as const
    return matching.sort((a, b) => rank[a.record.state] - rank[b.record.state])[0]
  }

  #reportState(record: WindowsGrantRecord): WindowsAclReport['state'] {
    return record.state === 'prepared' ? 'needs-attention' : record.state
  }

  #openLeases(): ReadonlySet<string> {
    return new Set(
      [...this.#leases.values()].filter((state) => !state.closed).map((state) => state.record.leaseId),
    )
  }

  /** The canonical root, refused when it is not canonical or overlaps a directory the Host keeps. */
  async #workspaceRoot(root: string): Promise<string> {
    const { platform } = this.#options
    let canonical: string
    try {
      canonical = await platform.canonicalPath(root)
    } catch (error) {
      if (codeOf(error) === 'ENOENT')
        throw aclError('E_ACL_ROOT_MISSING', `The workspace ${root} does not exist`)
      throw error
    }
    if (!samePath(platform.paths, canonical, root))
      throw aclError(
        'E_ACL_ROOT_NOT_CANONICAL',
        `The workspace ${root} is not its canonical path ${canonical}`,
      )
    assertWorkspaceDisjoint(platform.paths, canonical, await this.#reserved())
    return canonical
  }

  /** A recorded grant that covers a Host directory would flow into every new lease temp: refuse. */
  async #assertTempRootFree(records: readonly WindowsGrantRecord[]): Promise<void> {
    const reserved = await this.#reserved()
    for (const record of records)
      if (record.kind === 'workspace' && record.state !== 'revoked')
        for (const { path, role } of reserved)
          if (pathsOverlap(this.#options.platform.paths, record.root, path))
            throw aclError(
              'E_ACL_ROOT_OVERLAP',
              `The granted workspace ${record.root} overlaps the Host ${role} ${path}; repair that grant first`,
            )
  }

  async #reserved(): Promise<{ path: string; role: string }[]> {
    const { tempRoot, stateRoot, privateRoots } = this.#options
    return Promise.all([
      this.#resolve(tempRoot).then((path) => ({ path, role: 'temp root' })),
      this.#resolve(stateRoot).then((path) => ({ path, role: 'ACL state root' })),
      ...privateRoots.map((root) =>
        this.#resolve(root).then((path) => ({ path, role: 'private data root' })),
      ),
    ])
  }

  /** Canonical path of the nearest existing ancestor, with the missing remainder appended. */
  async #resolve(path: string): Promise<string> {
    const { platform } = this.#options
    try {
      return await platform.canonicalPath(path)
    } catch (error) {
      const parent = platform.paths.dirname(path)
      if (codeOf(error) !== 'ENOENT' || parent === path) throw error
      return platform.paths.join(await this.#resolve(parent), platform.paths.basename(path))
    }
  }
}

function reportOf(
  state: WindowsAclReport['state'],
  entry: WindowsGrantEntry | undefined,
  issues: readonly WindowsAclIssue[],
  repairable: boolean,
  root: string,
): WindowsAclReport {
  return Object.freeze({
    state,
    ...(entry ? { grantId: entry.record.grantId, recordDigest: entry.digest } : {}),
    issues: Object.freeze([...issues]),
    repairable,
    steps: Object.freeze(windowsAclSteps(root, entry?.record, issues)),
  })
}
