// Durable record of every ACL grant this account's Hosts make on Windows. A record is written and
// flushed before the first system call that could change a permission, carries the complete
// pre-grant snapshot, and moves through prepared -> active -> revoked. Anything that cannot be
// proven complete reads as needs-attention, never as active. Records are only ever replaced whole
// by a flushed publish, so a crash leaves the previous version or the new one.
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { publishFileDurablySync, removeFileDurablySync } from '@agnes/system-node'
import {
  acquireOwnerFileLock,
  readLockOwner,
  releaseOwnerFileLock,
  takeOverOwnerFileLock,
} from '@agnes/system-node/owner-lock'
import type {
  WindowsAclEntry,
  WindowsAclObject,
  WindowsAclSnapshot,
  WindowsObjectIdentity,
} from '@agnes/system-node/windows-acl'
import type { ProcessIdentity } from '../adapters/process-identity.js'

export type WindowsGrantState = 'prepared' | 'active' | 'needs-attention' | 'revoked'
export type WindowsGrantKind = 'workspace' | 'temp'

/** One finding about a recorded object: a path or identity, a stable reason and an optional system code. */
export type WindowsAclIssue = Readonly<{ object: string; reason: string; code?: string }>

export type WindowsGrantApplied = Readonly<{
  /** Root fingerprint after the latest change AGH made to this object. */
  fingerprint: string
  /** Entries this grant added to the root; entries that already stood there exactly are not listed. */
  added: readonly WindowsAclEntry[]
}>

export type WindowsGrantRecord = Readonly<{
  version: 1
  grantId: string
  kind: WindowsGrantKind
  /** Canonical root path when the grant was made; an index only, the identity decides. */
  root: string
  rootIdentity: WindowsObjectIdentity
  writeSid: string
  /** The lease that owns a temporary directory grant. */
  lease?: string
  /** Incremented by every write of this record. */
  generation: number
  state: WindowsGrantState
  before: WindowsAclSnapshot
  applied?: WindowsGrantApplied
  /** Entries an earlier repair already removed from the root. */
  removed?: readonly WindowsAclEntry[]
  issues: readonly WindowsAclIssue[]
}>

export type WindowsGrantEntry = Readonly<{ record: WindowsGrantRecord; digest: string }>

export type WindowsLeaseOwner = Readonly<{ pid: number; startId: string }>

/** A lease in use, so that a repair from any Host can see it and a crash leaves its temp traceable. */
export type WindowsLeaseRecord = Readonly<{
  version: 1
  leaseId: string
  owner: WindowsLeaseOwner
  sessionExecutionId: string
  root: string
  mode: 'read-only' | 'workspace-write'
  workspaceGrantId?: string
  tempPath?: string
  tempGrantId?: string
}>

/** File access of the journal. The default publishes each record through a flushed temporary file. */
export type WindowsAclStateFiles = Readonly<{
  /** Contents of a record, or undefined when there is none. */
  read(path: string): string | undefined
  /** Names in a directory; a missing directory has none. */
  list(directory: string): readonly string[]
  /** Returns only once the content and its directory entry are durable. */
  writeDurable(path: string, text: string): void
  /** Returns only once the removal is durable; a missing file is success. */
  removeDurable(path: string): void
}>

export const durableStateFiles: WindowsAclStateFiles = Object.freeze({
  read(path: string) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
  list(directory: string) {
    try {
      return readdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  },
  writeDurable(path: string, text: string) {
    publishFileDurablySync(path, text, { replace: true })
  },
  removeDurable(path: string) {
    removeFileDurablySync(path)
  },
})

export type WindowsAclJournalOptions = Readonly<{
  root: string
  files: WindowsAclStateFiles
  /** Creates the directory if needed and proves it is owned by this account, private and not a link. */
  ensurePrivateDirectory(path: string): Promise<void>
  self: WindowsLeaseOwner
  processIdentity(pid: number): Promise<ProcessIdentity>
  lockWaitMs: number
}>

export const aclError = (code: string, message: string): Error => Object.assign(new Error(message), { code })

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HEX64 = /^[0-9a-f]{64}$/
const STATES = new Set<string>(['prepared', 'active', 'needs-attention', 'revoked'])
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 32_768): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const digestOf = (body: string) => createHash('sha256').update(body).digest('hex')
export const identityKey = (identity: WindowsObjectIdentity): string =>
  `${identity.volumeId}:${identity.fileId}`
