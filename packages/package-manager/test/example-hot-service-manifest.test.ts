import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPackagePlugins } from '../src/package-plugin-loader.js'
import { parseAgnesPluginEntries } from '../src/plugin-manifest.js'
import type { RuntimeSnapshot } from '../src/runtime-snapshots.js'
import { hashDirectory } from '../src/sources.js'

const manifest = (release: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../../examples/packages/hot-service/${release}/package.json`, import.meta.url),
      ),
      'utf8',
    ),
  ) as Record<string, unknown>

describe('hot-service example manifests', () => {
  it.each(['v1', 'v2', 'broken'])('%s declares one in-process plugin through agnes.plugins', (release) => {
    const pkg = manifest(release)
    const agnes = pkg.agnes as { plugins?: unknown; extensions?: unknown }
    // The retired mechanism must not come back through an example.
    expect(agnes.extensions).toBeUndefined()
    const entries = parseAgnesPluginEntries(String(pkg.name), agnes.plugins)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      export: 'hotService',
      id: 'ext:@agnes-examples/hot-service/hotService',
      runtime: 'in-process',
      default: true,
    })
  })

  it('the three releases are one package at three distinct versions', () => {
    expect(['v1', 'v2', 'broken'].map((release) => manifest(release).name)).toEqual([
      '@agnes-examples/hot-service',
      '@agnes-examples/hot-service',
      '@agnes-examples/hot-service',
    ])
    expect(new Set(['v1', 'v2', 'broken'].map((release) => manifest(release).version)).size).toBe(3)
  })

  it.each(['v1', 'v2', 'broken'])('%s is accepted by the real package plugin loader', async (release) => {
    const directory = fileURLToPath(
      new URL(`../../../examples/packages/hot-service/${release}`, import.meta.url),
    )
    const pkg = manifest(release)
    const snapshot: RuntimeSnapshot = Object.freeze({
      snapshotId: `sha256-${'1'.repeat(64)}`,
      profile: 'default',
      packageId: String(pkg.name),
      version: String(pkg.version),
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capability',
      directory,
      contributions: Object.freeze([]),
    })
    const loaded = await loadPackagePlugins({
      snapshot,
      generation: 1,
      importModule: async () => import(pathToFileURL(`${directory}/index.mjs`).href),
    })
    expect(loaded).toHaveLength(1)
    // What the row mount is built from: the service the plugin declares, and no dependencies.
    expect(loaded[0]?.entry.provides).toEqual(['demoTextStats'])
    expect(loaded[0]?.entry.inject).toEqual({})
  })

  it.each(['v1', 'v2', 'broken'])(
    '%s declares in its manifest exactly the services its export provides',
    async (release) => {
      const directory = fileURLToPath(
        new URL(`../../../examples/packages/hot-service/${release}`, import.meta.url),
      )
      const module = (await import(pathToFileURL(`${directory}/index.mjs`).href)) as {
        hotService: { provide?: string | string[] }
      }
      const declared = parseAgnesPluginEntries(
        String(manifest(release).name),
        (manifest(release).agnes as { plugins?: unknown }).plugins,
      )[0]?.provide
      const exported = [module.hotService.provide].flat().filter((name): name is string => Boolean(name))
      // The daemon builds the row from the manifest and the worker checks it against the export: a drift
      // between the two is E_ROW_METADATA at mount time, on a real daemon.
      expect(declared).toEqual(exported)
      expect(declared).toEqual(['demoTextStats'])
    },
  )
})
