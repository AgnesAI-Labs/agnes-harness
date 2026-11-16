import type { ConnectionState } from '@agnes/daemon-foundation/local/endpoint'
import { parseSessionEnvironment, rpcError, type SessionEnvironment } from '@agnes/protocol'

/** Where a session's environment is kept: the profile's session records, read by the Host on every command. */
export type SessionEnvironmentRecords = Readonly<{
  write(sessionKey: string, environment: SessionEnvironment): void
  release(sessionKey: string): void
}>

/**
 * `session/new` and session opening `environment`: the session's own environment, which only the bundled
 * application's client may give, for the sessions it opens (see `ConnectionState.bundledApp`). Any other caller, a
 * plugin, the Web page, the owner's own client or another SDK user, is refused with `SESSION_ENVIRONMENT_DENIED`
 * before the value is looked at; an invalid value is `SESSION_ENVIRONMENT_INVALID`.
 */
export function admitSessionEnvironment(
  value: unknown,
  conn: ConnectionState,
  records: SessionEnvironmentRecords | undefined,
): SessionEnvironment | undefined {
  if (value === undefined) return undefined
  if (conn.bundledApp !== true)
    throw rpcError('CAPABILITY_DENIED', {
      code: 'SESSION_ENVIRONMENT_DENIED',
      reason: "a session environment is accepted only from the bundled application's client",
    })
  if (!records)
    throw rpcError('CAPABILITY_DENIED', {
      code: 'SESSION_ENVIRONMENT_UNAVAILABLE',
      reason: 'this daemon keeps no session environments',
    })
  try {
    return parseSessionEnvironment(value)
  } catch (error) {
    throw rpcError('SEMANTIC_REJECTED', {
      code: 'SESSION_ENVIRONMENT_INVALID',
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}
