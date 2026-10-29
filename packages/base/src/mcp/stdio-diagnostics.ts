import type { Stream } from 'node:stream'

const MESSAGES: Record<string, string> = {
  MCP_STDIO_ENV_MISSING: 'The local launcher requires an environment variable unavailable to MCP.',
  MCP_STDIO_RUNTIME_UNAVAILABLE: 'The local runtime or one of its modules could not be loaded.',
  MCP_STDIO_ACCESS_DENIED: 'The local process reported denied file or sandbox access.',
  MCP_STDIO_NETWORK_FAILED: 'The local process reported a network or name resolution failure.',
  MCP_STDIO_CLOSED: 'The local process closed before completing the MCP handshake.',
  MCP_CONNECT_TIMEOUT: 'MCP connection timed out.',
}
const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['MCP_STDIO_ENV_MISSING', /\b[A-Z][A-Z0-9_]{2,63} (?:is not set|is required|must be set)\b/],
  ['MCP_STDIO_ACCESS_DENIED', /\b(?:EACCES|EPERM)\b|Operation not permitted|Permission denied/i],
  ['MCP_STDIO_NETWORK_FAILED', /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH)\b/],
  [
    'MCP_STDIO_RUNTIME_UNAVAILABLE',
    /Cannot find (?:module|package)|command not found|env:.*No such file|Library not loaded/i,
  ],
]

/** Drain stderr without forwarding it. Retain only a bounded scan window and a fixed category. */
export function observeStdioStartup(stderr?: Pick<Stream, 'on'> | null) {
  let remaining = 64 * 1024
  let tail = ''
  let code: string | undefined
  stderr?.on('data', (chunk: Buffer | string) => {
    if (!remaining || code) return
    const text =
      typeof chunk === 'string' ? chunk.slice(0, remaining) : chunk.subarray(0, remaining).toString('utf8')
    remaining = Math.max(0, remaining - Buffer.byteLength(text))
    const window = tail + text
    code = PATTERNS.find(([, pattern]) => pattern.test(window))?.[0]
    tail = code || !remaining ? '' : window.slice(-256)
  })
  // Drain after the handshake too; a verbose child must never block on a full stderr pipe.
  stderr?.on('error', () => undefined)
  return {
    settled() {
      remaining = 0
      tail = ''
    },
    failure(error: unknown): Error {
      let systemCode: unknown
      try {
        systemCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      } catch {
        // A rejected value may have hostile accessors.
      }
      const category =
        code ??
        (systemCode === 'ENOENT'
          ? 'MCP_STDIO_RUNTIME_UNAVAILABLE'
          : systemCode === 'EACCES' || systemCode === 'EPERM'
            ? 'MCP_STDIO_ACCESS_DENIED'
            : systemCode === 'MCP_CONNECT_TIMEOUT'
              ? 'MCP_CONNECT_TIMEOUT'
              : 'MCP_STDIO_CLOSED')
      return Object.assign(new Error(MESSAGES[category]), { code: category })
    },
  }
}
