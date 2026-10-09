import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'c'.repeat(64)

function artifact(id: string) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id,
          plugin: `builtin:host/${id}`,
          snapshotDigest: 'builtin:host:v1',
          exportName: id,
          entryRevision: 'host-row:v1',
          extrasRevision: 'none',
          mountRevision: 'host-row:v1',
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

function confirmedStore() {
  const tables = sqliteTables()
  const store = new CompositeTargetStore(tables.table('composite'), 'default')
  const good = artifact('ext:good')
  store.publishDesired(good)
  store.qualifyConverged(1, good, { hash: good.identity.treeHash, ok: true, rows: [] })
  return { tables, store, good }
}

const failure = (target: ReturnType<typeof artifact>) => ({
  generation: 1,
  digest: target.digest,
  identity: target.identity,
  phase: 'apply',
  message: 'plugin did not start',
})

describe('CompositeTargetStore.revertDesired', () => {
  it('puts the target back in one step and keeps what was confirmed', () => {
    const { store, good } = confirmedStore()
    const bad = artifact('ext:bad')
    store.publishDesired(bad)
    store.qualifyFailed(1, bad, failure(bad))
    const seen: string[] = []
    store.onDesired((next) => seen.push(next.digest))

    const applied = store.revertDesired({
      expectedDigest: bad.digest,
      target: good,
      packages: ['pkg-bad'],
      failure: { digest: bad.digest, phase: 'apply', message: 'plugin did not start' },
      at: '2026-09-21T00:00:00.000Z',
    })

    expect(applied).toBe(true)
    expect(store.desired()?.digest).toBe(good.digest)
    // Confirmation is never forged: the worker has to confirm the target it is offered.
    expect(store.acknowledged()).toBeUndefined()
    expect(store.pending()).toBe(true)
    expect(store.lastFailure()).toBeUndefined()
    // What the worker really confirmed, and the step before this publish, stay as they were.
    expect(store.lastGood()?.digest).toBe(good.digest)
    expect(store.report()?.ok).toBe(true)
    expect(store.previous()?.digest).toBe(good.digest)
    expect(seen).toEqual([good.digest])
  })

  it('records the failure against the package and the revert in the same step', () => {
    const { store, good } = confirmedStore()
    const bad = artifact('ext:bad')
    store.publishDesired(bad)
    store.revertDesired({
      expectedDigest: bad.digest,
      target: good,
      packages: ['pkg-bad', 'pkg-other'],
      failure: { digest: bad.digest, phase: 'apply', message: 'boom' },
      at: 'now',
    })
    expect(store.packageFailure('pkg-bad')).toEqual({
      digest: bad.digest,
      phase: 'apply',
      message: 'boom',
      at: 'now',
    })
    expect(store.packageFailure('pkg-other')?.digest).toBe(bad.digest)
    expect(store.packageFailure('pkg-fine')).toBeUndefined()
    expect(store.revertedFrom(bad.digest)).toEqual({ targetDigest: good.digest })
    expect(store.isRevertTarget(good.digest)).toBe(true)
    expect(store.isRevertTarget(bad.digest)).toBe(false)
  })

  it('writes nothing when something else was published in the meantime', () => {
    const { store, good } = confirmedStore()
    const bad = artifact('ext:bad')
    const newer = artifact('ext:newer')
    store.publishDesired(bad)
    store.publishDesired(newer)
    const applied = store.revertDesired({
      expectedDigest: bad.digest,
      target: good,
      packages: ['pkg-bad'],
      failure: { digest: bad.digest, phase: 'apply', message: 'boom' },
      at: 'now',
    })
    expect(applied).toBe(false)
    expect(store.desired()?.digest).toBe(newer.digest)
    expect(store.packageFailure('pkg-bad')).toBeUndefined()
    expect(store.revertedFrom(bad.digest)).toBeUndefined()
  })

  it('leaves no half-written revert when the write fails part way', () => {
    const { tables, store, good } = confirmedStore()
    const bad = artifact('ext:bad')
    store.publishDesired(bad)
    const handle = tables.table('composite')
    const exec = handle.exec.bind(handle)
    handle.exec = ((sql: string, params?: unknown[]) => {
      if (String(sql).includes('composite_target_reverts')) throw new Error('injected crash')
      return exec(sql, params)
    }) as typeof handle.exec
    expect(() =>
      store.revertDesired({
        expectedDigest: bad.digest,
        target: good,
        packages: ['pkg-bad'],
        failure: { digest: bad.digest, phase: 'apply', message: 'boom' },
        at: 'now',
      }),
    ).toThrow('injected crash')
    handle.exec = exec
    expect(store.desired()?.digest).toBe(bad.digest)
    expect(store.packageFailure('pkg-bad')).toBeUndefined()
  })
})