export const sameIdentity = (a: WindowsObjectIdentity, b: WindowsObjectIdentity): boolean =>
  a.volumeId === b.volumeId && a.fileId === b.fileId

function validIdentity(value: unknown): value is WindowsObjectIdentity {
  return (
    record(value) &&
    typeof value.volumeId === 'string' &&
    /^[0-9a-f]{16}$/.test(value.volumeId) &&
    typeof value.fileId === 'string' &&
    /^[0-9a-f]{32}$/.test(value.fileId)
  )
}
function validObject(value: unknown): value is WindowsAclObject {
  return (
    record(value) &&
    text(value.path) &&
    validIdentity(value.identity) &&
    text(value.securityDescriptor, 1_048_576) &&
    typeof value.fingerprint === 'string' &&
    HEX64.test(value.fingerprint)
  )
}
function validSnapshot(value: unknown): value is WindowsAclSnapshot {
  return (
    validObject(value) &&
    Array.isArray((value as Record<string, unknown>).descendants) &&
    ((value as Record<string, unknown>).descendants as unknown[]).every(validObject) &&
    Number.isSafeInteger((value as Record<string, unknown>).inheritedDescendants)
  )
}
function validEntry(value: unknown): value is WindowsAclEntry {
  return (
    record(value) &&
    ['allow', 'deny', 'label', 'other'].includes(value.kind as string) &&
    text(value.sid, 256) &&
    Number.isInteger(value.mask) &&
    Number.isInteger(value.flags)
  )
}
function validIssues(value: unknown): value is WindowsAclIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (issue) =>
        record(issue) &&
        text(issue.object) &&
        text(issue.reason, 256) &&
        (issue.code === undefined || text(issue.code, 64)),
    )
  )
}
function validGrant(value: unknown): value is WindowsGrantRecord {
  if (!record(value) || value.version !== 1) return false
  const applied = value.applied
  return (
    typeof value.grantId === 'string' &&
    ID.test(value.grantId) &&
    (value.kind === 'workspace' || value.kind === 'temp') &&
    text(value.root) &&
    validIdentity(value.rootIdentity) &&
    text(value.writeSid, 256) &&
    (value.lease === undefined || (typeof value.lease === 'string' && ID.test(value.lease))) &&
    Number.isSafeInteger(value.generation) &&
    STATES.has(value.state as string) &&
    validSnapshot(value.before) &&
    sameIdentity(value.before.identity, value.rootIdentity) &&
    (applied === undefined ||
      (record(applied) &&
        typeof applied.fingerprint === 'string' &&
        HEX64.test(applied.fingerprint) &&
        Array.isArray(applied.added) &&
        applied.added.every(validEntry))) &&
    (value.removed === undefined || (Array.isArray(value.removed) && value.removed.every(validEntry))) &&
    validIssues(value.issues)
  )
}
function validLease(value: unknown): value is WindowsLeaseRecord {
  if (!record(value) || value.version !== 1 || !record(value.owner)) return false
  const optionalId = (field: unknown) => field === undefined || (typeof field === 'string' && ID.test(field))
  return (
    typeof value.leaseId === 'string' &&
    ID.test(value.leaseId) &&
    Number.isSafeInteger(value.owner.pid) &&
    (value.owner.pid as number) > 0 &&
    text(value.owner.startId, 256) &&
    text(value.sessionExecutionId, 256) &&
    text(value.root) &&
    (value.mode === 'read-only' || value.mode === 'workspace-write') &&
    optionalId(value.workspaceGrantId) &&
    optionalId(value.tempGrantId) &&
    (value.tempPath === undefined || text(value.tempPath))
  )
}

