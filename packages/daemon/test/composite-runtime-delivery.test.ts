import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { CompositeRuntimeDelivery, deliverDesiredToWorkers } from '../src/composite-runtime-delivery.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'e'.repeat(64)

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

describe('CompositeRuntimeDelivery', () => {
  it('boots from lastGood and only qualifies a matching current desired converged frame', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const lastGood = artifact('ext:good')
    const newer = artifact('ext:new')
    store.publishDesired(lastGood)
    expect(
      store.qualifyConverged(1, lastGood, { hash: lastGood.identity.treeHash, ok: true, rows: [] }),
    ).toBe(true)
    store.publishDesired(newer)
    const delivery = new CompositeRuntimeDelivery(store)
    const boot = delivery.bootFor(4)
    expect(boot).toEqual({ artifact: lastGood, source: 'lastGood' })
    if (!boot) throw new Error('expected lastGood boot')
    const admission = delivery.beginBoot(4, boot)
    expect(
      delivery.handleWorkerFrame(4, {
        type: 'runtime.boot_ready',
        workerKind: 'session',
        workerKey: '@shared',
        generation: 4,
        digest: lastGood.digest,
        identity: lastGood.identity,
        source: 'lastGood',
      }),
    ).toBe(true)
    expect(admission.ready).toBe(true)
    expect(
      delivery.handleWorkerFrame(4, {
        type: 'runtime.converged',
        workerKind: 'session',
        workerKey: '@shared',
        generation: 4,
        digest: lastGood.digest,
        identity: lastGood.identity,
        report: { hash: lastGood.identity.treeHash, ok: true, rows: [] },
      }),
    ).toBe(false)
    expect(store.pending()).toBe(true)
    expect(
      delivery.handleWorkerFrame(4, {
        type: 'runtime.converged',
        workerKind: 'session',
        workerKey: '@shared',
        generation: 4,
        digest: newer.digest,
        identity: newer.identity,
        report: { hash: newer.identity.treeHash, ok: true, rows: [{ id: 'ext:new', state: 'active' }] },
      }),
    ).toBe(true)
    expect(store.pending()).toBe(false)
    expect(store.lastGood()?.digest).toBe(newer.digest)
  })

  it('uses desired as bootstrap when there is no lastGood and ignores a stale failure', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const first = artifact('ext:boot')
    const second = artifact('ext:next')
    store.publishDesired(first)
    const delivery = new CompositeRuntimeDelivery(store)
    const boot = delivery.bootFor(1)
    expect(boot?.source).toBe('bootstrap')
    if (!boot) throw new Error('expected bootstrap')
    delivery.beginBoot(1, boot)
    store.publishDesired(second)
    expect(
      delivery.handleWorkerFrame(1, {
        type: 'runtime.apply_failed',
        workerKind: 'session',
        workerKey: '@shared',
        generation: 1,
        digest: first.digest,
        identity: first.identity,
        phase: 'apply',
        message: 'stale',
      }),
    ).toBe(false)
    expect(store.lastFailure()).toBeUndefined()
  })

  it('offers a live Host worker the new desired, otherwise acquires the shared worker', async () => {
    const offered: string[] = []
    const acquired: string[] = []
    const target = artifact('ext:live')
    await deliverDesiredToWorkers(
      {
        businessWorker: () => ({
          link: { offerRuntimeTarget: (next) => offered.push(next.digest) },
        }),
        acquireSharedWorker: async () => {
          acquired.push('shared')
        },
      },
      target,
    )
    expect(offered).toEqual([target.digest])
    expect(acquired).toEqual([])
    let shared: { link: { offerRuntimeTarget(artifact: typeof target): void } } | undefined
    await deliverDesiredToWorkers(
      {
        businessWorker: () => shared,
        acquireSharedWorker: async () => {
          acquired.push('shared')
          shared = { link: { offerRuntimeTarget: (next) => offered.push(next.digest) } }
        },
      },
      target,
    )
    expect(acquired).toEqual(['shared'])
    expect(offered).toEqual([target.digest, target.digest])
  })
})

