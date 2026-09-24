import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { PreviewUpdate } from '../src/registry.js'
import { WorkerRegistry } from '../src/supervisor/registry.js'
import { PREVIEW_SNAPSHOT_TIMEOUT_MS } from '../src/supervisor/remote-session.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'
import { workspaceBinding } from './workspace-authority.js'

const update: PreviewUpdate = { lane: 'main', effectId: 'e1', stream: 'text', offset: 0, delta: 'hi' }

function fakeLink(command: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  return {
    alive: true,
    hello: Promise.resolve({
      kind: 'hello' as const,
      token: 'token',
      sessionKey: 's',
      writerRunId: 'run',
      generation: 1,
      profileHash: 'sha256-profile',
    }),
    onExit: vi.fn(),
    closeSession: vi.fn(async () => undefined),
    command,
  }
}

async function openWith(registry: WorkerRegistry, key: string) {
  return registry.open({
    key,
    cwd: '/workspace',
    resume: true,
    binding: await workspaceBinding(key, '/workspace'),
  })
}

describe('WorkerRegistry live previews', () => {
  it('fans a preview out to every subscriber and stops after unsubscribe and close', async () => {
    const link = fakeLink(async (method) => (method === 'scan' ? [] : undefined))
    const registry = new WorkerRegistry({ acquire: vi.fn(async () => link) } as unknown as WorkerPool)
    await openWith(registry, 's')
    const a: PreviewUpdate[] = []
    const b: PreviewUpdate[] = []
    const offA = registry.subscribePreview('s', (p) => a.push(p))
    registry.subscribePreview('s', () => {
      throw new Error('broken viewer')
    })
    registry.subscribePreview('s', (p) => b.push(p))
    registry.deliverPreview('s', update)
    expect(a).toEqual([update])
    expect(b).toEqual([update])
    offA()
    registry.deliverPreview('s', { ...update, offset: 2, delta: '!' })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
    await registry.close('s')
    registry.deliverPreview('s', update)
    expect(b).toHaveLength(2)
  })

  it('does not let a preview overtake an event still being projected for artifact authority', async () => {
    const link = fakeLink(async (method) => (method === 'scan' ? [] : undefined))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const lifecycle = { resetSession: vi.fn(), observe: vi.fn(async () => gate) }
    const registry = new WorkerRegistry(
      { acquire: vi.fn(async () => link) } as unknown as WorkerPool,
      lifecycle,
    )
    await openWith(registry, 's')
    const order: string[] = []
    registry.subscribe('s', (e) => order.push(`event:${e.seq}`))
    registry.subscribePreview('s', (p) => order.push(`preview:${p.delta}`))
    const delivering = registry.deliver('s', {
      seq: 1,
      type: 'assistant/output',
      lane: 'main',
    } as EventEnvelope)
    registry.deliverPreview('s', update)
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await delivering
    await vi.waitFor(() => expect(order).toEqual(['event:1', 'preview:hi']))
  })

  it('asks viewers to catch up once a reopened generation has replayed', async () => {
    let exit!: () => void
    let releaseScan!: () => void
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve
    })
    let generation = 0
    const acquire = vi.fn(async () => {
      const second = ++generation === 2
      const link = fakeLink(async (method) => {
        if (method !== 'scan') return undefined
        if (second) await scanGate
        return []
      })
      link.onExit = vi.fn((fn: () => void) => {
        if (!second) exit = fn
      })
      return link
    })
    const lifecycle = { resetSession: vi.fn(), observe: vi.fn(async () => undefined) }
    const registry = new WorkerRegistry({ acquire } as unknown as WorkerPool, lifecycle)
    await openWith(registry, 's')
    const seen: string[] = []
    registry.subscribePreview(
      's',
      (p) => seen.push(p.delta),
      () => seen.push('catch up'),
    )
    exit()
    const reopening = openWith(registry, 's')
    const buffers = (registry as unknown as { artifactReplayBuffers: Map<string, unknown> })
      .artifactReplayBuffers
    await vi.waitFor(() => expect(buffers.has('s')).toBe(true))
    // Held back by the replay, so this viewer never sees it live.
    registry.deliverPreview('s', update)
    expect(seen).toEqual([])
    releaseScan()
    await reopening
    expect(seen).toEqual(['catch up'])
  })

  it('asks the hosting worker for the snapshot', async () => {
    const snapshot = [{ lane: 'main', effectId: 'e1', text: 'so far', thinking: '' }]
    const command = vi.fn(async (method: string) => {
      if (method === 'scan') return []
      if (method === 'previewSnapshot') return snapshot
      return undefined
    })
    const registry = new WorkerRegistry({
      acquire: vi.fn(async () => fakeLink(command)),
    } as unknown as WorkerPool)
    await openWith(registry, 's')
    await expect(registry.previewSnapshot('s')).resolves.toEqual(snapshot)
    // Bounded: a viewer holds its live previews until this answers.
    expect(command).toHaveBeenCalledWith('previewSnapshot', {}, { timeoutMs: PREVIEW_SNAPSHOT_TIMEOUT_MS })
  })
})
