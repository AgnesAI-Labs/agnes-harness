import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const packageDirs = {
  '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
  '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
}
const TOOLS_CORE = ['read', 'write', 'edit', 'shell', 'todo']
const VENDOR = '@acme/replacements'
const SNAPSHOT_ID = `sha256-${'5'.repeat(64)}`
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-ext-rows-replace-'))
  dirs.push(d)
  return d
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

function vendorSource(rowId: string): Readonly<RuntimePluginSnapshot> {
  const directory = scratch()
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({
      name: VENDOR,
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
      agnes: { plugins: [{ export: 'replacement', id: rowId, provide: ['replacementMarker'] }] },
    })}\n`,
  )
  writeFileSync(
    join(directory, 'index.js'),
    "export const replacement = Object.assign((ctx) => ctx.provide('replacementMarker', 'third-party'), { provide: 'replacementMarker' })\n",
  )
  return {
    snapshot: Object.freeze({
      snapshotId: SNAPSHOT_ID,
      profile: 'local-dev',
      packageId: VENDOR,
      version: '1.0.0',
      integrity: `sha256-${'6'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capability',
      directory,
      contributions: Object.freeze([]),
    }),
    generation: 1,
    trusted: true,
  }
}

const replacementRow = (id: string, disabled = false) =>
  createPluginRow({
    id,
    plugin: `${VENDOR}@${SNAPSHOT_ID}/replacement`,
    snapshotDigest: `sha256-${'6'.repeat(64)}`,
    exportName: 'replacement',
    entryRevision: SNAPSHOT_ID,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    provides: ['replacementMarker'],
    ...(disabled ? { disabled } : {}),
  })

const targetOf = (rows: ReturnType<typeof replacementRow>[]) =>
  buildRuntimeTarget({
    rows,
    resources: { mcp: [], skills: {} },
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })

async function host(rowId: string) {
  return createTestHost({
    dataDir: scratch(),
    packageDirs,
    runtimePluginCatalogue: [vendorSource(rowId)],
    extensionLoader: {
      import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
    },
  })
}

type H = Awaited<ReturnType<typeof host>>
const toolNames = (h: H) => h.host.kernel.tools.list().map((t) => t.name)
const rowState = (h: H, id: string) => h.host.ordinaryConvergence().rows.find((r) => r.id === id)?.state
const errors = (h: H) =>
  h.audit.events.filter(
    (e) => e.kind === 'extension.failed' || JSON.stringify(e.detail ?? {}).includes('second extension'),
  )

describe('a third-party row replaces a builtin ext: row', () => {
  it('mounts in place of tools-core, which then stops supplying its tools', async () => {
    const h = await host('ext:agnes/tools-core')
    for (const name of TOOLS_CORE) expect(toolNames(h)).toContain(name)

    const report = await h.host.applyRuntimeTarget(targetOf([replacementRow('ext:agnes/tools-core')]))
    await settle()

    expect(report.ok).toBe(true)
    expect(rowState(h, 'ext:agnes/tools-core')).toBe('active')
    expect(report.rows.filter((r) => r.id === 'ext:agnes/tools-core')).toHaveLength(1)
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(false)
    for (const name of TOOLS_CORE) expect(toolNames(h)).not.toContain(name)
    expect(errors(h)).toEqual([])
    await h.host.close()
  })

  it('stays replaced when the builtin ext: rows are driven afterwards', async () => {
    const h = await host('ext:agnes/tools-core')
    await h.host.applyRuntimeTarget(targetOf([replacementRow('ext:agnes/tools-core')]))
    await settle()

    // Any later apply of the Host's own rows must not put the builtin back over the replacement.
    await h.host.extensionRows.apply(h.host.extensionRows.current())
    await settle()

    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(false)
    for (const name of TOOLS_CORE) expect(toolNames(h)).not.toContain(name)
    expect(rowState(h, 'ext:agnes/tools-core')).toBe('active')
    // The other builtin ext: rows are untouched.
    expect(h.host.extensions().find((e) => e.id === 'agnes/hooks-runner')?.loaded).toBe(true)
    await h.host.close()
  })

  it('refuses to replace hooks-runner: a plugin row cannot register the hooks it declares', async () => {
    const h = await host('ext:agnes/hooks-runner')
    await expect(
      h.host.applyRuntimeTarget(targetOf([replacementRow('ext:agnes/hooks-runner')])),
    ).rejects.toThrow(/replacement of ext:agnes\/hooks-runner must register hooks/)
    await settle()
    // The refused candidate never mounted a replacement, so the builtin it aimed at is untouched.
    expect(h.host.extensions().find((e) => e.id === 'agnes/hooks-runner')?.loaded).toBe(true)
    await h.host.close()
  })

  it('leaves the builtin in place while the replacing package is disabled', async () => {
    // A disabled package keeps its row in the target, switched off. That must mean "no replacement",
    // not "nothing mounts under this id".
    const h = await host('ext:agnes/tools-core')
    const report = await h.host.applyRuntimeTarget(targetOf([replacementRow('ext:agnes/tools-core', true)]))
    await settle()
    expect(report.ok).toBe(true)
    expect(h.host.extensions().find((e) => e.id === 'agnes/tools-core')?.loaded).toBe(true)
    for (const name of TOOLS_CORE) expect(toolNames(h)).toContain(name)

    await h.host.extensionRows.apply(h.host.extensionRows.current())
    await settle()
    for (const name of TOOLS_CORE) expect(toolNames(h)).toContain(name)
    await h.host.close()
  })

  it('brings the builtin back when the replacing package is disabled afterwards', async () => {
    const h = await host('ext:agnes/tools-core')
    await h.host.applyRuntimeTarget(targetOf([replacementRow('ext:agnes/tools-core')]))
    await settle()
    for (const name of TOOLS_CORE) expect(toolNames(h)).not.toContain(name)

    await h.host.applyRuntimeTarget(targetOf([replacementRow('ext:agnes/tools-core', true)]))
    await settle()
    for (const name of TOOLS_CORE) expect(toolNames(h)).toContain(name)
    await h.host.close()
  })
})
