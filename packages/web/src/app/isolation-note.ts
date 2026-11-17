import type { SessionRuntimeDescriptor } from '@agnes/protocol'

type Sandbox = NonNullable<SessionRuntimeDescriptor['policy']>['sandbox']

/** One session's command isolation as its runtime reports it. */
export type SessionIsolation = Readonly<{ sessionId: string; disabled: boolean; boundary?: true }>

/**
 * The local session's own answer: the Windows partial contract, no OS isolation, or a full boundary.
 * Another provider keeps its own contract and says nothing here.
 */
export function sessionIsolationOf(
  sessionId: string,
  sandbox: Pick<Sandbox, 'provider' | 'enforcement'> | undefined,
): SessionIsolation | undefined {
  if (sandbox?.provider !== 'local' || !sandbox.enforcement) return undefined
  const { enforcement } = sandbox
  if (enforcement.boundary) return { sessionId, disabled: false, boundary: true }
  return {
    sessionId,
    disabled: enforcement.level !== 'full' && !enforcement.scope.includes('process'),
  }
}

/**
 * The note beside the permission picker. A session whose runtime is known is described by its own
 * enforcement; on Windows an unknown or unconfined one keeps the cautious platform note.
 */
export function isolationNoteKey(input: {
  connected: boolean
  os: string | undefined
  draftingNew: boolean
  currentId: string | undefined
  isolation?: SessionIsolation | undefined
}): string | undefined {
  if (!input.connected) return undefined
  const own =
    !input.draftingNew && input.isolation?.sessionId === input.currentId ? input.isolation : undefined
  if (input.os === 'win32') {
    if (own?.boundary) return 'session.runtime.windowsAclIsolation'
    return own && !own.disabled ? undefined : 'session.runtime.platformNoCommandIsolation'
  }
  return own?.disabled ? 'session.runtime.noOsIsolation' : undefined
}
