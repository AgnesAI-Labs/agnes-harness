import { createHash } from 'node:crypto'
import {
  type ConnectionStatusEvent,
  type McpServerConfig,
  type McpServerOpener,
  mcpCatalogHubFor,
  mcpLocalToolPrefix,
  mcpServerConfigFromDefinition,
  mcpServerExtension,
} from '@agnes/base'
import type { DynamicExtension } from '@agnes/host'
import {
  type DesiredState,
  type McpServerDefinitionInput,
  type TrustState,
  validateResourceControlData,
} from '@agnes/protocol'

/** One snapshot entry -- structurally `@agnes/resource-control-runtime`'s `McpManagedInput`
 * (`worker-runtime.ts`'s `mcp: readonly McpManagedInput[]`), so the snapshot's own entries are
 * assignable here without this package taking on that (layer-6) dependency itself. */
export type McpServerSnapshotEntry = Readonly<{
  definition: McpServerDefinitionInput
  /** Changes whenever anything about this definition changes (daemon-assigned). It becomes the row's
   * `spec.revision`, hence its `entryRevision`, hence its mount identity -- which is exactly what lets
   * an edited server replace only its own row (see the doc comment on mcpServerRowsFromDefinitions). */
  revision: string
  desired: DesiredState
  trust: TrustState
}>

export type McpServerRowsResult = Readonly<{
  rows: readonly Readonly<DynamicExtension>[]
  /** A definition this snapshot carries but that will not become a row, with why. Never a reason to
   * fail the whole derivation -- design doc §3.1: "失败只排除这一个服务器...绝不让它变成整棵树被拒". */
  skipped: readonly Readonly<{ serverId: string; reason: string }>[]
}>

const SLUG_MAX = 40
/** `ext:agnes/mcp-<slug>-<hash8>` (design doc §3.1). `slug` is cosmetic (a human can recognize which
 * server a row is), `hash8` is what actually disambiguates -- two servers whose ids collide only
 * after slugging still get distinct rows, and slugging is otherwise lossy (case, most punctuation). */
function slugOf(serverId: string): string {
  const slug = serverId
    .toLocaleLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
  return slug || 'server'
}
function hash8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

/**
 * Derives one Host-owned `ext:` row per non-OAuth MCP server in a snapshot (stage 2b step 3, D102/
 * D107'). Pure: the same `entries` (by value) always derives the same `rows`/`skipped` -- every
 * field of the returned `DynamicExtension`s is computed from `entries` and `opener` alone, and
 * `opener` is definition-agnostic (one instance serves every row, see `McpServerOpener`'s own doc
 * comment), so it never makes two calls with the same input diverge. A row's `factory` closure is a
 * fresh function value each call (functions cannot be identity-compared for "did this derive the
 * same row"), but its own behavior is fully determined by the same inputs.
 *
 * Which servers become rows is exactly which servers the resource manager would connect
 * (`resource-control-runtime/src/mcp.ts` `connectManaged`): `desired === 'enabled'` and
 * `trust === 'trusted'`. OAuth-bound definitions are also filtered out here, not deferred to the
 * opener: design §3.4 (D105/D109) -- OAuth is not supported by this path.
 *
 * Per-server precheck (design §3.1 "逐服务器预检"): each definition is re-validated against the
 * protocol schema; one that fails is skipped with a reason and never turns the rest of the batch --
 * let alone the tree -- into a failure. (`assertPublishableRows`, the other half of that precheck,
 * inspects row `config`; these rows never carry one, see below.)
 *
 * **Update one row, never the whole tree.** A row never carries a `config`: the definition lives only
 * in the factory's closure, and an edit surfaces as a new `revision` -> `spec.revision` ->
 * `entryRevision` -> mount identity (plugin-runtime's `buildMountIdentity`). `canReuseRowImporter`
 * (host/src/runtime-target-publisher.ts) lets an identity change through the live-tree transaction,
 * so only that server's row is swapped. A row that instead changed its `config` under an unchanged
 * identity would hit the `builtin:` config-equality check there and fall back to a full rebuild --
 * which is why the caller must `prepare()` these rows without a `config` (host/test/assemble/
 * ext-rows-dynamic.test.ts pins both shapes). The extension id itself stays stable per server
 * (`hash8(serverId)`), so an edit is a replace of the same row id, not a remove plus an add.
 */
