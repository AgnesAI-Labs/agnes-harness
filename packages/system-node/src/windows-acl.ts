// Windows workspace write grant: root identity, descriptor snapshots and the grant itself. The
// native side keeps each check next to the system call it guards. This layer validates input,
// refuses what it can decide without the file system, and validates what the native side returns.
//
// The grant shape (a capability allow entry, an Everyone delete-child deny and a Low no-write-up
// label) follows the write-restricted ACL backend of DeepSeek Harness
// (packages/sandbox/sandbox-windows-acl), MIT License, Copyright (c) 2026 DeepSeek; see
// native/DEEPSEEK-LICENSE.txt.
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { windowsAclBinding } from './index.js'

/** Volume serial and 128-bit file ID read from an open handle; the path is only an index. */
export type WindowsObjectIdentity = Readonly<{ volumeId: string; fileId: string }>

/** One object's security state. The fingerprint covers the identity as well as the descriptor. */
export type WindowsAclObject = Readonly<{
  path: string
  identity: WindowsObjectIdentity
  /** SDDL of the owner, group, DACL and mandatory label. */
  securityDescriptor: string
  fingerprint: string
}>

export type WindowsAclSnapshot = WindowsAclObject &
  Readonly<{
    /** Objects below the root whose descriptor inheritance alone does not determine, in full. */
    descendants: readonly WindowsAclObject[]
    /** Objects below the root that only inherit; restoring the root restores them. */
    inheritedDescendants: number
  }>

export type WindowsAclEntry = Readonly<{
  kind: 'allow' | 'deny' | 'label' | 'other'
  sid: string
  mask: number
  /** Raw ACE flags; 0x10 marks an inherited entry. */
  flags: number
}>

export type WindowsAclApply = Readonly<{
  /** Snapshot taken (and recorded by the caller) before the first change. */
  before: WindowsAclSnapshot
  grantId: string
  /** Fresh capability SID of this grant generation (S-1-4-...). */
  writeSid: string
}>

export type WindowsAclRestore = Readonly<{
  before: WindowsAclSnapshot
  grantId: string
  expectedCurrentFingerprint: string
  /** Entries this grant added that no other grant needs; nothing else is ever removed. */
  removableChanges: readonly WindowsAclEntry[]
}>

export type WindowsAclChange = Readonly<{
  path: string
  identity: WindowsObjectIdentity
  beforeFingerprint: string
  afterFingerprint: string
  added: readonly WindowsAclEntry[]
  removed: readonly WindowsAclEntry[]
}>

/**
 * Reported after a write was attempted. WRITE_FAILED: setting the root descriptor failed.
 * UNEXPECTED_RESULT: the root does not read back as planned. PROPAGATION_INCOMPLETE: an object
 * below the root lacks the propagated grant. REMOVAL_INCOMPLETE: an object still names the removed
 * write SID. VERIFY_FAILED: an object could not be read back. CHANGED: an object was replaced
 * while it was read. The others name an object found while verifying that the grant must not cover.
 */
export type WindowsAclFailureCode =
  | 'E_ACL_WRITE_FAILED'
  | 'E_ACL_UNEXPECTED_RESULT'
  | 'E_ACL_PROPAGATION_INCOMPLETE'
  | 'E_ACL_REMOVAL_INCOMPLETE'
  | 'E_ACL_VERIFY_FAILED'
  | 'E_ACL_CHANGED'
  | 'E_ACL_NULL_DACL'
  | 'E_ACL_REPARSE'
  | 'E_ACL_TOO_LARGE'

export type WindowsAclFailure = Readonly<{
  path: string
  identity?: WindowsObjectIdentity
  code: WindowsAclFailureCode
  win32Code?: number
}>

/** Actual state after a write: `complete` is true only when every check passed. */
export type WindowsAclMutation = Readonly<{
  grantId: string
  complete: boolean
  changes: readonly WindowsAclChange[]
  failures: readonly WindowsAclFailure[]
  inheritedDescendants: number
}>

