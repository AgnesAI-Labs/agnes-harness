import {
  buildRuntimeTarget,
  encodeRuntimeTargetArtifact,
  type RuntimeTarget,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeTargetSlot } from '../src/runtime-target-slot.js'

function artifact(revision: string): RuntimeTargetArtifact {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [],
      resourceRevision: revision.repeat(64),
      compositeRevision: revision.repeat(64),
      resources: { mcp: [], skills: {} },
    }),
  )
}

function frame(value: RuntimeTargetArtifact) {
  return { type: 'runtime.stale', artifact: structuredClone(value) }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('runtime target latest-wins slot', () => {
  it('serializes Host apply and retains only the latest complete target while one is in flight', async () => {
    const first = deferred<string>()
    const calls: RuntimeTarget[] = []
    let active = 0
    let peak = 0
    const applyRuntimeTarget = vi.fn(async (target: RuntimeTarget) => {
      calls.push(target)
      active += 1
      peak = Math.max(peak, active)
      try {
        if (calls.length === 1) return await first.promise
        return target.resource.target.compositeRevision
      } finally {
        active -= 1
      }
    })
    const slot = createRuntimeTargetSlot({ applyRuntimeTarget })
    const a = artifact('a')
    const b = artifact('b')
    const c = artifact('c')

    const applyingA = slot.offer(frame(a))
    const supersededB = slot.offer(frame(b))
    const applyingC = slot.offer(frame(c))

    await expect(supersededB).resolves.toMatchObject({
      status: 'superseded',
      artifact: { digest: b.digest },
      supersededBy: c.digest,
    })
    expect(applyRuntimeTarget).toHaveBeenCalledOnce()
    first.resolve('first')

    await expect(applyingA).resolves.toMatchObject({ status: 'applied', changed: true, value: 'first' })
    await expect(applyingC).resolves.toMatchObject({
      status: 'applied',
      changed: true,
      value: c.identity.compositeRevision,
    })
    expect(calls.map((target) => target.resource.target.compositeRevision)).toEqual([
      a.identity.compositeRevision,
      c.identity.compositeRevision,
    ])
    expect(peak).toBe(1)
  })

  it('coalesces an in-flight digest and treats an already-applied digest as idempotent', async () => {
    const gate = deferred<void>()
    const applyRuntimeTarget = vi.fn(async () => gate.promise)
    const slot = createRuntimeTargetSlot({ applyRuntimeTarget })
    const a = artifact('a')

    const first = slot.offer(frame(a))
    const duplicate = slot.offer(frame(a))
    expect(applyRuntimeTarget).toHaveBeenCalledOnce()
    gate.resolve()

    await expect(first).resolves.toMatchObject({ status: 'applied', changed: true })
    await expect(duplicate).resolves.toMatchObject({ status: 'applied', changed: true })
    await expect(slot.offer(frame(a))).resolves.toMatchObject({ status: 'applied', changed: false })
    expect(applyRuntimeTarget).toHaveBeenCalledOnce()
  })

  it('lets a repeat of the active digest supersede a different queued target', async () => {
    const gate = deferred<void>()
    const applyRuntimeTarget = vi.fn(async () => gate.promise)
    const slot = createRuntimeTargetSlot({ applyRuntimeTarget })
    const a = artifact('a')
    const b = artifact('b')

    const firstA = slot.offer(frame(a))
    const queuedB = slot.offer(frame(b))
    const latestA = slot.offer(frame(a))

    await expect(queuedB).resolves.toMatchObject({
      status: 'superseded',
      supersededBy: a.digest,
    })
    gate.resolve()
    await expect(Promise.all([firstA, latestA])).resolves.toEqual([
      expect.objectContaining({ status: 'applied', changed: true }),
      expect.objectContaining({ status: 'applied', changed: true }),
    ])
    expect(applyRuntimeTarget).toHaveBeenCalledOnce()
  })

  it('queues the previously applied digest when a different target is already in flight', async () => {
    const second = deferred<void>()
    const calls: string[] = []
    const slot = createRuntimeTargetSlot({
      applyRuntimeTarget: async (target) => {
        calls.push(target.resource.target.compositeRevision)
        if (calls.length === 2) await second.promise
      },
    })
    const a = artifact('a')
    const b = artifact('b')

    await expect(slot.offer(frame(a))).resolves.toMatchObject({ status: 'applied', changed: true })
    const applyingB = slot.offer(frame(b))
    const restoringA = slot.offer(frame(a))
    expect(calls).toEqual([a.identity.compositeRevision, b.identity.compositeRevision])

    second.resolve()
    await expect(applyingB).resolves.toMatchObject({ status: 'applied', changed: true })
    await expect(restoringA).resolves.toMatchObject({ status: 'applied', changed: true })
    expect(calls).toEqual([
      a.identity.compositeRevision,
      b.identity.compositeRevision,
      a.identity.compositeRevision,
    ])
  })

  it('continues with the latest queued target after an apply failure', async () => {
    const first = deferred<void>()
    const failure = new Error('candidate failed')
    const a = artifact('a')
    const b = artifact('b')
    const calls: string[] = []
    const slot = createRuntimeTargetSlot({
      applyRuntimeTarget: async (target) => {
        calls.push(target.resource.target.compositeRevision)
        if (calls.length === 1) return first.promise
        return 'recovered'
      },
    })

    const failedA = slot.offer(frame(a))
    const appliedB = slot.offer(frame(b))
    first.reject(failure)

    await expect(failedA).resolves.toMatchObject({ status: 'failed', error: failure })
    await expect(appliedB).resolves.toMatchObject({
      status: 'applied',
      changed: true,
      value: 'recovered',
    })
    expect(calls).toEqual([a.identity.compositeRevision, b.identity.compositeRevision])
  })

  it('keeps draining when an unusual thenable synchronously reenters offer and then throws', async () => {
    const failure = new Error('throwing thenable')
    const a = artifact('a')
    const b = artifact('b')
    const calls: string[] = []
    let reentrant: Promise<unknown> | undefined
    let slot: ReturnType<typeof createRuntimeTargetSlot<string>>
    slot = createRuntimeTargetSlot({
      applyRuntimeTarget(target) {
        calls.push(target.resource.target.compositeRevision)
        if (calls.length !== 1) return 'recovered'
        return {
          // biome-ignore lint/suspicious/noThenProperty: this regression deliberately exercises a hostile thenable.
          then() {
            reentrant = slot.offer(frame(b))
            throw failure
          },
        } as PromiseLike<string>
      },
    })

    await expect(slot.offer(frame(a))).resolves.toMatchObject({ status: 'failed', error: failure })
    await expect(reentrant).resolves.toMatchObject({
      status: 'applied',
      changed: true,
      value: 'recovered',
    })
    expect(calls).toEqual([a.identity.compositeRevision, b.identity.compositeRevision])
  })

  it('does not let a failed digest poison a later retry of the same target', async () => {
    const failure = new Error('first attempt failed')
    let attempts = 0
    const slot = createRuntimeTargetSlot({
      applyRuntimeTarget: async () => {
        attempts += 1
        if (attempts === 1) throw failure
        return 'retried'
      },
    })
    const a = artifact('a')

    await expect(slot.offer(frame(a))).resolves.toMatchObject({ status: 'failed', error: failure })
    await expect(slot.offer(frame(a))).resolves.toMatchObject({
      status: 'applied',
      changed: true,
      value: 'retried',
    })
    expect(attempts).toBe(2)
  })

  it('snapshots a queued frame before caller mutation can affect its later Host apply', async () => {
    const first = deferred<void>()
    const received: RuntimeTarget[] = []
    const slot = createRuntimeTargetSlot({
      applyRuntimeTarget: async (target) => {
        received.push(target)
        if (received.length === 1) await first.promise
      },
    })
    const active = slot.offer(frame(artifact('a')))
    const expected = artifact('b')
    const input = frame(expected) as unknown as {
      type: string
      artifact: {
        encoding: 'base64'
        canonicalBase64: string
        digest: string
        identity: { treeHash: string; resourceRevision: string; compositeRevision: string }
      }
    }

    const result = slot.offer(input)
    input.type = 'forged'
    input.artifact.canonicalBase64 = 'e30='
    input.artifact.digest = `sha256-${'0'.repeat(64)}`
    input.artifact.identity.compositeRevision = 'f'.repeat(64)

    expect(received).toHaveLength(1)
    first.resolve()
    await expect(active).resolves.toMatchObject({ status: 'applied' })
    await expect(result).resolves.toMatchObject({
      status: 'applied',
      artifact: expected,
    })
    expect(received[1]?.resource.target).toEqual(expected.identity)
    expect(Object.isFrozen(received[1])).toBe(true)
  })

  it('rejects an invalid frame without invoking Host', async () => {
    const applyRuntimeTarget = vi.fn()
    const slot = createRuntimeTargetSlot({ applyRuntimeTarget })

    await expect(slot.offer({ type: 'runtime.stale', target: {} })).rejects.toThrow('E_RUNTIME_STALE_FRAME')
    expect(applyRuntimeTarget).not.toHaveBeenCalled()
  })
})
