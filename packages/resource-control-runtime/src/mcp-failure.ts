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

/** Public status contains fixed diagnostic text, never arbitrary transport errors or stderr. */
export function mcpConnectionFailure(error: unknown): SafeError {
  let value: unknown
  try {
    value = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  } catch {
    // Transport errors are untrusted objects, including their accessors.
  }
  const code =
    value === 401 || value === 403
      ? 'MCP_AUTH_FAILED'
      : typeof value === 'string' && Object.hasOwn(MESSAGES, value)
        ? value
        : 'MCP_CONNECT_FAILED'
  return { code, message: MESSAGES[code] ?? 'MCP connection failed' }
}