const GRANT_MASK = 0x110156
const ENTRY_KINDS = new Set(['allow', 'deny', 'label', 'other'])
const FAILURE_CODES = new Set<string>([
  'E_ACL_WRITE_FAILED',
  'E_ACL_UNEXPECTED_RESULT',
  'E_ACL_PROPAGATION_INCOMPLETE',
  'E_ACL_REMOVAL_INCOMPLETE',
  'E_ACL_VERIFY_FAILED',
  'E_ACL_CHANGED',
  'E_ACL_NULL_DACL',
  'E_ACL_REPARSE',
  'E_ACL_TOO_LARGE',
])
const MAX_RECORDED = 100_000
const MAX_DESCRIPTOR = 1_048_576

const invalid = (message: string): TypeError => Object.assign(new TypeError(message), { code: 'EINVAL' })
const malformed = (): Error =>
  Object.assign(new Error('Windows ACL native result is malformed; rebuild the native artifact'), {
    code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
  })
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)

function drivePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 32_000 &&
    !path.includes('\0') &&
    /^[A-Za-z]:[\\/]/.test(path) &&
    !path.slice(2).includes(':')
  )
}

/** The namespaced form the native side opens; a drive root never carries a grant. */
function rootPath(path: unknown): string {
  if (!drivePath(path)) throw invalid('Expected an absolute Windows drive path')
  const resolved = win32.resolve(path)
  if (/^[A-Za-z]:\\$/.test(resolved))
    throw Object.assign(new Error('A drive root cannot carry a workspace grant'), {
      code: 'E_ACL_DRIVE_ROOT',
    })
  return `\\\\?\\${resolved}`
}

function identityOf(volumeId: unknown, fileId: unknown): WindowsObjectIdentity {
  if (!hex(volumeId, 16) || !hex(fileId, 32)) throw invalid('Invalid Windows object identity')
  return Object.freeze({ volumeId, fileId })
}

function writeSidOf(value: unknown): string {
  const parts = typeof value === 'string' ? /^S-1-4((?:-(?:0|[1-9]\d{0,9})){1,15})$/.exec(value) : null
  if (
    !parts?.[1] ||
    parts[1]
      .slice(1)
      .split('-')
      .some((part) => Number(part) > 0xffffffff)
  )
    throw invalid('Expected a capability SID of the form S-1-4-...')
  return value as string
}

export function windowsAclFingerprint(identity: WindowsObjectIdentity, securityDescriptor: string): string {
  const { volumeId, fileId } = identityOf(identity?.volumeId, identity?.fileId)
  if (
    typeof securityDescriptor !== 'string' ||
    !securityDescriptor ||
    securityDescriptor.length > MAX_DESCRIPTOR ||
    securityDescriptor.includes('\0')
  )
    throw invalid('Invalid Windows security descriptor')
  const text = `agnes-windows-acl-v1\n${volumeId}\n${fileId}\n${securityDescriptor}`
  return createHash('sha256').update(Buffer.from(text, 'utf16le')).digest('hex')
}

/** The three entries a grant adds to its root: capability allow, delete-child deny, Low label. */
export function windowsAclGrantEntries(writeSid: string): readonly WindowsAclEntry[] {
  return Object.freeze([
    Object.freeze({ kind: 'allow', sid: writeSidOf(writeSid), mask: GRANT_MASK, flags: 0x03 } as const),
    Object.freeze({ kind: 'deny', sid: 'S-1-1-0', mask: 0x40, flags: 0x02 } as const),
    Object.freeze({ kind: 'label', sid: 'S-1-16-4096', mask: 0x01, flags: 0x03 } as const),
  ])
}

function aclObject(value: unknown): WindowsAclObject {
  if (!record(value) || !drivePath(value.path) || typeof value.fingerprint !== 'string')
    throw invalid('Invalid Windows ACL object')
  const identity = identityOf(
    record(value.identity) && value.identity.volumeId,
    record(value.identity) && value.identity.fileId,
  )
  const securityDescriptor = value.securityDescriptor as string
  if (windowsAclFingerprint(identity, securityDescriptor) !== value.fingerprint)
    throw invalid('Windows ACL fingerprint does not match its object')
  return Object.freeze({ path: value.path, identity, securityDescriptor, fingerprint: value.fingerprint })
}

