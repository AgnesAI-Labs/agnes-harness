import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

declare const workspaceBindingBrand: unique symbol

/** Nominal Host authority. Structural lookalikes are rejected by assertWorkspaceBinding(). */
export type WorkspaceBinding = Readonly<{
  sessionKey: string
  workspaceId: string
  authorityRevision: number
  canonicalRoot: string
  /** Canonical extra directories admitted into this session's file fence; empty when none. */
  extraRoots: readonly string[]
  readonly [workspaceBindingBrand]: true
}>

export type AuthenticatedWorkspaceBindingEnvelope = Readonly<{
  version: 1
  sessionKey: string
  workspaceId: string
  revision: number
  canonicalRoot: string
  /** Absent on bindings written before extra directories existed: no extra directories. */
  extraRoots?: readonly string[]
}>

/** Most extra directories one session may carry. */
export const MAX_EXTRA_ROOTS = 8

const issued = new WeakSet<object>()

const fault = (reason: string): Error & { code: 'E_WORKSPACE_UNTRUSTED' } =>
  Object.assign(new Error(`E_WORKSPACE_UNTRUSTED: ${reason}`), {
    code: 'E_WORKSPACE_UNTRUSTED' as const,
  })

function checkedSessionKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw fault('invalid workspace session key')
  return value
}

function checkedRoot(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw fault('invalid canonical workspace root')
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  const api = windows ? win32 : posix
  if (!api.isAbsolute(value) || api.normalize(value) !== value)
    throw fault('workspace root is not canonical and absolute')
  return value
}

function checkedExtraRoots(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_EXTRA_ROOTS) throw fault('invalid extra directories')
  const roots = value.map(checkedRoot)
  if (new Set(roots).size !== roots.length) throw fault('duplicate extra directory')
  return Object.freeze(roots)
}

function issue(input: {
  sessionKey: string
  workspaceId: string
  authorityRevision: number
  canonicalRoot: string
  extraRoots: readonly string[]
}): WorkspaceBinding {
  const binding = Object.freeze({ ...input }) as WorkspaceBinding
  issued.add(binding)
  return binding
}

export function assertWorkspaceBinding(value: unknown): asserts value is WorkspaceBinding {
  if (!value || typeof value !== 'object' || !issued.has(value as object))
    throw fault('workspace binding was not issued by a Host authority')
}

/** Decoder owned by the authenticated worker-control boundary, never by public RPC input. */
export class WorkspaceBindingAuthority {
  accept(envelope: AuthenticatedWorkspaceBindingEnvelope, expectedSessionKey: string): WorkspaceBinding {
    const sessionKey = checkedSessionKey(expectedSessionKey)
    if (!envelope || typeof envelope !== 'object' || envelope.version !== 1)
      throw fault('invalid authenticated workspace binding')
    if (checkedSessionKey(envelope.sessionKey) !== sessionKey)
      throw fault('workspace binding belongs to another session')
    if (typeof envelope.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.workspaceId))
      throw fault('invalid workspace authority id')
    if (!Number.isSafeInteger(envelope.revision) || envelope.revision < 1)
      throw fault('invalid workspace authority revision')
    return issue({
      sessionKey,
      workspaceId: envelope.workspaceId,
      authorityRevision: envelope.revision,
      canonicalRoot: checkedRoot(envelope.canonicalRoot),
      extraRoots: checkedExtraRoots(envelope.extraRoots),
    })
  }
}

/** Whether two bindings grant the same authority: key, workspace, revision, root and extra roots. */
export function sameWorkspaceBindingAuthority(left: WorkspaceBinding, right: WorkspaceBinding): boolean {
  return (
    left.sessionKey === right.sessionKey &&
    left.workspaceId === right.workspaceId &&
    left.authorityRevision === right.authorityRevision &&
    left.canonicalRoot === right.canonicalRoot &&
    left.extraRoots.length === right.extraRoots.length &&
    left.extraRoots.every((root, index) => root === right.extraRoots[index])
  )
}

/** Fork inheritance can change only the session key; root and authority revision stay identical. */
export function inheritWorkspaceBinding(parent: WorkspaceBinding, childSessionKey: string): WorkspaceBinding {
  assertWorkspaceBinding(parent)
  return issue({
    sessionKey: checkedSessionKey(childSessionKey),
    workspaceId: parent.workspaceId,
    authorityRevision: parent.authorityRevision,
    canonicalRoot: parent.canonicalRoot,
    extraRoots: parent.extraRoots,
  })
}

/**
 * Whether `child` is `parent` grown by extra directories the daemon admitted: the child's own key (`childSessionKey`),
 * the same workspace, revision and root, and the parent's extra roots kept in their order inside a strictly
 * longer child list. The daemon keeps the list sorted, so a new root may land between old ones; a
 * prefix test would refuse that. Dropping, reordering or swapping a root, or any other change, is
 * not an extension. Both bindings must be Host-issued; the new roots passed that check on issue.
 */
export function extendsWorkspaceBinding(
  parent: WorkspaceBinding,
  child: WorkspaceBinding,
  childSessionKey: string,
): boolean {
  assertWorkspaceBinding(parent)
  assertWorkspaceBinding(child)
  return (
    child.sessionKey === childSessionKey &&
    child.workspaceId === parent.workspaceId &&
    child.authorityRevision === parent.authorityRevision &&
    child.canonicalRoot === parent.canonicalRoot &&
    child.extraRoots.length > parent.extraRoots.length &&
    isSubsequence(parent.extraRoots, child.extraRoots)
  )
}

/** Every item of `part` appears in `whole`, in the same relative order. */
function isSubsequence(part: readonly string[], whole: readonly string[]): boolean {
  let next = 0
  for (const item of whole) if (item === part[next]) next++
  return next === part.length
}

/** CLI in-process authority is permanently restricted to the one canonical startup root. */
export class CliWorkspaceAuthority {
  readonly canonicalRoot: string
  readonly workspaceId: string

  constructor(canonicalRoot: string) {
    this.canonicalRoot = checkedRoot(canonicalRoot)
    this.workspaceId = createHash('sha256').update(this.canonicalRoot).digest('hex')
  }

  bind(sessionKey: string, requestedRoot: string = this.canonicalRoot): WorkspaceBinding {
    if (checkedRoot(requestedRoot) !== this.canonicalRoot)
      throw fault('CLI workspace differs from the canonical startup root')
    return issue({
      sessionKey: checkedSessionKey(sessionKey),
      workspaceId: this.workspaceId,
      authorityRevision: 1,
      canonicalRoot: this.canonicalRoot,
      extraRoots: Object.freeze([]),
    })
  }
}
