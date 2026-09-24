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
