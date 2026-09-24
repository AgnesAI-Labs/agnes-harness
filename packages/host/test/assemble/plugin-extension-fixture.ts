import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { afterEach } from 'vitest'
import { createTestHost, type TestHostOptions } from '../../testkit/index.js'

export const packageDirs = {
  '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
  '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
}
export const VENDOR = '@acme/plugin-tools'
export const SNAPSHOT_ID = `sha256-${'7'.repeat(64)}`
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
export const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-plugin-extension-'))
  dirs.push(d)
  return d
}
export const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

/** Tool metadata every registered tool needs; the eight keys are all required. */
export const TOOL_META = `{
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}`

/** A `tool(name)` expression usable inside a plugin body: the object `registerTool` wants. */
export const TOOL_HELPER = `const tool = (name) => ({
  name,
  description: 'test tool ' + name,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  meta: ${TOOL_META},
  async execute() { return { content: [{ type: 'text', text: name }] } },
})`

/** One installed package whose exports each run their `body` with `ctx`, `agnes` and `tool` in scope. */
export function pluginSourceWith(
  exports: readonly Readonly<{ exportName: string; rowId: string; body: string; facade?: boolean }>[],
  identity: Readonly<{ vendor?: string; snapshotId?: string }> = {},
): Readonly<RuntimePluginSnapshot> {
  const vendor = identity.vendor ?? VENDOR
  const directory = scratch()
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({
      name: vendor,
      version: '2.3.4',
      type: 'module',
      exports: './index.js',
      agnes: {
        plugins: exports.map((e) => ({ export: e.exportName, id: e.rowId, inject: ['extension'] })),
      },
    })}\n`,
  )
  writeFileSync(
    join(directory, 'index.js'),
    `${TOOL_HELPER}\n${exports
      .map(
        (e) =>
          `export const ${e.exportName} = { inject: ['extension'], async apply(ctx, config) {\n${e.facade === false ? '' : '  const agnes = ctx.extension()\n'}${e.body}\n} }\n`,
      )
      .join('')}`,
  )
  return {
    snapshot: Object.freeze({
      snapshotId: identity.snapshotId ?? SNAPSHOT_ID,
      profile: 'local-dev',
      packageId: vendor,
      version: '2.3.4',
      integrity: `sha256-${'8'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capability',
      directory,
      contributions: Object.freeze([]),
    }),
    generation: 1,
    trusted: true,
  }
}

/** One installed package whose `plugin` export runs `body` with `ctx`, `agnes` and `tool` in scope. */
export function pluginSource(
  body: string,
  exportName = 'plugin',
  rowId = 'ext:acme/plugin-tools',
): Readonly<RuntimePluginSnapshot> {
  return pluginSourceWith([{ exportName, rowId, body }])
}

export const pluginRow = (
  id = 'ext:acme/plugin-tools',
  exportName = 'plugin',
  disabled = false,
  identity: Readonly<{ vendor?: string; snapshotId?: string }> = {},
) =>
  createPluginRow({
    id,
    plugin: `${identity.vendor ?? VENDOR}@${identity.snapshotId ?? SNAPSHOT_ID}/${exportName}`,
    snapshotDigest: `sha256-${'8'.repeat(64)}`,
    exportName,
    entryRevision: identity.snapshotId ?? SNAPSHOT_ID,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    inject: ['extension'],
    ...(disabled ? { disabled } : {}),
  })

export const targetOf = (rows: ReturnType<typeof pluginRow>[]) =>
  buildRuntimeTarget({
    rows,
    resources: { mcp: [], skills: {} },
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })

export async function pluginHost(
  source: Readonly<RuntimePluginSnapshot> | readonly Readonly<RuntimePluginSnapshot>[],
  options: Partial<TestHostOptions> = {},
) {
  const dataDir = scratch()
  return {
    dataDir,
    ...(await createTestHost({
      dataDir,
      packageDirs,
      runtimePluginCatalogue: Array.isArray(source) ? source : [source],
      extensionLoader: {
        import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      },
      ...options,
    })),
  }
}

/**
 * A Host fed the way a production worker feeds it: no fixed catalogue, only `runtimePluginSources`
 * re-read before every target. `pluginHost` above hands in a complete catalogue that is never
 * refreshed, so it cannot show what happens when a version or a trust decision changes.
 */
export async function livePluginHost(
  sources: () => readonly Readonly<RuntimePluginSnapshot>[],
  options: Readonly<{ startTimeoutMs?: number }> = {},
) {
  const dataDir = scratch()
  return {
    dataDir,
    ...(await createTestHost({
      dataDir,
      packageDirs,
      runtimePluginSources: async () => sources(),
      ...(options.startTimeoutMs === undefined ? {} : { ordinaryStartTimeoutMs: options.startTimeoutMs }),
      extensionLoader: {
        import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
      },
    })),
  }
}

export type PluginHost = Awaited<ReturnType<typeof pluginHost>>
export const toolNames = (h: PluginHost) => h.host.kernel.tools.list().map((t) => t.name)
export const rowState = (h: PluginHost, id: string) =>
  h.host.ordinaryConvergence().rows.find((r) => r.id === id)?.state
export const auditKinds = (h: PluginHost, kind: string) => h.audit.events.filter((e) => e.kind === kind)
