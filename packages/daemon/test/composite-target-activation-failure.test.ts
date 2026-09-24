import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { createCompositeTargetActivation } from '../src/composite-target-activation.js'
import { createTargetReverter } from '../src/composite-target-revert.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'b'.repeat(64)
const snap1 = `sha256-${'1'.repeat(64)}`
const snap2 = `sha256-${'2'.repeat(64)}`

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

const rowIds = (artifact: RuntimeTargetArtifact | undefined) =>
  artifact ? decodeRuntimeTargetArtifact(artifact).tree.rows.map((r) => r.id) : undefined

const good = () => target([row('ext:pkg-a/main', 'pkg-a', snap1)])
const bad = () => target([row('ext:pkg-a/main', 'pkg-a', snap1), row('ext:pkg-b/main', 'pkg-b', snap2)])

const report = (artifact: RuntimeTargetArtifact, ids: string[]) => ({
  hash: artifact.identity.treeHash,
  ok: true,
  rows: ids.map((id) => ({ id, state: 'active' })),
})

function setup(
  over: {
    settle?: { timeoutMs: number; intervalMs?: number }
    probe?: () => Promise<void>
    deliver?: (artifact: RuntimeTargetArtifact, store: CompositeTargetStore) => void
    desiredFor?: (store: CompositeTargetStore) => RuntimeTargetArtifact
    withReverter?: boolean
    workerGeneration?: () => number | undefined
  } = {},
) {
  const store = new CompositeTargetStore(sqliteTables().table('composite'), 'default')
  const first = good()
  store.publishDesired(first)
  store.qualifyConverged(1, first, report(first, ['ext:pkg-a/main']))
  const reverter = createTargetReverter({
    store,
    loadableSnapshots: async () =>
      new Map([
        [`pkg-a@${snap1}`, snap1],
        [`pkg-b@${snap2}`, snap2],
      ]),
    now: () => 'now',
  })
  const activation = createCompositeTargetActivation({
    store,
    workerGeneration: over.workerGeneration ?? (() => 1),
    contributions: () => [],
    probe: over.probe ?? (async () => {}),
    desiredFor: () => (over.desiredFor ? over.desiredFor(store) : bad()),
    deliver: async (artifact) => {
      over.deliver?.(artifact, store)
    },
    ...(over.settle ? { settle: over.settle } : {}),
    ...(over.withReverter === false ? {} : { revertFailedDesired: () => reverter.revertFailedDesired() }),
  })
  return { store, activation, first, reverter }
}

type Activation = ReturnType<typeof setup>['activation']
async function stateOf(activation: Activation, packageId: string) {
  const state = await activation.actual?.('default', packageId)
  return typeof state === 'string' ? { actual: state } : state
}

const input = (packageId: string) => ({
  profile: 'default',
  packageId,
  operationId: 'op',
  operation: 'enable' as const,
  signal: new AbortController().signal,
})

const failFrame = (store: CompositeTargetStore, artifact: RuntimeTargetArtifact) =>
  store.qualifyFailed(1, artifact, {
    generation: 1,
    digest: artifact.digest,
    identity: artifact.identity,
    phase: 'apply',
    message: 'pkg-b threw',
  })

describe('package state after a failed target', () => {
  async function failedThenConfirmed() {
    const ctx = setup({
      settle: { timeoutMs: 500, intervalMs: 2 },
      deliver: (artifact, store) => {
        setTimeout(() => failFrame(store, artifact), 5)
      },
    })
    const result = await ctx.activation.reconcile(input('pkg-b'))
    // The worker then confirms the target it was offered back.
    const back = ctx.store.desired()
    if (!back) throw new Error('expected a desired target')
    ctx.store.qualifyConverged(1, back, report(back, ['ext:pkg-a/main']))
    return { ...ctx, result }
  }

  it('shows the package the failure was held against as failed and leaves the others alone', async () => {
    const { activation } = await failedThenConfirmed()
    expect(await stateOf(activation, 'pkg-b')).toEqual({ actual: 'failed', actualReason: 'apply' })
    expect((await stateOf(activation, 'pkg-a'))?.actual).toBe('running')
  })

  it('says a failed package is stopped once the target without it was confirmed', async () => {
    const { activation } = await failedThenConfirmed()
    expect(await activation.stopped?.('default', 'pkg-b')).toBe(true)
    expect(await activation.stopped?.('default', 'pkg-a')).toBe(false)
  })

  it('does not say it is stopped while the fallback target is still waiting to be confirmed', async () => {
    const ctx = setup({
      settle: { timeoutMs: 500, intervalMs: 2 },
      deliver: (artifact, store) => {
        setTimeout(() => failFrame(store, artifact), 5)
      },
    })
    await ctx.activation.reconcile(input('pkg-b'))
    expect(await ctx.activation.stopped?.('default', 'pkg-b')).toBe(false)
  })

  it('drops a failure held against a package the confirmed target runs after all', async () => {
    const { store, activation, first } = setup()
    const next = bad()
    store.publishDesired(next)
    store.revertDesired({
      expectedDigest: next.digest,
      target: first,
      packages: ['pkg-a', 'pkg-b'],
      failure: { digest: next.digest, phase: 'apply', message: 'pkg-b threw' },
      at: 't',
    })
    const back = store.desired()
    if (!back) throw new Error('expected a desired target')
    store.qualifyConverged(1, back, report(back, ['ext:pkg-a/main']))
    expect((await stateOf(activation, 'pkg-a'))?.actual).toBe('running')
    expect(store.packageFailure('pkg-a')).toBeUndefined()
    expect((await stateOf(activation, 'pkg-b'))?.actual).toBe('failed')
  })

  it('still marks every package when a failure could not be put back', async () => {
    const { store, activation } = setup({ withReverter: false })
    const next = bad()
    store.publishDesired(next)
    failFrame(store, next)
    expect((await stateOf(activation, 'pkg-a'))?.actual).toBe('failed')
    expect((await stateOf(activation, 'pkg-b'))?.actual).toBe('failed')
  })
})