/** `<digest>\n<json>`: the digest covers the exact body, so any edit or damage is detected. */
function frame(value: unknown): { body: string; digest: string; text: string } {
  const body = JSON.stringify(value)
  const digest = digestOf(body)
  return { body, digest, text: `${digest}\n${body}` }
}
function unframe<T>(
  raw: string,
  valid: (value: unknown) => value is T,
): { value: T; digest: string } | string {
  const newline = raw.indexOf('\n')
  if (newline !== 64) return 'record is not framed'
  const digest = raw.slice(0, 64),
    body = raw.slice(65)
  if (digestOf(body) !== digest) return 'record digest does not match its content'
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return 'record is not valid JSON'
  }
  return valid(value) ? { value, digest } : 'record has an unexpected shape'
}

type Listing<T> = Readonly<{ entries: readonly T[]; corrupt: readonly WindowsAclIssue[] }>

/**
 * The journal under the account-private state root: `grants/<grantId>`, `leases/<leaseId>` and a
 * lock file. A damaged record is reported and left exactly as found; nothing here deletes evidence.
 */
export class WindowsAclJournal {
  readonly #options: WindowsAclJournalOptions
  readonly #grants: string
  readonly #leases: string
  readonly #lock: string
  #queue: Promise<unknown> = Promise.resolve()
  #ready = false

  constructor(options: WindowsAclJournalOptions) {
    this.#options = options
    this.#grants = join(options.root, 'grants')
    this.#leases = join(options.root, 'leases')
    this.#lock = join(options.root, 'lock')
  }

  get root(): string {
    return this.#options.root
  }

  /** Proves the state root and its directories are private before any record is read or written. */
  async open(): Promise<void> {
    await this.#options.ensurePrivateDirectory(this.#options.root)
    await this.#options.ensurePrivateDirectory(this.#grants)
    await this.#options.ensurePrivateDirectory(this.#leases)
    this.#ready = true
  }

