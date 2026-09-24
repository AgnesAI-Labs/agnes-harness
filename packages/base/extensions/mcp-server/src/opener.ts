import type { McpServerDefinitionInput } from '@agnes/protocol'
import type { McpServerConfig } from '../../../src/mcp/config.js'
import type { McpConnection } from '../../../src/mcp/register.js'

/**
 * Resolves credentials and connects to one MCP server, given only what a row is safe to hold
 * statically (stage 2b step 3, D102). `@agnes/base` and Host see only this port shape -- never a
 * resolved secret value, never the deployment policy that gates which transports/hosts are allowed.
 * The worker composition layer implements it (`createMcpServerOpener` in
 * `@agnes/resource-control-worker`, composing `resolvedConfig` + `connectMcp`), which is the only
 * place with both the credential resolver and the deployment policy `resolvedConfig` needs.
 *
 * `connect` takes the *definition* (unresolved: `secretBinding` carries a `SecretRef`, never a
 * value) rather than a `McpServerConfig`, so a real implementation resolves credentials fresh on
 * every call -- every reconnect attempt gets current credentials, not ones baked in at row-mount
 * time. `superviseConnection`'s own `deps.connect(signal)` binds to one definition via closure (see
 * `mcpServerRowsFromDefinitions` in `@agnes/worker-runtime`); this port itself is definition-agnostic
 * so one implementation instance serves every row.
 */
export type McpServerOpener = Readonly<{
  connect(definition: McpServerDefinitionInput, signal: AbortSignal): Promise<McpConnection>
}>

/**
 * The row-safe, secret-free half of what a connection needs: everything `mcpServerExtension`'s own
 * `cfg` parameter uses directly (`id`/`transport`/`allowedTools`/`defer` -- see `register.ts`'s
 * `remoteDefinition` and `registerRemoteToolsStrict`), derived losslessly from the definition. This
 * is deliberately NOT how the row actually connects: a real row overrides `deps.connect` with an
 * `McpServerOpener`, which ignores this config's `cmd`/`url` and re-resolves everything (including
 * credentials) from the definition on every attempt. `cmd`/`url` are populated anyway because
 * `McpServerConfig`'s type requires them and they carry no secret material either way (executable
 * path, args, and URL are never where `resolvedConfig` puts a resolved credential -- those go in
 * `env`/`headers`, which this function deliberately leaves empty).
 *
 * `defer` is hardcoded `false`, matching `resource-control-runtime`'s own `resolvedConfig` (its
 * `McpServerConfig` also always sets `defer: false`) -- neither function derives it from the
 * definition today.
 */
export function mcpServerConfigFromDefinition(definition: McpServerDefinitionInput): McpServerConfig {
  const allowedTools = definition.toolPolicy?.allow
  const base = {
    id: definition.serverId,
    ...(allowedTools ? { allowedTools: Object.freeze([...allowedTools]) } : {}),
    defer: false,
  }
  if (definition.transport.kind === 'stdio')
    return Object.freeze({
      ...base,
      transport: 'stdio' as const,
      cmd: [definition.transport.executable, ...definition.transport.args],
    })
  return Object.freeze({ ...base, transport: definition.transport.kind, url: definition.transport.url })
}
