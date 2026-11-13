import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  capabilityHash,
  hashDirectory,
  RuntimeGenerationSnapshotStore,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import { defineAgnesPlugin } from '@agnes/plugin-runtime'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import { hostInspectionSource } from '../src/runtime/lifecycle/host-facade.js'
import { createTestHost } from '../testkit/index.js'

const reserved = 'file:./bundled-plugins/judgment'
const relocated = 'file:./reviewed-copy'
const packageId = '@acme/provenance'

async function fixture(ref: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-generation-provenance-'))
  const directory = join(root, 'package')
  mkdirSync(directory)
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: packageId,
      version: '1.0.0',
      main: './index.js',
      agnes: { plugins: [{ export: 'main', apiRange: '^5.0.0', inject: ['self'] }] },
    }),
  )
  writeFileSync(join(directory, 'index.js'), 'fixture plugin')
  let source: RuntimePluginSnapshot = {
    snapshot: {
      packageId,
      snapshotId: `sha256-${'1'.repeat(64)}`,
      integrity: `sha256-${'1'.repeat(64)}`,
      profile: 'local-dev',
      version: '1.0.0',
      directory,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: capabilityHash({ dependencies: {} }),
      contributions: [],
      ...(ref ? { source: { type: 'file' as const, ref } } : {}),
    },
    generation: 1,
    trusted: true,
  }
  const options = {
    dataDir: root,
    disableSessionTitle: true,
    provider: new ScriptedProvider({ scripts: [] }),
    runtimePluginSources: async () => structuredClone([source]),
    extensionLoader: {
      async import() {
        return { main: defineAgnesPlugin({ inject: ['self'], apply() {} }) }
      },
    },
  }
  let host = (await createTestHost(options)).host
  const base = host.runtimeTargetSnapshot!()
  const target = buildCompleteRuntimeTarget({
    rows: [
      ...base.tree.rows,
      createPluginRow({
        id: `ext:${packageId}/main`,
        plugin: `${packageId}@${source.snapshot.snapshotId}/main`,
        snapshotDigest: source.snapshot.integrity,
        exportName: 'main',
        entryRevision: source.snapshot.integrity,
        extrasRevision: 'none',
        mountRevision: 'v1',
        inject: ['self'],
      }),
    ],
    resources: { mcp: [], skills: {} },
  }).target
  const store = new RuntimeGenerationSnapshotStore(join(root, 'profiles/local-dev'))
  return {
    root,
    target,
    store,
    get host() {
      return host
    },
    setSource(next: string) {
      source = { ...source, snapshot: { ...source.snapshot, source: { type: 'file', ref: next } } }
    },
    async reopen() {
      await host.close()
      host = (await createTestHost(options)).host
    },
    async close() {
      await host.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

it.each([false, true])(
  'forks a fresh authority assembly on same-byte relocation (bound=%s)',
  async (bound) => {
    const f = await fixture(reserved)
    try {
      expect(f.host.profile.packages.find((pkg) => pkg.id === packageId)).toBeUndefined()
      await expect(f.host.applyRuntimeTarget(f.target)).resolves.toMatchObject({ ok: true })
      const original = hostInspectionSource(f.host)
      expect(original.profile.packages.find((pkg) => pkg.id === packageId)?.source).toBe(reserved)
      const before = f.host.pluginGenerationStatus!().currentGenerationId!
      const session = bound ? await f.host.createSession({ key: 'old', cwd: f.root }) : undefined
      const sessionGeneration = session?.pluginGenerationId
      await f.host.applyRuntimeTarget(f.target)
      expect(hostInspectionSource(f.host) === original).toBe(true)
      expect(f.host.pluginGenerationStatus!().currentGenerationId).toBe(before)
      f.setSource(relocated)
      await expect(f.host.applyRuntimeTarget(f.target)).resolves.toMatchObject({ ok: true })
      const next = hostInspectionSource(f.host)
      expect(next === original).toBe(false)
      expect(next.profile.packages.find((pkg) => pkg.id === packageId)?.source).toBe(relocated)
      expect(f.host.pluginGenerationStatus!().currentGenerationId).not.toBe(before)
      if (session) {
        expect(session.pluginGenerationId).toBe(sessionGeneration)
        expect(f.store.read(sessionGeneration!).sources[0]?.snapshot.source?.ref).toBe(reserved)
      }
      const fresh = await f.host.createSession({ key: 'new', cwd: f.root })
      expect(f.store.read(fresh.pluginGenerationId!).sources[0]?.snapshot.source?.ref).toBe(relocated)
      await fresh.close()
      f.setSource(reserved)
      await f.host.applyRuntimeTarget(f.target)
      expect(hostInspectionSource(f.host) === next).toBe(false)
      expect(hostInspectionSource(f.host).profile.packages.find((pkg) => pkg.id === packageId)?.source).toBe(
        reserved,
      )
      await session?.close()
    } finally {
      await f.close()
    }
  },
  15000,
)

it('does not reuse a source-less archive or backfill a retained legacy session on cold restart', async () => {
  const f = await fixture(undefined)
  try {
    await f.host.applyRuntimeTarget(f.target)
    const old = await f.host.createSession({ key: 'legacy', cwd: f.root })
    const previous = old.pluginGenerationId!
    expect(hostInspectionSource(f.host).profile.packages.find((pkg) => pkg.id === packageId)?.source).toBe(
      'runtime-snapshot',
    )
    await old.close()
    f.setSource(reserved)
    await f.reopen()
    await expect(f.host.applyRuntimeTarget(f.target)).resolves.toMatchObject({ ok: true })
    expect(f.host.pluginGenerationStatus!().currentGenerationId).not.toBe(previous)
    expect(hostInspectionSource(f.host).profile.packages.find((pkg) => pkg.id === packageId)?.source).toBe(
      reserved,
    )
    expect(f.store.read(previous).sources[0]?.snapshot.source).toBeUndefined()
    const resumed = await f.host.createSession({ key: 'legacy', cwd: f.root })
    expect(resumed.pluginGenerationId).toBe(previous)
    expect(f.store.read(previous).sources[0]?.snapshot.source).toBeUndefined()
    await resumed.close()
  } finally {
    await f.close()
  }
}, 15000)
