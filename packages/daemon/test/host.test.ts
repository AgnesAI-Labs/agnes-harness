import { existsSync } from 'node:fs'
import { fakeRequest } from '@agnes/ai/testkit'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestHost, say, slowProvider } from './host.js'

describe('openTestHost', () => {
  it('assembles a host that opens a session, and close removes the data directory', async () => {
    const t = await openTestHost({ script: [say('hi')] })
    const session = await t.host.createSession({ cwd: t.dataDir })
    expect(session.key).toContain('local-dev')
    expect(existsSync(t.dataDir)).toBe(true)
    await t.close()
    expect(existsSync(t.dataDir)).toBe(false)
  })
})

describe('slowProvider', () => {
  afterEach(() => vi.useRealTimers())
  const drain = async (p: ReturnType<typeof slowProvider>, signal: AbortSignal): Promise<string[]> => {
    const seen: string[] = []
    for await (const e of p.infer(fakeRequest(), { signal, toolNames: [] }) as AsyncIterable<InferenceEvent>)
      seen.push(e.type)
    return seen
  }

  it('pauses between events', async () => {
    vi.useFakeTimers()
    let seen: string[] | undefined
    const pending = drain(slowProvider(40), new AbortController().signal).then((value) => {
      seen = value
    })
    await vi.advanceTimersByTimeAsync(39)
    expect(seen).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    await vi.runAllTimersAsync()
    await pending
    expect(seen).toEqual(['sent', 'text_delta', 'done'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an abort arriving during the pause cuts it short instead of being outlived by it', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    let seen: string[] | undefined
    setTimeout(() => ac.abort(), 20)
    const pending = drain(slowProvider(30_000), ac.signal).then((value) => {
      seen = value
    })
    await vi.advanceTimersByTimeAsync(19)
    expect(ac.signal.aborted).toBe(false)
    expect(seen).toBeUndefined()
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual(['sent', 'error'])
    expect(vi.getTimerCount()).toBe(0)
    await pending
  })

  it('an abort that already fired skips the pause instead of being outlived by it', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    ac.abort()
    let seen: string[] | undefined
    const pending = drain(slowProvider(30_000), ac.signal).then((value) => {
      seen = value
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual(['sent', 'error'])
    expect(vi.getTimerCount()).toBe(0)
    await pending
  })
})
