/**
 * One MCP server's connection settings, as `connectMcp` and `registerRemoteToolsStrict` consume them.
 * Built only from a resource-control definition (`resolvedConfig` in @agnes/resource-control-runtime,
 * `mcpServerConfigFromDefinition` in the mcp-server extension); the old profile-preset reader is gone
 * (design 2026-09-21-resource-rows-design.md D113).
 */
export type McpServerConfig = {
  id: string
  /** 'sse' is the legacy pre-2025-03-26 remote transport; resolvedConfig() builds it directly. */
  transport: 'stdio' | 'http' | 'sse'
  cmd?: string[]
  cwd?: string
  workspacePath?: string
  sandboxProfile?: 'strict' | 'workspace-write' | 'network' | 'off-with-warning'
  url?: string
  /** Fixed Host-supplied minimum process environment. Managed definitions never populate it. */
  baseEnv?: Record<string, string>
  /** Resolved only at the Host connection boundary; never serialized into resource status. */
  env?: Record<string, string>
  /** Resolved HTTP credentials; never returned from an MCP runtime snapshot. */
  headers?: Record<string, string>
  /** Managed server policy is enforced before registration and invocation. */
  allowedTools?: readonly string[]
  defer: boolean
}

/** Longest secrets first, so a shorter prefix of the same value cannot survive redaction. */
export function mcpSecretValues(cfg: McpServerConfig): string[] {
  return [...Object.values(cfg.env ?? {}), ...Object.values(cfg.headers ?? {})]
    .flatMap((value) => (value.startsWith('Bearer ') ? [value, value.slice('Bearer '.length)] : [value]))
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)
}

export function redactMcpSecrets(value: string, cfg: McpServerConfig): string {
  let redacted = value
  for (const secret of mcpSecretValues(cfg)) redacted = redacted.replaceAll(secret, '[REDACTED]')
  return redacted
}

/** A single-line, secret-free message. Untrusted errors must not be able to throw during formatting. */
export function mcpErrorText(error: unknown, cfg?: McpServerConfig): string {
  let message = 'unknown failure'
  try {
    message = String(error instanceof Error ? error.message : error)
  } catch {
    // Untrusted transports may reject with objects whose coercion throws.
  }
  if (cfg) message = redactMcpSecrets(message, cfg)
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1024)
}