describe('per package failures', () => {
  it('replace the same package and never overwrite another one', () => {
    const { store, good } = confirmedStore()
    const bad = artifact('ext:bad')
    const worse = artifact('ext:worse')
    store.publishDesired(bad)
    store.revertDesired({
      expectedDigest: bad.digest,
      target: good,
      packages: ['pkg-a'],
      failure: { digest: bad.digest, phase: 'apply', message: 'first' },
      at: 't1',
    })
    store.publishDesired(worse)
    store.revertDesired({
      expectedDigest: worse.digest,
      target: good,
      packages: ['pkg-b'],
      failure: { digest: worse.digest, phase: 'apply', message: 'second' },
      at: 't2',
    })
    expect(store.packageFailure('pkg-a')?.message).toBe('first')
    expect(store.packageFailure('pkg-b')?.message).toBe('second')
    store.clearPackageFailure('pkg-a')
    expect(store.packageFailure('pkg-a')).toBeUndefined()
    expect(store.packageFailure('pkg-b')?.message).toBe('second')
  })

  it('are not cleared by a later confirmation of another target', () => {
    const { store, good } = confirmedStore()
    const bad = artifact('ext:bad')
    const next = artifact('ext:next')
    store.publishDesired(bad)
    store.revertDesired({
      expectedDigest: bad.digest,
      target: good,
      packages: ['pkg-a'],
      failure: { digest: bad.digest, phase: 'apply', message: 'boom' },
      at: 't',
    })
    store.publishDesired(next)
    store.qualifyConverged(1, next, { hash: next.identity.treeHash, ok: true, rows: [] })
    expect(store.packageFailure('pkg-a')?.message).toBe('boom')
  })

  it('come with a database that was created before the table existed', () => {
    const tables = sqliteTables()
    const first = new CompositeTargetStore(tables.table('composite'), 'default')
    const target = artifact('ext:one')
    first.publishDesired(target)
    const second = new CompositeTargetStore(tables.table('composite'), 'default')
    expect(second.desired()?.digest).toBe(target.digest)
    expect(second.packageFailure('pkg-a')).toBeUndefined()
  })
})

describe('revert targets', () => {
  const revertTo = (
    store: CompositeTargetStore,
    failed: ReturnType<typeof artifact>,
    target: ReturnType<typeof artifact>,
  ) =>
    store.revertDesired({
      expectedDigest: failed.digest,
      target,
      packages: ['pkg-a'],
      failure: { digest: failed.digest, phase: 'apply', message: 'boom' },
      at: 't',
    })

  it('are no longer suspect after a new target is published', () => {
    const { store, good } = confirmedStore()
    const bad = artifact('ext:bad')
    store.publishDesired(bad)
    revertTo(store, bad, good)
    expect(store.isRevertTarget(good.digest)).toBe(true)
    store.publishDesired(artifact('ext:next'))
    expect(store.isRevertTarget(good.digest)).toBe(false)
    // An old failure must not read as the fate of a later attempt at the same target.
    expect(store.revertedFrom(bad.digest)).toBeUndefined()
  })

  it('are no longer suspect once the worker confirmed them', () => {
    const { store, good } = confirmedStore()
    const bad = artifact('ext:bad')
    store.publishDesired(bad)
    revertTo(store, bad, good)
    store.qualifyConverged(1, good, { hash: good.identity.treeHash, ok: true, rows: [] })
    expect(store.isRevertTarget(good.digest)).toBe(false)
  })
})