export function mcpServerRowsFromDefinitions(
  entries: readonly McpServerSnapshotEntry[],
  opener: McpServerOpener,
  options: Readonly<{
    /** Called when a row's extension starts, with its first connection attempt's outcome. Only a row
     *  Host actually (re)mounts starts; an unchanged row keeps its running instance. */
    onFirstAttempt?(serverId: string, ready: Promise<unknown>): void
    /** This row's live connection status as it changes over its whole lifetime, not just the first
     *  attempt (design §3.2). Same "only a (re)mounted row starts" caveat as `onFirstAttempt`. */
    onStatus?(serverId: string, event: ConnectionStatusEvent): void
  }> = {},
): McpServerRowsResult {
  const rows: DynamicExtension[] = []
  const skipped: { serverId: string; reason: string }[] = []
  for (const entry of entries) {
    const { definition, revision } = entry
    const serverId = typeof definition?.serverId === 'string' ? definition.serverId : '(unknown)'
    if (!validateResourceControlData('McpServerDefinitionInput', definition).ok) {
      skipped.push({ serverId, reason: 'definition failed protocol schema re-validation' })
      continue
    }
    if (entry.desired !== 'enabled') {
      skipped.push({ serverId, reason: 'disabled' })
      continue
    }
    if (entry.trust !== 'trusted') {
      skipped.push({ serverId, reason: `trust is ${entry.trust}` })
      continue
    }
    if (definition.secretBinding.kind === 'oauth') {
      skipped.push({ serverId, reason: 'oauth secretBinding is not supported (D105/D109)' })
      continue
    }
    const extensionId = `agnes/mcp-${slugOf(definition.serverId)}-${hash8(definition.serverId)}`
    const cfg = mcpServerConfigFromDefinition(definition)
    rows.push(
      Object.freeze({
        spec: Object.freeze({
          id: extensionId,
          package: '@agnes/base',
          packageVersion: '0.0.0',
          dir: '',
          trust: 'builtin' as const,
          enabled: true,
          revision: hash8(`${definition.serverId}\0${revision}`),
        }),
        manifest: Object.freeze({
          id: extensionId,
          version: '0.1.0',
          apiRange: '^1.0',
          entry: './index.mjs',
          // Exactly what this one server registers (register.ts): tools under its own
          // `mcpLocalToolPrefix(serverId)` prefix and one `mcp` resource. The ext host refuses
          // anything undeclared. Calling the same shared function `localName()` calls (rather than
          // re-deriving the prefix here) is what keeps this declaration and the actual registered
          // names from drifting apart -- see naming.ts's doc comment (design
          // 2026-09-23-mcp-tool-name-collision-design.md §0.4).
          capabilities: Object.freeze({
            tools: Object.freeze({ prefix: mcpLocalToolPrefix(definition.serverId) }),
            resources: ['mcp' as const],
          }),
        }),
        factory: (ctx: Parameters<typeof mcpCatalogHubFor>[0]) =>
          mcpServerExtension(cfg, {
            catalogHub: mcpCatalogHubFor(ctx),
            connect: (_cfg: McpServerConfig, signal: AbortSignal) => opener.connect(definition, signal),
            ...(options.onFirstAttempt
              ? { onFirstAttempt: (ready) => options.onFirstAttempt?.(definition.serverId, ready) }
              : {}),
            ...(options.onStatus
              ? { onStatus: (event) => options.onStatus?.(definition.serverId, event) }
              : {}),
          }),
      }),
    )
  }
  return Object.freeze({ rows: Object.freeze(rows), skipped: Object.freeze(skipped) })
}
