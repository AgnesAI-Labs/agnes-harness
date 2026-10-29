/** Parse command tokens without invoking a shell; quoted whitespace is preserved. */
export function parseMcpCommand(command: string): string[] {
  const tokens: string[] = []
  let token = '',
    quote = '',
    started = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (char === '\\' && ['\\', '"', "'", ' '].includes(command[index + 1] ?? '') && quote !== "'") {
      token += command[++index]
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
    } else {
      token += char
      started = true
    }
  }
  if (quote) throw new Error('Unclosed quote')
  if (started) tokens.push(token)
  return tokens
}
export function formatMcpCommand(tokens: string[]): string {
  return tokens
    .map((token) => (!token || /[\s"'\\]/.test(token) ? '"' + token.replace(/["\\]/g, '\\$&') + '"' : token))
    .join(' ')
}

const LAUNCHERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'pnpm', 'yarn', 'bun', 'uv', 'npm'])
const VERBS = new Set(['dlx', 'exec', 'run', 'x', 'tool'])
const GENERIC = new Set(['mcp', 'server', 'mcp-server', 'server-mcp'])
const tidy = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * A short name for a server, read from what the user pasted: the package or program of a local
 * command, or the service part of a remote address. Empty when nothing usable is there yet.
 */
export function deriveMcpName(kind: 'stdio' | 'remote', value: string): string {
  if (kind === 'remote') {
    let host: string
    try {
      host = new URL(value.trim()).hostname
    } catch {
      return ''
    }
    if (/^[\d.]+$/.test(host) || host.includes(':')) return tidy(host)
    const labels = host.split('.').filter((label) => !['www', 'mcp', 'api'].includes(label))
    // `mcp.example.com` is "example"; a bare host such as `localhost` is itself.
    return tidy(labels.length > 1 ? labels[labels.length - 2]! : (labels[0] ?? host))
  }
  let tokens: string[]
  try {
    tokens = parseMcpCommand(value)
  } catch {
    return ''
  }
  const first = tokens[0]?.split(/[\\/]/).pop() ?? ''
  const program = LAUNCHERS.has(first)
    ? tokens.slice(1).find((token) => !token.startsWith('-') && !VERBS.has(token))
    : tokens[0]
  if (!program) return ''
  const scoped = /^@([^/]+)\/([^@]+)/.exec(program)
  const bare = (scoped ? scoped[2]! : (program.split(/[\\/]/).pop() ?? program)).replace(/@[^@]*$/, '')
  const name = tidy(bare.replace(/\.(?:m?js|py|exe|sh)$/i, ''))
  if (scoped && GENERIC.has(name)) return tidy(scoped[1]!)
  return name.replace(/^(?:mcp-server|server-mcp|mcp|server)-|-(?:mcp-server|mcp|server)$/g, '') || name
}
