import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { idle, settle } from '../src/composite-target-settle.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'f'.repeat(64)

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

const store = () => new CompositeTargetStore(sqliteTables().table('composite'), 'default')
const confirm = (s: CompositeTargetStore, a: ReturnType<typeof artifact>) =>
  s.qualifyConverged(1, a, { hash: a.identity.treeHash, ok: true, rows: [] })
const options = { timeoutMs: 400, intervalMs: 2 }

describe('settle', () => {
  it('waits for the current worker generation when the same digest is republished', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    confirm(s, a)
    s.publishDesired(a)
    expect(s.pending(2)).toBe(true)
    setTimeout(() => s.qualifyConverged(2, a, { hash: a.identity.treeHash, ok: true, rows: [] }), 20)
    expect(await settle(s, a.digest, { ...options, workerGeneration: () => 2 })).toBe('converged')
    expect(s.pending(2)).toBe(false)
  })

  it('sees a target that was already confirmed at once', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    confirm(s, a)
    expect(await settle(s, a.digest, options)).toBe('converged')
  })

  it('waits for the confirmation', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    setTimeout(() => confirm(s, a), 20)
    expect(await settle(s, a.digest, options)).toBe('converged')
  })

  it('reports a failure that has not been put back yet', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    setTimeout(
      () =>
        s.qualifyFailed(1, a, {
          generation: 1,
          digest: a.digest,
          identity: a.identity,
          phase: 'apply',
          message: 'x',
        }),
      20,
    )
    expect(await settle(s, a.digest, options)).toBe('failed')
  })

  it('reports a failure that was already put back, even when no package could be named', async () => {
    const s = store()
    const good = artifact('ext:good')
    s.publishDesired(good)
    confirm(s, good)
    const bad = artifact('ext:bad')
    s.publishDesired(bad)
    setTimeout(
      () =>
        s.revertDesired({
          expectedDigest: bad.digest,
          target: good,
          packages: [],
          failure: { digest: bad.digest, phase: 'apply', message: 'x' },
          at: 't',
        }),
      20,
    )
    expect(await settle(s, bad.digest, options)).toBe('failed')
  })

  it('does not report an earlier failure of the same target once it was recovered from and tried again', async () => {
    const s = store()
    const good = artifact('ext:good')
    s.publishDesired(good)
    confirm(s, good)
    const bad = artifact('ext:bad')
    s.publishDesired(bad)
    s.revertDesired({
      expectedDigest: bad.digest,
      target: good,
      packages: [],
      failure: { digest: bad.digest, phase: 'boot', message: 'timed out' },
      at: 't',
    })
    confirm(s, good)
    s.publishDesired(bad)
    setTimeout(() => confirm(s, bad), 20)
    expect(await settle(s, bad.digest, options)).toBe('converged')
  })

  it('reports being replaced by something else', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    setTimeout(() => s.publishDesired(artifact('ext:b')), 20)
    expect(await settle(s, a.digest, options)).toBe('superseded')
  })

  it('gives up waiting when nothing can be delivered any more', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    expect(await settle(s, a.digest, { ...options, deliverable: () => false })).toBe('undeliverable')
  })

  it('stops when the operation is cancelled', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    expect(await settle(s, a.digest, { ...options, signal: controller.signal })).toBe('aborted')
  })

  it('times out without throwing', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    expect(await settle(s, a.digest, { timeoutMs: 30, intervalMs: 5 })).toBe('timeout')
  })
})

describe('idle', () => {
  it('does not treat a previous generation acknowledgement as idle', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    confirm(s, a)
    s.publishDesired(a)
    setTimeout(() => s.qualifyConverged(2, a, { hash: a.identity.treeHash, ok: true, rows: [] }), 20)
    await idle(s, { ...options, workerGeneration: () => 2 })
    expect(s.acknowledged()?.generation).toBe(2)
  })

  it('returns at once when nothing is waiting to be confirmed', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    confirm(s, a)
    const started = Date.now()
    await idle(s, options)
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('waits until the pending target is confirmed', async () => {
    const s = store()
    const a = artifact('ext:a')
    s.publishDesired(a)
    setTimeout(() => confirm(s, a), 30)
    await idle(s, options)
    expect(s.pending()).toBe(false)
  })

  it('gives up after the time limit', async () => {
    const s = store()
    s.publishDesired(artifact('ext:a'))
    const started = Date.now()
    await idle(s, { timeoutMs: 40, intervalMs: 5 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    expect(s.pending()).toBe(true)
  })

  it('does not wait when nothing can be delivered', async () => {
    const s = store()
    s.publishDesired(artifact('ext:a'))
    const started = Date.now()
    await idle(s, { ...options, deliverable: () => false })
    expect(Date.now() - started).toBeLessThan(100)
  })
})