  /**
   * Runs `work` while holding the account-wide journal lock, serialized with other callers in this
   * process. A holder that is proven gone is replaced; one whose state is unknown is waited for and
   * then reported busy. Every holder starts by recovering interrupted transactions, so taking over
   * an abandoned lock never reads its unfinished work as done.
   */
  async locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      await this.open()
      const token = randomUUID()
      await this.#acquireLock(token)
      try {
        this.recoverInterrupted()
        return await work()
      } finally {
        releaseOwnerFileLock(this.#lock, token)
      }
    })
    this.#queue = run.catch(() => {})
    return run
  }

  async #acquireLock(token: string): Promise<void> {
    const { self, processIdentity, lockWaitMs } = this.#options
    const deadline = Date.now() + lockWaitMs
    for (;;) {
      if (acquireOwnerFileLock(this.#lock, { pid: self.pid, startId: self.startId, token })) return
      const holder = readLockOwner(this.#lock)
      if (holder && !(holder.pid === self.pid && holder.startId === self.startId)) {
        const identity = await processIdentity(holder.pid)
        const gone =
          identity.state === 'dead' ||
          (identity.state === 'alive' && holder.startId !== undefined && identity.startId !== holder.startId)
        if (gone) {
          takeOverOwnerFileLock(this.#lock, holder.token)
          continue
        }
      }
      if (Date.now() >= deadline)
        throw aclError('E_ACL_BUSY', 'Another AGH process is changing Windows workspace permissions')
      await delay(50)
    }
  }

  /** Under the lock, a prepared record has no live writer: it was interrupted and needs attention. */
  recoverInterrupted(): void {
    for (const { record } of this.grants().entries)
      if (record.state === 'prepared')
        this.write({
          ...record,
          state: 'needs-attention',
          issues: [
            ...record.issues,
            {
              object: record.root,
              reason: 'interrupted: the grant was not confirmed before its writer stopped',
            },
          ],
        })
  }

  grants(): Listing<WindowsGrantEntry> {
    return this.#list(this.#grants, validGrant, (value, digest) => ({ record: value, digest }))
  }

  /** The current record, or undefined when there is none; a damaged record throws E_ACL_JOURNAL_CORRUPT. */
  grant(grantId: string): WindowsGrantEntry | undefined {
    if (!ID.test(grantId)) return undefined
    const raw = this.#read(join(this.#grants, grantId))
    if (raw === undefined) return undefined
    const parsed = unframe(raw, validGrant)
    if (typeof parsed === 'string' || parsed.value.grantId !== grantId)
      throw aclError(
        'E_ACL_JOURNAL_CORRUPT',
        `Windows ACL record ${grantId} is damaged and was kept as found`,
      )
    return { record: parsed.value, digest: parsed.digest }
  }

  /** Publishes the next generation of a record and returns it once it is durable. */
  write(
    next: Omit<WindowsGrantRecord, 'generation' | 'version'> & { generation?: number },
  ): WindowsGrantEntry {
    if (!this.#ready) throw aclError('E_ACL_STATE_UNSAFE', 'The Windows ACL state root was not verified')
    const value: WindowsGrantRecord = { ...next, version: 1, generation: (next.generation ?? 0) + 1 }
    if (!validGrant(value)) throw aclError('EINVAL', 'Invalid Windows ACL record')
    const framed = frame(value)
    this.#options.files.writeDurable(join(this.#grants, value.grantId), framed.text)
    return { record: value, digest: framed.digest }
  }

  leases(): Listing<WindowsLeaseRecord> {
    return this.#list(this.#leases, validLease, (value) => value)
  }

  writeLease(lease: WindowsLeaseRecord): void {
    if (!this.#ready) throw aclError('E_ACL_STATE_UNSAFE', 'The Windows ACL state root was not verified')
    if (!validLease(lease)) throw aclError('EINVAL', 'Invalid Windows ACL lease record')
    this.#options.files.writeDurable(join(this.#leases, lease.leaseId), frame(lease).text)
  }

  removeLease(leaseId: string): void {
    this.#options.files.removeDurable(join(this.#leases, leaseId))
  }

  #read(path: string): string | undefined {
    return this.#options.files.read(path)
  }

  #list<T, R>(
    directory: string,
    valid: (value: unknown) => value is T,
    map: (value: T, digest: string) => R,
  ) {
    const entries: R[] = [],
      corrupt: WindowsAclIssue[] = []
    for (const name of this.#options.files.list(directory)) {
      // Leftovers of an interrupted publish are inert; they never replaced a record.
      if (name.endsWith('.tmp')) continue
      const path = join(directory, name)
      const raw = this.#read(path)
      if (raw === undefined) continue
      const parsed = unframe(raw, valid)
      const id =
        typeof parsed === 'string' ? undefined : (parsed.value as { grantId?: string; leaseId?: string })
      if (typeof parsed === 'string' || (id?.grantId ?? id?.leaseId) !== name)
        corrupt.push({
          object: path,
          reason: typeof parsed === 'string' ? parsed : 'record name does not match its content',
          code: 'E_ACL_JOURNAL_CORRUPT',
        })
      else entries.push(map(parsed.value, parsed.digest))
    }
    return { entries, corrupt }
  }
}

export type WindowsRestorePlan =
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{
      kind: 'remove'
      removable: readonly WindowsAclEntry[]
      /** Entries this grant added that another recorded grant on the same object still needs. */
      kept: readonly WindowsAclEntry[]
      issues: readonly WindowsAclIssue[]
    }>
  | Readonly<{ kind: 'refuse'; issues: readonly WindowsAclIssue[] }>

export const sameEntry = (a: WindowsAclEntry, b: WindowsAclEntry): boolean =>
  a.kind === b.kind && a.sid === b.sid && a.mask === b.mask && a.flags === b.flags

/**
 * Decides which entries a repair may remove from the object as it stands now. Only increments this
 * grant provably made are candidates: the allow entry names this grant's own SID; the delete-child
 * deny and the Low label count only when the confirmed result lists them as added, and stay while
 * any other unrevoked grant on the same object needs them. Changes made by anyone else are kept.
 */
export function planGrantRestore(
  grant: WindowsGrantRecord,
  current: WindowsAclSnapshot,
  others: readonly WindowsGrantRecord[],
  grantEntries: (writeSid: string) => readonly WindowsAclEntry[],
): WindowsRestorePlan {
  if (!sameIdentity(current.identity, grant.rootIdentity))
    return {
      kind: 'refuse',
      issues: [{ object: grant.root, reason: 'replaced: another directory now has this path' }],
    }
  if (current.fingerprint === grant.before.fingerprint) return { kind: 'unchanged' }
  const [allow, deny, label] = grantEntries(grant.writeSid)
  const pending = (entry: WindowsAclEntry | undefined): entry is WindowsAclEntry =>
    entry !== undefined && !(grant.removed ?? []).some((item) => sameEntry(item, entry))
  const issues: WindowsAclIssue[] = []
  if (grant.applied && current.fingerprint !== grant.applied.fingerprint)
    issues.push({
      object: current.path,
      reason: 'changed: permissions changed after the grant; they are kept',
    })
  if (!grant.applied)
    issues.push({
      object: current.path,
      reason: 'unproven: whether this grant added the delete-child deny and Low label was never recorded',
    })
  const sharing = others.some(
    (other) =>
      other.grantId !== grant.grantId &&
      other.state !== 'revoked' &&
      sameIdentity(other.rootIdentity, grant.rootIdentity),
  )
  const removable: WindowsAclEntry[] = pending(allow) ? [allow] : []
  const kept: WindowsAclEntry[] = []
  for (const entry of [deny, label]) {
    if (!pending(entry) || !grant.applied?.added.some((item) => sameEntry(item, entry))) continue
    if (sharing) kept.push(entry)
    else removable.push(entry)
  }
  return removable.length > 0 ? { kind: 'remove', removable, kept, issues } : { kind: 'refuse', issues }
}

const STEP_GROUPS: readonly (readonly [
  readonly string[],
  (root: string, record?: WindowsGrantRecord) => string,
])[] = [
  [
    [
      'interrupted',
      'unconfirmed',
      'apply-failed',
      'unverified',
      'restoring',
      'restore-refused',
      'restore-failed',
    ],
    (root, record) =>
      `Stop the AGH sessions that use ${root}, inspect it again, then repair grant ${record?.grantId ?? ''}.`,
  ],
  [
    ['changed'],
    (root) =>
      `Permissions of ${root} were changed outside AGH. Repair keeps those changes and removes only AGH's entries.`,
  ],
  [
    ['replaced', 'unreadable'],
    (root, record) =>
      `The directory AGH granted as ${root} is gone or unreadable. If it was moved, remove the allow entry for ${record?.writeSid ?? 'the grant SID'} and the Everyone "delete subfolders and files" deny and Low integrity label AGH added from it.`,
  ],
  [
    ['unproven'],
    (root) =>
      `Check ${root}: if it had no Everyone "delete subfolders and files" deny and no Low integrity label before AGH granted it, remove them (for example in its Security settings), then repair again.`,
  ],
  [['in-use'], (root) => `Close the AGH sessions that use ${root}, then repair again.`],
  [['usage-unknown'], (root) => `Another AGH process may still use ${root}; let it exit, then repair again.`],
  [['record-changed'], (root) => `Inspect ${root} again and repair with the new record digest.`],
  [
    ['corrupt', 'record is', 'record digest', 'record has', 'record name'],
    (root) =>
      `A grant record is damaged and was kept as found. Check the permissions of ${root} by hand before moving that record aside.`,
  ],
  [['shared'], (root) => `Entries another AGH grant on ${root} still needs were kept.`],
  [
    ['root-mismatch'],
    (_root, record) =>
      `Repair grant ${record?.grantId ?? ''} with the root it was made for: ${record?.root ?? ''}.`,
  ],
]

/** Concrete next steps for the issues of a report, one per kind of issue. */
export function windowsAclSteps(
  root: string,
  record: WindowsGrantRecord | undefined,
  issues: readonly WindowsAclIssue[],
): string[] {
  const steps: string[] = []
  for (const [keys, step] of STEP_GROUPS)
    if (issues.some((issue) => keys.some((key) => issue.reason.startsWith(key))))
      steps.push(step(root, record))
  return steps
}