function snapshotOf(value: unknown): WindowsAclSnapshot {
  if (!record(value)) throw invalid('Invalid Windows ACL snapshot')
  const root = aclObject(value)
  const { descendants, inheritedDescendants } = value
  if (
    !Array.isArray(descendants) ||
    descendants.length > MAX_RECORDED ||
    typeof inheritedDescendants !== 'number' ||
    !Number.isSafeInteger(inheritedDescendants) ||
    inheritedDescendants < 0
  )
    throw invalid('Invalid Windows ACL snapshot')
  const seen = new Set([`${root.identity.volumeId}:${root.identity.fileId}`])
  const objects = descendants.map((item) => {
    const object = aclObject(item)
    const key = `${object.identity.volumeId}:${object.identity.fileId}`
    if (seen.has(key)) throw invalid('Windows ACL snapshot lists an object twice')
    seen.add(key)
    return object
  })
  return Object.freeze({ ...root, descendants: Object.freeze(objects), inheritedDescendants })
}

function grantIdOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    throw invalid('Invalid Windows ACL grant ID')
  return value
}

/**
 * Snapshot of a workspace root by identity; refuses roots a grant could not later restore. Throws
 * without changing anything: EINVAL, E_ACL_DRIVE_ROOT, E_ACL_REPARSE (the root, an ancestor, or a
 * link below it that leads outside), E_ACL_UNSUPPORTED_VOLUME (anything but local NTFS),
 * E_ACL_NULL_DACL, E_ACL_TOO_LARGE, errno-style codes with `win32Code` for system failures (EACCES
 * when a right is missing), and ENOSYS off Windows.
 */
export function inspectWindowsAcl(path: string): WindowsAclSnapshot {
  const target = rootPath(path)
  const raw = windowsAclBinding().inspect(target)
  try {
    if (!record(raw)) throw malformed()
    return snapshotOf({
      ...raw,
      identity: { volumeId: raw.volumeId, fileId: raw.fileId },
      descendants: Array.isArray(raw.descendants)
        ? raw.descendants.map((item: unknown) =>
            record(item) ? { ...item, identity: { volumeId: item.volumeId, fileId: item.fileId } } : item,
          )
        : raw.descendants,
    })
  } catch {
    throw malformed()
  }
}

/**
 * Adds the grant entries after proving the root and recorded descendants still match `before`.
 * Besides the inspection refusals it refuses, before any write: E_ACL_IDENTITY_MISMATCH (another
 * directory now has the path), E_ACL_CHANGED (permissions changed since `before`), E_ACL_BUSY,
 * E_ACL_SID_IN_USE and E_ACL_LABEL_CONFLICT. Once the write is attempted the result reports the
 * actual state instead; if the call still throws, check the state against `before`.
 */
export function applyWindowsAclGrant(input: WindowsAclApply): WindowsAclMutation {
  if (!record(input)) throw invalid('Invalid Windows ACL grant')
  const before = snapshotOf(input.before)
  const grantId = grantIdOf(input.grantId)
  const writeSid = writeSidOf(input.writeSid)
  const target = rootPath(before.path)
  const evidence = before.descendants.map(
    ({ identity, fingerprint }) => `${identity.volumeId}:${identity.fileId}:${fingerprint}`,
  )
  const raw = windowsAclBinding().apply(
    target,
    before.identity.volumeId,
    before.identity.fileId,
    before.fingerprint,
    evidence,
    writeSid,
  )
  return mutationOf(raw, grantId)
}

/**
 * Removes exactly the listed grant entries once the root still reads `expectedCurrentFingerprint`;
 * refuses like a grant, with E_ACL_CHANGED when an entry to remove is no longer there exactly.
 */
export function restoreWindowsAclGrant(input: WindowsAclRestore): WindowsAclMutation {
  if (!record(input)) throw invalid('Invalid Windows ACL restore')
  const before = snapshotOf(input.before)
  const grantId = grantIdOf(input.grantId)
  if (!hex(input.expectedCurrentFingerprint, 64)) throw invalid('Invalid expected Windows ACL fingerprint')
  const removal = removalOf(input.removableChanges)
  const target = rootPath(before.path)
  const raw = windowsAclBinding().restore(
    target,
    before.identity.volumeId,
    before.identity.fileId,
    input.expectedCurrentFingerprint,
    removal.allowSid,
    removal.deny,
    removal.label,
  )
  return mutationOf(raw, grantId)
}

