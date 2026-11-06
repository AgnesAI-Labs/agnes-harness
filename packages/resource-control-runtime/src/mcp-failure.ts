import type { SafeError } from '@agnes/protocol'

const MESSAGES: Readonly<Record<string, string>> = {
  MCP_STDIO_ENV_MISSING:
    'The local launcher needs an environment variable unavailable to MCP. Check its runtime installation.',
  MCP_STDIO_RUNTIME_UNAVAILABLE:
    'The local executable, runtime or module could not be loaded. Check the installed runtime and sandbox file access.',
  MCP_STDIO_ACCESS_DENIED:
    'The local process reported denied access. Check file permissions and its sandbox profile.',
  MCP_STDIO_NETWORK_FAILED:
    'The local process reported a network failure. Check network access and the sandbox profile.',
  MCP_STDIO_CLOSED:
    'The local process closed before the MCP handshake. Check its command, runtime, credentials and sandbox profile.',
  MCP_CONNECT_TIMEOUT: 'MCP connection timed out. Check the service and network.',
  MCP_AUTH_FAILED: 'MCP authentication was rejected. Check the saved credential and its binding.',
  E_MCP_SANDBOX_UNAVAILABLE:
    'No usable stdio sandbox is available. Configure a working sandbox before retrying.',
  MCP_CONNECT_FAILED: 'MCP connection failed',
}

const SIGN_IN_MESSAGES: Readonly<Record<string, string>> = {
  'insufficient-scope': 'MCP server needs more permissions; sign in again',
  'endpoint-changed': 'MCP server address changed since sign-in; sign in again',
}
const NEEDS_SIGN_IN = 'MCP server needs sign-in'

/** Reads one property of an untrusted transport error, including its accessors. */
function field(error: unknown, name: 'code' | 'reason'): unknown {
  try {
    return error && typeof error === 'object' && name in error
      ? (error as Record<string, unknown>)[name]
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Public status contains fixed diagnostic text, never arbitrary transport errors or stderr.
 *
 * `bindingKind` is the server's secret binding. A server with none that answers 401 or 403 asks
 * for sign-in; an OAuth server still answering 401 after its one refresh needs sign-in again; a
 * saved bearer or header credential that is refused stays an authentication failure.
 */
export function mcpConnectionFailure(error: unknown, bindingKind?: string): SafeError {
  const value = field(error, 'code')
  if (value === 'MCP_OAUTH_NEEDS_RECONNECT') {
    const reason = field(error, 'reason')
    const message = typeof reason === 'string' ? SIGN_IN_MESSAGES[reason] : undefined
    return { code: 'MCP_OAUTH_NEEDS_RECONNECT', message: message ?? NEEDS_SIGN_IN }
  }
  if ((value === 401 || value === 403) && bindingKind === 'none')
    return { code: 'MCP_AUTH_REQUIRED', message: 'MCP server requires sign-in' }
  if (value === 401 && bindingKind === 'oauth')
    return { code: 'MCP_OAUTH_NEEDS_RECONNECT', message: NEEDS_SIGN_IN }
  const code =
    value === 401 || value === 403
      ? 'MCP_AUTH_FAILED'
      : typeof value === 'string' && Object.hasOwn(MESSAGES, value)
        ? value
        : 'MCP_CONNECT_FAILED'
  return { code, message: MESSAGES[code] ?? 'MCP connection failed' }
}
