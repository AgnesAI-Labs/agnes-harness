import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { createTargetReverter } from '../src/composite-target-revert.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'd'.repeat(64)
const snapshot = (fill: string) => `sha256-${fill.repeat(64)}`

function row(id: string, packageId: string, snapshotId: string) {
  return createPluginRow({
    id,
    plugin: `${packageId}@${snapshotId}/main`,
    snapshotDigest: snapshotId,
    exportName: 'main',
    entryRevision: snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
  })
}

function target(rows: ReturnType<typeof row>[]) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows,
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

const rowIds = (store: CompositeTargetStore) =>
  store.desired() === undefined
    ? undefined
    : decode(store.desired() as ReturnType<typeof target>).map((r) => r.id)

import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'

const decode = (artifact: ReturnType<typeof target>) => decodeRuntimeTargetArtifact(artifact).tree.rows

const fail = (store: CompositeTargetStore, artifact: ReturnType<typeof target>, message = 'did not start') =>
  store.qualifyFailed(1, artifact, {
    generation: 1,
    digest: artifact.digest,
    identity: artifact.identity,
    phase: 'apply',
    message,
  })

function setup(loadable: Record<string, string>) {
  const tables = sqliteTables()
  const store = new CompositeTargetStore(tables.table('composite'), 'default')
  const events: Array<{ kind: string; detail: Record<string, unknown> }> = []
  const reverter = createTargetReverter({
    store,
    loadableSnapshots: async () => new Map(Object.entries(loadable)),
    now: () => 'now',
    audit: (event) => events.push(event),
  })
  return { store, events, reverter }
}

const confirm = (store: CompositeTargetStore, artifact: ReturnType<typeof target>) =>
  store.qualifyConverged(1, artifact, { hash: artifact.identity.treeHash, ok: true, rows: [] })