function removalOf(value: unknown): { allowSid: string; deny: boolean; label: boolean } {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3)
    throw invalid('Expected the grant entries to remove')
  const removal = { allowSid: '', deny: false, label: false }
  const kinds = new Set<unknown>()
  const [allow, deny, label] = windowsAclGrantEntries('S-1-4-1')
  const shaped = (entry: Record<string, unknown>, shape: WindowsAclEntry | undefined) =>
    shape !== undefined &&
    entry.kind === shape.kind &&
    entry.mask === shape.mask &&
    entry.flags === shape.flags
  for (const entry of value) {
    if (!record(entry) || kinds.has(entry.kind)) throw invalid('Invalid removable Windows ACL entry')
    kinds.add(entry.kind)
    if (shaped(entry, allow)) removal.allowSid = writeSidOf(entry.sid)
    else if (shaped(entry, deny) && entry.sid === deny?.sid) removal.deny = true
    else if (shaped(entry, label) && entry.sid === label?.sid) removal.label = true
    else throw invalid('Only the exact entries a grant adds can be removed')
  }
  return removal
}

function entryOf(value: unknown): WindowsAclEntry {
  if (
    !record(value) ||
    typeof value.kind !== 'string' ||
    !ENTRY_KINDS.has(value.kind) ||
    typeof value.sid !== 'string' ||
    value.sid.length > 256 ||
    typeof value.mask !== 'number' ||
    !Number.isInteger(value.mask) ||
    value.mask < 0 ||
    value.mask > 0xffffffff ||
    typeof value.flags !== 'number' ||
    !Number.isInteger(value.flags) ||
    value.flags < 0 ||
    value.flags > 0xff
  )
    throw malformed()
  return Object.freeze({
    kind: value.kind as WindowsAclEntry['kind'],
    sid: value.sid,
    mask: value.mask,
    flags: value.flags,
  })
}

function entriesOf(value: unknown): readonly WindowsAclEntry[] {
  if (!Array.isArray(value)) throw malformed()
  return Object.freeze(value.map(entryOf))
}

function changeOf(value: unknown): WindowsAclChange {
  if (
    !record(value) ||
    !drivePath(value.path) ||
    !hex(value.beforeFingerprint, 64) ||
    !hex(value.afterFingerprint, 64)
  )
    throw malformed()
  return Object.freeze({
    path: value.path,
    identity: identityOf(value.volumeId, value.fileId),
    beforeFingerprint: value.beforeFingerprint,
    afterFingerprint: value.afterFingerprint,
    added: entriesOf(value.added),
    removed: entriesOf(value.removed),
  })
}

function failureOf(value: unknown): WindowsAclFailure {
  if (
    !record(value) ||
    !drivePath(value.path) ||
    typeof value.code !== 'string' ||
    !FAILURE_CODES.has(value.code) ||
    typeof value.win32Code !== 'number' ||
    !Number.isInteger(value.win32Code) ||
    value.win32Code < 0 ||
    value.win32Code > 0xffffffff
  )
    throw malformed()
  const known = value.volumeId !== '' || value.fileId !== ''
  return Object.freeze({
    path: value.path,
    ...(known ? { identity: identityOf(value.volumeId, value.fileId) } : {}),
    code: value.code as WindowsAclFailureCode,
    ...(value.win32Code ? { win32Code: value.win32Code } : {}),
  })
}

function mutationOf(raw: unknown, grantId: string): WindowsAclMutation {
  try {
    if (
      !record(raw) ||
      typeof raw.complete !== 'boolean' ||
      !Array.isArray(raw.changes) ||
      !Array.isArray(raw.failures) ||
      typeof raw.inheritedDescendants !== 'number' ||
      !Number.isSafeInteger(raw.inheritedDescendants) ||
      raw.inheritedDescendants < 0
    )
      throw malformed()
    const failures = Object.freeze(raw.failures.map(failureOf))
    return Object.freeze({
      grantId,
      // A listed failure always wins over the native flag: partial success is never reported complete.
      complete: raw.complete && failures.length === 0,
      changes: Object.freeze(raw.changes.map(changeOf)),
      failures,
      inheritedDescendants: raw.inheritedDescendants,
    })
  } catch {
    throw malformed()
  }
}
