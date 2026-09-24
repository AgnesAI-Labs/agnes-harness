import { getEventListeners } from 'node:events'
import type { ProbeReport } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeAdapter } from '../src/quality/probe.js'
import { FakeAdapter } from '../testkit/index.js'

const adapter = () => new FakeAdapter({ id: 'test', routes: [], models: {} })
const report = (): ProbeReport => ({
  route: 'r',
  ok: true,
  latencyMs: 1,
  checks: [{ name: 'transport', ok: true }],
})
const signal = () => new AbortController().signal
afterEach(() => vi.useRealTimers())
describe('bounded adapter probe', () => {
  it('does not report a missing probe as healthy', async () => {
    expect(await probeAdapter(adapter(), 'r', { signal: signal() })).toMatchObject({
      ok: false,
      checks: [{ name: 'probe', ok: false, detail: 'adapter does not implement probe' }],
    })
  })
  it('copies valid reports and closes the invocation signal after success', async () => {
    const a = adapter(),
      original = report(),
      parent = signal()
    let invocation: AbortSignal | undefined
    a.probe = async (_route, s) => {
      invocation = s
      return original
    }
    const result = await probeAdapter(a, 'r', { signal: parent })
    expect(result).toEqual(original)
    const check = original.checks[0]
    if (!check) throw new Error('missing check')
    check.ok = false
    expect(result.checks[0]?.ok).toBe(true)
    expect(invocation?.aborted).toBe(true)
    expect(getEventListeners(parent, 'abort')).toHaveLength(0)
  })
  it('does not invoke an already cancelled probe', async () => {
    const a = adapter(),
      ac = new AbortController()
    a.probe = vi.fn(async () => report())
    ac.abort()
    expect((await probeAdapter(a, 'r', { signal: ac.signal })).ok).toBe(false)
    expect(a.probe).not.toHaveBeenCalled()
  })
  it('settles parent cancellation even when the adapter ignores the signal', async () => {
    const a = adapter(),
      ac = new AbortController()
    a.probe = async () => new Promise(() => {})
    const running = probeAdapter(a, 'r', { signal: ac.signal })
    await Promise.resolve()
    ac.abort()
    expect(await running).toMatchObject({
      ok: false,
      checks: [{ name: 'probe', ok: false, detail: 'probe aborted' }],
    })
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  })
  it('enforces the default 30 second deadline and cleans up listeners and timers', async () => {
    vi.useFakeTimers()
    const a = adapter(),
      parent = signal()
    a.probe = async () => new Promise(() => {})
    let ended = false
    const running = probeAdapter(a, 'r', { signal: parent }).then((r) => {
      ended = true
      return r
    })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(true)
    expect((await running).ok).toBe(false)
    expect(getEventListeners(parent, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not expose a thrown adapter error', async () => {
    const a = adapter()
    a.probe = async () => {
      throw new Error('private adapter failure')
    }
    const result = await probeAdapter(a, 'r', { signal: signal() })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private adapter failure')
  })
  it.each([
    { ...report(), route: 'other' },
    { ...report(), latencyMs: -1 },
    { ...report(), checks: [] },
    { ...report(), checks: [{ name: 'failed', ok: false }] },
    { ...report(), extra: true },
  ])('rejects invalid or inconsistent evidence %j', async (value) => {
    const a = adapter()
    a.probe = async () => value
    expect((await probeAdapter(a, 'r', { signal: signal() })).ok).toBe(false)
  })
  it('rejects report getters without invoking them', async () => {
    const a = adapter(),
      getter = vi.fn(() => 'r')
    a.probe = async () => ({
      ...report(),
      get route() {
        return getter()
      },
    })
    expect((await probeAdapter(a, 'r', { signal: signal() })).ok).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
})
