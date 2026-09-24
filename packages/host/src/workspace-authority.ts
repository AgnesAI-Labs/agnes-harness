import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

declare const workspaceBindingBrand: unique symbol

/** Nominal Host authority. Structural lookalikes are rejected by assertWorkspaceBinding(). */
export type WorkspaceBinding = Readonly<{
  sessionKey: string
  workspaceId: string
  authorityRevision: number
  canonicalRoot: string
  readonly [workspaceBindingBrand]: true
}>

export type AuthenticatedWorkspaceBindingEnvelope = Readonly<{
  version: 1
  sessionKey: string
  workspaceId: string
  revision: number
  canonicalRoot: string
}>

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

function issue(input: {
  sessionKey: string
  workspaceId: string
  authorityRevision: number
  canonicalRoot: string
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
    })
  }
}

/** Fork inheritance can change only the session key; root and authority revision stay identical. */
export function inheritWorkspaceBinding(parent: WorkspaceBinding, childSessionKey: string): WorkspaceBinding {
  assertWorkspaceBinding(parent)
  return issue({
    sessionKey: checkedSessionKey(childSessionKey),
    workspaceId: parent.workspaceId,
    authorityRevision: parent.authorityRevision,
    canonicalRoot: parent.canonicalRoot,
  })
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
    })
  }
}
