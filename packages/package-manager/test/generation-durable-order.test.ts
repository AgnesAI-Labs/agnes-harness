import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimePluginSnapshot } from '../src/package-plugin-loader.js'
import { RuntimeGenerationSnapshotStore } from '../src/runtime-snapshots-generations.js'
import { hashDirectory } from '../src/sources.js'

const recorded = vi.hoisted(() => ({ events: [] as string[], root: '' }))
vi.mock('@agnes/system-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/system-node')>()
  const at = (path: string) => relative(recorded.root, path).split(sep).slice(1).join('/') || '.'
  return {
    ...actual,
    syncTreeSync: vi.fn((root: string) => {
      recorded.events.push(`per-entry ${at(root)}`)
      actual.syncTreeSync(root)
    }),
    syncTreeBatchedSync: vi.fn((...roots: string[]) => {
      recorded.events.push(
        `batched ${roots.map((root) => `${at(root)} [${readdirSync(root).sort().join(',')}]`).join(' + ')}`,
      )
      actual.syncTreeBatchedSync(...roots)
    }),
    publishFileDurablySync: vi.fn((path: string, ...rest: unknown[]) => {
      recorded.events.push(`publish ${basename(path)}`)
      return (actual.publishFileDurablySync as (...args: unknown[]) => boolean)(path, ...rest)
    }),
    removeFileDurablySync: vi.fn((path: string) => {
      recorded.events.push(`remove ${relative(recorded.root, path).split(sep).slice(1).join('/')}`)
      actual.removeFileDurablySync(path)
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

it.each(['sync', 'cooperative'] as const)(
  'flushes every copied tree before generation.json names it (%s)',
  async (mode) => {
    const home = mkdtempSync(join(tmpdir(), 'agh-generation-order-'))
    homes.push(home)
    const store = new RuntimeGenerationSnapshotStore(join(home, 'profile'))
    recorded.root = store.root
    recorded.events.length = 0
    const resource = join(home, 'resource')
    mkdirSync(resource)
    writeFileSync(join(resource, 'SKILL.md'), '# skill\n')
    const created = await store[mode === 'sync' ? 'create' : 'createAsync'](
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
      'batched 0 [lib,package.json] + 1 [lib,package.json]',
      'batched resources [0,resources.json]',
      'publish generation.json',
    ])
    expect(recorded.events.filter((event) => event.startsWith('per-entry'))).toEqual([])
    expect(store.read(created.id).sources.map((entry) => entry.snapshot.packageId)).toEqual([
      'first',
      'second',
    ])
  },
)

it.each(['sync', 'cooperative'] as const)(
  'refuses changed package bytes and removes an unpublished generation (%s)',
  async (mode) => {
    const home = mkdtempSync(join(tmpdir(), 'agh-generation-changed-'))
    homes.push(home)
    const store = new RuntimeGenerationSnapshotStore(join(home, 'profile'))
    const selected = source(home, 'changed')
    writeFileSync(join(selected.snapshot.directory, 'lib', 'index.js'), 'changed after approval')
    const target = buildRuntimeTarget({
      rows: [],
      resources: { mcp: [], skills: {} },
      resourceRevision: 'a'.repeat(64),
      compositeRevision: 'b'.repeat(64),
    })
    await expect(
      Promise.resolve().then(() =>
        store[mode === 'sync' ? 'create' : 'createAsync'](target, [selected], 'compat'),
      ),
    ).rejects.toThrow('E_GENERATION_INTEGRITY')
    expect(readdirSync(store.root)).toEqual([])
  },
)

it('keeps an unfinished cooperative publication while collection runs, then publishes a verified archive', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agh-generation-pending-'))
  homes.push(home)
  const store = new RuntimeGenerationSnapshotStore(join(home, 'profile'))
  const target = buildRuntimeTarget({
    rows: [],
    resources: { mcp: [], skills: {} },
    resourceRevision: 'a'.repeat(64),
    compositeRevision: 'b'.repeat(64),
  })
  const pending = store.createAsync(target, [source(home, 'first')], 'compat')
  const [id] = readdirSync(store.root)
  if (!id) throw new Error('pending generation directory is missing')
  const directory = join(store.root, id)
  expect(existsSync(join(directory, 'generation.json'))).toBe(false)
  expect(await store.collect(new Set())).toEqual([])
  const created = await pending
  expect(await store.readAsync(created.id)).toEqual(created)
})

it('captures cooperative publication inputs before the caller can change its source selection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agh-generation-inputs-'))
  homes.push(home)
  const store = new RuntimeGenerationSnapshotStore(join(home, 'profile'))
  const first = source(home, 'first')
  const selected = [first, source(home, 'second')]
  const target = buildRuntimeTarget({
    rows: [],
    resources: { mcp: [], skills: {} },
    resourceRevision: 'a'.repeat(64),
    compositeRevision: 'b'.repeat(64),
  })
  const pending = store.createAsync(target, selected, 'compat')
  Object.assign(first.snapshot, { version: '9.9.9', directory: join(home, 'unselected') })
  selected.splice(0)
  const created = await pending
  expect(created.sources.map((entry) => entry.snapshot.packageId)).toEqual(['first', 'second'])
  expect(created.sources.map((entry) => entry.snapshot.version)).toEqual(['1.0.0', '1.0.0'])
  expect(await store.readAsync(created.id)).toEqual(created)
})

it('flushes the removal of its own adopter record once, not on every collection that passes it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agh-generation-release-'))
  homes.push(home)
  const store = new RuntimeGenerationSnapshotStore(join(home, 'profile'))
  recorded.root = store.root
  const target = buildRuntimeTarget({
    rows: [],
    resources: { mcp: [], skills: {} },
    resourceRevision: 'a'.repeat(64),
    compositeRevision: 'b'.repeat(64),
  })
  const created = store.create(target, [source(home, 'first')], 'compat')
  // The pin keeps the generation, so every later collection still visits it.
  store.pin('session-a', created.id, [])
  recorded.events.length = 0
  for (let pass = 0; pass < 3; pass++) expect(await store.collect(new Set())).toEqual([])
  expect(recorded.events.filter((event) => event.startsWith('remove '))).toEqual([
    expect.stringMatching(/^remove adopters\//),
  ])
  expect(readdirSync(join(store.root, created.id, 'adopters'))).toEqual([])
})