describe('reconcile waiting for its own target', () => {
  it('returns at once, as it always did, when no waiting was asked for', async () => {
    const { activation } = setup()
    const started = Date.now()
    const result = await activation.reconcile(input('pkg-b'))
    expect(Date.now() - started).toBeLessThan(100)
    expect(result.error).toBeUndefined()
  })

  it('reports the package once its target was confirmed', async () => {
    const { activation } = setup({
      settle: { timeoutMs: 500, intervalMs: 2 },
      deliver: (artifact, store) => {
        setTimeout(
          () => store.qualifyConverged(1, artifact, report(artifact, ['ext:pkg-a/main', 'ext:pkg-b/main'])),
          5,
        )
      },
    })
    const result = await activation.reconcile(input('pkg-b'))
    expect(result.error).toBeUndefined()
    expect(result.actual).toBe('running')
  })

  it('fails the operation and puts the target back when the worker could not apply it', async () => {
    const { store, activation } = setup({
      settle: { timeoutMs: 500, intervalMs: 2 },
      deliver: (artifact, s) => {
        setTimeout(() => failFrame(s, artifact), 5)
      },
    })
    const result = await activation.reconcile(input('pkg-b'))
    expect(result.actual).toBe('failed')
    expect(result.error?.code).toBe('E_PACKAGE_STATE')
    expect(rowIds(store.desired())).toEqual(['ext:pkg-a/main'])
    expect(store.packageFailure('pkg-b')?.message).toBe('pkg-b threw')
  })

  it('still fails the operation when its failure was put back and the fallback confirmed before it looked', async () => {
    const ctx = setup({
      settle: { timeoutMs: 500, intervalMs: 50 },
      deliver: (artifact, store) => {
        setTimeout(() => {
          failFrame(store, artifact)
          void ctx.reverter.revertFailedDesired().then(() => {
            const back = store.desired()
            if (back) store.qualifyConverged(1, back, report(back, ['ext:pkg-a/main']))
          })
        }, 5)
      },
    })
    const result = await ctx.activation.reconcile(input('pkg-b'))
    expect(result.error?.code).toBe('E_PACKAGE_STATE')
  })

  it('starts a worker for a target that is waiting when none is alive, instead of waiting for nothing', async () => {
    const delivered: string[] = []
    let currentGeneration: number | undefined
    const ctx = setup({
      settle: { timeoutMs: 500, intervalMs: 2 },
      workerGeneration: () => currentGeneration,
      desiredFor: () => good(),
      deliver: (artifact, store) => {
        delivered.push(artifact.digest)
        currentGeneration = 1
        store.qualifyConverged(1, artifact, report(artifact, ['ext:pkg-a/main']))
      },
    })
    const waiting = bad()
    ctx.store.publishDesired(waiting)
    const started = Date.now()
    await ctx.activation.reconcile(input('pkg-c'))
    expect(delivered[0]).toBe(waiting.digest)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('gives the answer it has when the worker does not respond in time, without failing', async () => {
    const { activation } = setup({ settle: { timeoutMs: 30, intervalMs: 5 } })
    const result = await activation.reconcile(input('pkg-b'))
    expect(result.error).toBeUndefined()
    expect(result.actual).toBe('starting')
  })

  it('reverts a target that had failed before composing the next one on top of it', async () => {
    const seen: Array<string[] | undefined> = []
    const { store, activation } = setup({
      settle: { timeoutMs: 30, intervalMs: 5 },
      desiredFor: (s) => {
        seen.push(rowIds(s.desired()))
        return good()
      },
    })
    const stuck = bad()
    store.publishDesired(stuck)
    failFrame(store, stuck)
    await activation.reconcile(input('pkg-c'))
    expect(seen).toEqual([['ext:pkg-a/main']])
  })

  it('clears the old failure of the package only once its new target was published', async () => {
    const ctx = setup({
      settle: { timeoutMs: 500, intervalMs: 2 },
      deliver: (artifact, store) => {
        setTimeout(() => failFrame(store, artifact), 5)
      },
    })
    await ctx.activation.reconcile(input('pkg-b'))
    expect(ctx.store.packageFailure('pkg-b')).toBeDefined()

    const broken = setup({
      settle: { timeoutMs: 500, intervalMs: 2 },
      deliver: (artifact, store) => {
        setTimeout(() => failFrame(store, artifact), 5)
      },
    })
    await broken.activation.reconcile(input('pkg-b'))
    let probeFails = true
    const again = createCompositeTargetActivation({
      store: broken.store,
      workerGeneration: () => 1,
      contributions: () => [],
      probe: async () => {
        if (probeFails) throw new Error('probe refused')
      },
      desiredFor: () => bad(),
      deliver: async () => {},
    })
    await expect(again.reconcile(input('pkg-b'))).rejects.toThrow('probe refused')
    expect(broken.store.packageFailure('pkg-b')).toBeDefined()
    probeFails = false
    await again.reconcile(input('pkg-b'))
    expect(broken.store.packageFailure('pkg-b')).toBeUndefined()
  })
})
