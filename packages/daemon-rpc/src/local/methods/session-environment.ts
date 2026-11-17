import type { ConnectionState } from '@agnes/daemon-foundation/local/endpoint'
import { parseSessionEnvironment, rpcError, type SessionEnvironment } from '@agnes/protocol'

/** Where session environments are kept, and which sessions the bundled application may give one. */
export type SessionEnvironmentAuthority = Readonly<{
  /** Whether `sessionKey` names one of the bundled application's own sessions. */
  owns(sessionKey: string): boolean
  /** Keeps the environment for the session; its next command runs with it. */
  write(sessionKey: string, environment: SessionEnvironment): Promise<void>
  release(sessionKey: string): Promise<void>
}>

const denied = (reason: string) =>
  rpcError('CAPABILITY_DENIED', { code: 'SESSION_ENVIRONMENT_DENIED', reason })

/**
 * `session/new` and session opening `environment`: the session's own environment, which only the bundled
 * application's client may give, and only for its own sessions (see `ConnectionState.bundledApp` and
 * `SessionEnvironmentAuthority.owns`). Any other caller, a plugin, the Web page, the owner's own client or another SDK
 * user, and any other session key, is refused with `SESSION_ENVIRONMENT_DENIED` before the value is looked at; an
 * invalid value is `SESSION_ENVIRONMENT_INVALID`.
 */
export function admitSessionEnvironment(
  value: unknown,
  conn: ConnectionState,
  authority: SessionEnvironmentAuthority | undefined,
  sessionKey: string,
): SessionEnvironment | undefined {
  if (value === undefined) return undefined
  if (conn.bundledApp !== true)
    throw denied("a session environment is accepted only from the bundled application's client")
  if (!authority)
    throw rpcError('CAPABILITY_DENIED', {
      code: 'SESSION_ENVIRONMENT_UNAVAILABLE',
      reason: 'this daemon keeps no session environments',
    })
  if (!authority.owns(sessionKey))
    throw denied("a session environment is accepted only for the bundled application's own sessions")
  try {
    return parseSessionEnvironment(value)
  } catch (error) {
    throw rpcError('SEMANTIC_REJECTED', {
      code: 'SESSION_ENVIRONMENT_INVALID',
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}