describe('CompositeRuntimeDelivery failure handling', () => {
  const failedFrame = (generation: number, target: ReturnType<typeof artifact>) => ({
    type: 'runtime.apply_failed',
    workerKind: 'session',
    workerKey: '@shared',
    generation,
    digest: target.digest,
    identity: target.identity,
    phase: 'apply',
    message: 'plugin did not start',
  })

  function withDelivery(onFailureRecorded?: () => void) {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    return { store, delivery: new CompositeRuntimeDelivery(store, { onFailureRecorded }) }
  }

  it('tells its owner when a failure for the current desired target was recorded', async () => {
    let calls = 0
    const { store, delivery } = withDelivery(() => {
      calls += 1
    })
    const bad = artifact('ext:bad')
    store.publishDesired(bad)
    expect(delivery.handleWorkerFrame(2, failedFrame(2, bad))).toBe(true)
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(store.lastFailure()?.digest).toBe(bad.digest)
  })

  it('stays quiet about a failure for a target that is no longer desired', async () => {
    let calls = 0
    const { store, delivery } = withDelivery(() => {
      calls += 1
    })
    const stale = artifact('ext:stale')
    store.publishDesired(stale)
    store.publishDesired(artifact('ext:newer'))
    expect(delivery.handleWorkerFrame(2, failedFrame(2, stale))).toBe(false)
    await Promise.resolve()
    expect(calls).toBe(0)
  })

  it('still records the failure when the owner throws', async () => {
    const { store, delivery } = withDelivery(() => {
      throw new Error('owner broke')
    })
    const bad = artifact('ext:bad')
    store.publishDesired(bad)
    expect(delivery.handleWorkerFrame(2, failedFrame(2, bad))).toBe(true)
    await Promise.resolve()
    expect(store.lastFailure()?.digest).toBe(bad.digest)
  })

  describe('a worker that could not apply the target it is booting from', () => {
    it('fails the boot at once instead of leaving it to time out', async () => {
      const { store, delivery } = withDelivery()
      const bad = artifact('ext:bad')
      store.publishDesired(bad)
      const boot = delivery.bootFor(5)
      if (!boot) throw new Error('expected a boot target')
      const admission = delivery.beginBoot(5, boot)
      const waiting = admission.whenReady()
      expect(delivery.handleWorkerFrame(5, failedFrame(5, bad))).toBe(true)
      await expect(waiting).rejects.toThrow('plugin did not start')
      expect(admission.ready).toBe(false)
    })

    it('fails the boot of the last confirmed target too, without blaming the desired one', async () => {
      const { store, delivery } = withDelivery()
      const good = artifact('ext:good')
      store.publishDesired(good)
      store.qualifyConverged(1, good, { hash: good.identity.treeHash, ok: true, rows: [] })
      store.publishDesired(artifact('ext:newer'))
      const boot = delivery.bootFor(5)
      if (!boot) throw new Error('expected a boot target')
      const admission = delivery.beginBoot(5, boot)
      const waiting = admission.whenReady()
      expect(delivery.handleWorkerFrame(5, failedFrame(5, good))).toBe(false)
      await expect(waiting).rejects.toThrow('plugin did not start')
      expect(store.lastFailure()).toBeUndefined()
    })

    it('leaves a boot that already succeeded alone', async () => {
      const { store, delivery } = withDelivery()
      const target = artifact('ext:a')
      store.publishDesired(target)
      const boot = delivery.bootFor(5)
      if (!boot) throw new Error('expected a boot target')
      const admission = delivery.beginBoot(5, boot)
      admission.admit(admission.expected)
      delivery.handleWorkerFrame(5, failedFrame(5, target))
      await expect(admission.whenReady()).resolves.toBeUndefined()
    })
  })

  describe('recordBootFailure', () => {
    it('records a boot that could not start the desired target itself, and says it was the target', async () => {
      let calls = 0
      const { store, delivery } = withDelivery(() => {
        calls += 1
      })
      const bad = artifact('ext:bad')
      store.publishDesired(bad)
      const boot = delivery.bootFor(3)
      if (!boot) throw new Error('expected a boot target')
      expect(boot.source).toBe('bootstrap')
      expect(delivery.recordBootFailure(3, boot, new Error('did not boot_ready within 30000 ms'))).toBe(true)
      await Promise.resolve()
      expect(store.lastFailure()).toMatchObject({ digest: bad.digest, phase: 'boot' })
      expect(calls).toBe(1)
    })

    it('still says it was the target when the failure frame already got the target put back', () => {
      const { store, delivery } = withDelivery()
      const bad = artifact('ext:bad')
      store.publishDesired(bad)
      const boot = delivery.bootFor(3)
      if (!boot) throw new Error('expected a boot target')
      store.revertDesired({
        expectedDigest: bad.digest,
        target: artifact('ext:fallback'),
        packages: [],
        failure: { digest: bad.digest, phase: 'apply', message: 'first' },
        at: 't',
      })
      expect(delivery.recordBootFailure(3, boot, new Error('late'))).toBe(true)
      expect(store.lastFailure()).toBeUndefined()
    })

    it('does not exempt the start when the desired target had moved on for another reason', () => {
      const { store, delivery } = withDelivery()
      store.publishDesired(artifact('ext:bad'))
      const boot = delivery.bootFor(3)
      if (!boot) throw new Error('expected a boot target')
      store.publishDesired(artifact('ext:unrelated'))
      expect(delivery.recordBootFailure(3, boot, new Error('late'))).toBe(false)
      expect(store.lastFailure()).toBeUndefined()
    })

    it('does not blame the desired target for a lastGood boot that failed', () => {
      const { store, delivery } = withDelivery()
      const good = artifact('ext:good')
      store.publishDesired(good)
      store.qualifyConverged(1, good, { hash: good.identity.treeHash, ok: true, rows: [] })
      store.publishDesired(artifact('ext:newer'))
      const boot = delivery.bootFor(3)
      if (!boot) throw new Error('expected a boot target')
      expect(boot.source).toBe('lastGood')
      expect(delivery.recordBootFailure(3, boot, new Error('boom'))).toBe(false)
      expect(store.lastFailure()).toBeUndefined()
    })
  })
})
