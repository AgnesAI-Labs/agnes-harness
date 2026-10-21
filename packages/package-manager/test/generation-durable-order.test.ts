import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimePluginSnapshot } from '../src/package-plugin-loader.js'
import { RuntimeGenerationSnapshotStore } from '../src/runtime-snapshots-generations.js'
import { hashDirectory } from '../src/sources.js'

const recorded = vi.hoisted(() => ({ events: [] as string[], root: '' }))
vi.mock('@agnes/system-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/system-node')>()
  const at = (path: string) => relative(recorded.root, path).split('/').slice(1).join('/') || '.'
  return {
    ...actual,
    syncTreeSync: vi.fn((root: string) => {
      recorded.events.push(`per-entry ${at(root)}`)
      actual.syncTreeSync(root)
    }),
    syncTreeBatchedSync: vi.fn((root: string) => {
      recorded.events.push(`batched ${at(root)} [${readdirSync(root).sort().join(',')}]`)
      actual.syncTreeBatchedSync(root)
    }),
    publishFileDurablySync: vi.fn((path: string, ...rest: unknown[]) => {
      recorded.events.push(`publish ${basename(path)}`)
      return (actual.publishFileDurablySync as (...args: unknown[]) => boolean)(path, ...rest)
    }),
  }
})

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function source(home: string, name: string): RuntimePluginSnapshot {
  const directory = join(home, 'sources', name)
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name }))
  writeFileSync(join(directory, 'lib', 'index.js'), `export const name = ${JSON.stringify(name)}\n`)
  return {
    generation: 1,
    trusted: true,
    snapshot: {
      snapshotId: `${name}-snapshot`,
      profile: 'default',
      packageId: name,
      version: '1.0.0',
      integrity: 'sha256-test',
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capabilities',
      directory,
      contributions: [],
    },
  }
}

it('flushes every copied tree before generation.json names it, with one batched flush per tree root', () => {
  const home = mkdtempSync(join(tmpdir(), 'agh-generation-order-'))
  homes.push(home)
  const store = new RuntimeGenerationSnapshotStore(join(home, 'profile'))
  recorded.root = store.root
  recorded.events.length = 0
  const resource = join(home, 'resource')
  mkdirSync(resource)
  writeFileSync(join(resource, 'SKILL.md'), '# skill\n')
  const created = store.create(
    buildRuntimeTarget({
      rows: [],
      resources: { mcp: [], skills: {} },
      resourceRevision: 'a'.repeat(64),
      compositeRevision: 'b'.repeat(64),
    }),
    [source(home, 'first'), source(home, 'second')],
    'compat',
    undefined,
    { data: { rows: [] }, directories: [resource] },
  )
  // The adopter record that follows is published by the same primitive after generation.json.
  expect(recorded.events.slice(0, recorded.events.indexOf('publish generation.json') + 1)).toEqual([
    'batched . [0,1,owner.json]',
    'batched resources [0,resources.json]',
    'publish generation.json',
  ])
  expect(recorded.events.filter((event) => event.startsWith('per-entry'))).toEqual([])
  expect(store.read(created.id).sources.map((entry) => entry.snapshot.packageId)).toEqual(['first', 'second'])
})
