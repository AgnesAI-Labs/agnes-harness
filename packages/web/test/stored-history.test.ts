import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStoredHistory } from '../src/app/stored-history.js'

afterEach(() => {
  vi.useRealTimers()
})

const view = { timeline: { nodes: [{ id: 'n1' }] }, hasEarlier: true }

function harness(storedOpening: (id: string) => Promise<{ timeline: unknown; hasEarlier: boolean }>) {
  const shown: Array<{ id: string; timeline: unknown; hasEarlier: boolean; reason?: string }> = []
  const clear = vi.fn()
  const read = vi.fn(storedOpening)
  const history = createStoredHistory({
    storedOpening: read,
    show: (v) => shown.push(v),
    clear,
    delayMs: 10_000,
  })
  return { history, shown, clear, read }
}

describe('stored history while a session opens', () => {
  it('shows the stored history read-only after 10 s, and switches to the live session when load finishes', async () => {
    vi.useFakeTimers()
    const h = harness(async () => view)
    h.history.started('s1')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(h.read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.read).toHaveBeenCalledWith('s1')
    expect(h.shown).toEqual([{ id: 's1', ...view }])
    h.history.succeeded()
    expect(h.clear).toHaveBeenCalledTimes(1)
  })

  it('never reads the stored history for a load that finishes within 10 s', async () => {
    vi.useFakeTimers()
    const h = harness(async () => view)
    h.history.started('s1')
    await vi.advanceTimersByTimeAsync(5_000)
    h.history.succeeded()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.read).not.toHaveBeenCalled()
    expect(h.shown).toEqual([])
    expect(h.clear).not.toHaveBeenCalled()
  })

  it('keeps the read-only history with the reason when load fails, whatever the error', async () => {
    vi.useFakeTimers()
    const h = harness(async () => view)
    h.history.started('s1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await h.history.failed('s1', 'load stalled')).toBe(true)
    expect(h.shown.at(-1)).toEqual({ id: 's1', ...view, reason: 'load stalled' })
    expect(h.clear).not.toHaveBeenCalled()
  })

  it('reads the stored history on a failure that comes before 10 s', async () => {
    vi.useFakeTimers()
    const h = harness(async () => view)
    h.history.started('s1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await h.history.failed('s1', 'E_LEDGER_INTEGRITY')).toBe(true)
    expect(h.shown).toEqual([{ id: 's1', ...view, reason: 'E_LEDGER_INTEGRITY' }])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.read).toHaveBeenCalledTimes(1)
  })

  it('reports false when the stored history cannot be read either', async () => {
    vi.useFakeTimers()
    const h = harness(async () => {
      throw new Error('stored-opening-unavailable')
    })
    h.history.started('s1')
    expect(await h.history.failed('s1', 'open failed')).toBe(false)
    expect(h.shown).toEqual([])
  })

  it('does not show a stored history that arrives after the live session took over', async () => {
    vi.useFakeTimers()
    let resolve!: (v: typeof view) => void
    const h = harness(() => new Promise((r) => (resolve = r)))
    h.history.started('s1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.read).toHaveBeenCalledTimes(1)
    h.history.succeeded()
    resolve(view)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.shown).toEqual([])
  })

  it('takes down a history left by an earlier open once the next open settles', async () => {
    vi.useFakeTimers()
    let available = true
    const h = harness(async () => {
      if (!available) throw new Error('stored-opening-unavailable')
      return view
    })
    h.history.started('s1')
    expect(await h.history.failed('s1', 'open failed')).toBe(true)
    available = false
    h.history.started('s2')
    expect(h.clear).not.toHaveBeenCalled()
    expect(await h.history.failed('s2', 'open failed')).toBe(false)
    expect(h.clear).toHaveBeenCalledTimes(1)

    available = true
    h.history.started('s3')
    expect(await h.history.failed('s3', 'open failed')).toBe(true)
    h.history.started('s4')
    h.history.succeeded()
    expect(h.clear).toHaveBeenCalledTimes(2)
  })

  it('forgets the previous session when another one starts opening', async () => {
    vi.useFakeTimers()
    const h = harness(async (id) => ({ ...view, timeline: { id } }))
    h.history.started('s1')
    await vi.advanceTimersByTimeAsync(5_000)
    h.history.started('s2')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.read.mock.calls).toEqual([['s2']])
    expect(h.shown.map((v) => v.id)).toEqual(['s2'])
  })
})