describe('revertFailedDesired', () => {
  it('does nothing when nothing failed', async () => {
    const { store, reverter } = setup({})
    const good = target([])
    store.publishDesired(good)
    confirm(store, good)
    await reverter.revertFailedDesired()
    expect(store.desired()?.digest).toBe(good.digest)
  })

  it('puts the previous target back when a newly enabled package failed, and marks that package', async () => {
    const a = `pkg-a@${snapshot('1')}`
    const { store, events, reverter } = setup({
      [a]: snapshot('1'),
      [`pkg-b@${snapshot('2')}`]: snapshot('2'),
    })
    const good = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    store.publishDesired(good)
    confirm(store, good)
    const bad = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('1')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('2')),
    ])
    store.publishDesired(bad)
    fail(store, bad, 'pkg-b threw')

    await reverter.revertFailedDesired()

    expect(rowIds(store)).toEqual(['ext:pkg-a/main'])
    expect(store.packageFailure('pkg-b')?.message).toBe('pkg-b threw')
    expect(store.packageFailure('pkg-a')).toBeUndefined()
    expect(store.lastFailure()).toBeUndefined()
    expect(events.map((e) => e.kind)).toEqual(['plugin.tree.reverted'])
    expect(events[0]?.detail).toMatchObject({ packages: ['pkg-b'], level: 'previous' })
  })

  it('leaves out a package whose earlier version is no longer installed when its update failed', async () => {
    const { store, reverter } = setup({
      [`pkg-a@${snapshot('2')}`]: snapshot('2'),
      [`pkg-b@${snapshot('3')}`]: snapshot('3'),
    })
    const good = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('1')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('3')),
    ])
    store.publishDesired(good)
    confirm(store, good)
    store.dropLastGood()
    const bad = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('2')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('3')),
    ])
    store.publishDesired(bad)
    fail(store, bad)

    await reverter.revertFailedDesired()

    expect(rowIds(store)).toEqual(['ext:pkg-b/main'])
    expect(store.packageFailure('pkg-a')).toBeDefined()
  })

  it('falls back to no packages at all when the very first target failed', async () => {
    const { store, reverter } = setup({ [`pkg-a@${snapshot('1')}`]: snapshot('1') })
    const bad = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    store.publishDesired(bad)
    fail(store, bad)
    await reverter.revertFailedDesired()
    expect(rowIds(store)).toEqual([])
    expect(store.packageFailure('pkg-a')).toBeDefined()
  })

  it('goes on to no packages at all when the target it fell back to failed as well', async () => {
    const a = `pkg-a@${snapshot('1')}`
    const { store, events, reverter } = setup({
      [a]: snapshot('1'),
      [`pkg-b@${snapshot('2')}`]: snapshot('2'),
    })
    const good = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    store.publishDesired(good)
    confirm(store, good)
    const bad = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('1')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('2')),
    ])
    store.publishDesired(bad)
    fail(store, bad)
    await reverter.revertFailedDesired()
    expect(rowIds(store)).toEqual(['ext:pkg-a/main'])

    const fallback = store.desired()
    if (!fallback) throw new Error('expected a desired target')
    fail(store, fallback, 'fallback failed too')
    await reverter.revertFailedDesired()

    expect(rowIds(store)).toEqual([])
    expect(events.map((e) => e.detail.level)).toEqual(['previous', 'empty'])
    expect(store.packageFailure('pkg-a')?.message).toBe('fallback failed too')
  })

  it('stays on the empty package set once that failed too, and never goes back to a fallback that failed', async () => {
    const { store, reverter } = setup({
      [`pkg-a@${snapshot('1')}`]: snapshot('1'),
      [`pkg-b@${snapshot('2')}`]: snapshot('2'),
    })
    const good = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    store.publishDesired(good)
    confirm(store, good)
    const bad = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('1')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('2')),
    ])
    store.publishDesired(bad)
    fail(store, bad)
    const counts: number[] = []
    for (let round = 0; round < 5; round += 1) {
      await reverter.revertFailedDesired()
      const desired = store.desired()
      if (!desired) throw new Error('expected a desired target')
      counts.push(decode(desired).length)
      fail(store, desired, 'still failing')
    }
    expect(counts).toEqual([1, 0, 0, 0, 0])
  })

  it('stops after the empty package set, however often it fails', async () => {
    const { store, reverter } = setup({ [`pkg-a@${snapshot('1')}`]: snapshot('1') })
    const bad = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    store.publishDesired(bad)
    fail(store, bad)
    await reverter.revertFailedDesired()
    const empty = store.desired()
    if (!empty) throw new Error('expected a desired target')
    fail(store, empty)
    await reverter.revertFailedDesired()
    expect(store.desired()?.digest).toBe(empty.digest)
    expect(store.lastFailure()?.digest).toBe(empty.digest)
  })

  it('does not fall back when the same target was published again and failed', async () => {
    const { store, reverter } = setup({ [`pkg-a@${snapshot('1')}`]: snapshot('1') })
    const good = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    store.publishDesired(good)
    confirm(store, good)
    store.publishDesired(good)
    fail(store, good, 'a passing hiccup')
    await reverter.revertFailedDesired()
    expect(store.desired()?.digest).toBe(good.digest)
    expect(store.packageFailure('pkg-a')).toBeUndefined()
  })

  it('does not fall back to nothing when a confirmed fallback fails later and is published again', async () => {
    const { store, reverter } = setup({
      [`pkg-a@${snapshot('1')}`]: snapshot('1'),
      [`pkg-b@${snapshot('2')}`]: snapshot('2'),
    })
    const good = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    store.publishDesired(good)
    confirm(store, good)
    const bad = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('1')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('2')),
    ])
    store.publishDesired(bad)
    fail(store, bad)
    await reverter.revertFailedDesired()
    confirm(store, good)
    store.publishDesired(good)
    fail(store, good, 'a passing hiccup')
    await reverter.revertFailedDesired()
    expect(rowIds(store)).toEqual(['ext:pkg-a/main'])
  })

  it('does nothing when another target was published while it was reading what can be loaded', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const bad = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    const newer = target([row('ext:pkg-b/main', 'pkg-b', snapshot('2'))])
    store.publishDesired(bad)
    fail(store, bad)
    const reverter = createTargetReverter({
      store,
      loadableSnapshots: async () => {
        store.publishDesired(newer)
        return new Map()
      },
      now: () => 'now',
    })
    await reverter.revertFailedDesired()
    expect(store.desired()?.digest).toBe(newer.digest)
    expect(store.packageFailure('pkg-a')).toBeUndefined()
  })

  it('reverts once when called several times at the same moment', async () => {
    const { store, events, reverter } = setup({ [`pkg-a@${snapshot('1')}`]: snapshot('1') })
    const bad = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    store.publishDesired(bad)
    fail(store, bad)
    await Promise.all([
      reverter.revertFailedDesired(),
      reverter.revertFailedDesired(),
      reverter.revertFailedDesired(),
    ])
    expect(events).toHaveLength(1)
  })

  it('still reverts a failure that arrives while another revert is running', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const first = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    const second = target([row('ext:pkg-b/main', 'pkg-b', snapshot('2'))])
    store.publishDesired(first)
    fail(store, first)
    let calls = 0
    const reverter = createTargetReverter({
      store,
      loadableSnapshots: async () => {
        calls += 1
        if (calls === 1) {
          store.publishDesired(second)
          fail(store, second)
          void reverter.revertFailedDesired()
        }
        return new Map()
      },
      now: () => 'now',
    })
    await reverter.revertFailedDesired()
    expect(rowIds(store)).toEqual([])
    expect(store.packageFailure('pkg-b')).toBeDefined()
  })

  it('reverts even when no package can be named, and says so in the audit', async () => {
    const { store, events, reverter } = setup({})
    const odd = createPluginRow({
      id: 'ext:odd',
      plugin: 'not-a-plugin-identity',
      snapshotDigest: 'x',
      exportName: 'main',
      entryRevision: 'x',
      extrasRevision: 'none',
      mountRevision: 'host-ordinary-row:v1',
    })
    const bad = target([odd])
    store.publishDesired(bad)
    fail(store, bad)
    await reverter.revertFailedDesired()
    expect(rowIds(store)).toEqual([])
    expect(events[0]?.detail).toMatchObject({ packages: [], unattributed: 1 })
    expect(store.revertedFrom(bad.digest)).toBeDefined()
  })
})
