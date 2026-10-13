import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoadStalled } from '../src/errors.js'
import { clientWithScriptedServer } from './helpers/scripted-server.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('session.load idle timeout', () => {
  it('keeps waiting while progress arrives and fails after 30 s of silence', async () => {
    vi.useFakeTimers()
    const { client, server } = await clientWithScriptedServer()
    const loading: number[] = []
    const pending = client.session.load('s1', { onLoading: (p) => loading.push(p.done) })
    for (let i = 1; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(20_000)
      server.notify('_agnes/v1/session.loading', { sessionId: 's1', phase: 'fold', done: i, total: 5 })
    }
    server.reply('session/load', {})
    await expect(pending).resolves.toBeDefined()
    expect(loading).toEqual([1, 2, 3, 4, 5])

    const stalled = client.session.load('s2')
    const assertion = expect(stalled).rejects.toBeInstanceOf(LoadStalled)
    await vi.advanceTimersByTimeAsync(30_001)
    await assertion
    await client.close()
  })

  it('counts replayed history as progress', async () => {
    vi.useFakeTimers()
    const { client, server } = await clientWithScriptedServer()
    const pending = client.session.load('s1')
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(20_000)
      server.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${i}` } },
      })
    }
    await vi.advanceTimersByTimeAsync(20_000)
    server.reply('session/load', {})
    await expect(pending).resolves.toBeDefined()
    await client.close()
  })

  it('gives up at the hard limit even while progress keeps arriving', async () => {
    vi.useFakeTimers()
    const { client, server } = await clientWithScriptedServer()
    const pending = client.session.load('s1', { idleTimeoutMs: 1_000, hardTimeoutMs: 5_000 })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'LOAD_STALLED',
      sessionId: 's1',
      ms: 5_000,
    })
    for (let i = 1; i <= 6; i++) {
      await vi.advanceTimersByTimeAsync(900)
      server.notify('_agnes/v1/session.loading', { sessionId: 's1', phase: 'open', done: 0, total: 0 })
    }
    await assertion
    await client.close()
  })

  it('ignores progress for another session', async () => {
    vi.useFakeTimers()
    const { client, server } = await clientWithScriptedServer()
    const pending = client.session.load('s1', { idleTimeoutMs: 1_000 })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'LOAD_STALLED', ms: 1_000 })
    await vi.advanceTimersByTimeAsync(600)
    server.notify('_agnes/v1/session.loading', { sessionId: 's2', phase: 'fold', done: 1, total: 2 })
    await vi.advanceTimersByTimeAsync(600)
    await assertion
    await client.close()
  })

  it('applies the same idle rule when a reclaimed session is reopened', async () => {
    vi.useFakeTimers()
    const { client, server } = await clientWithScriptedServer()
    let settled = false
    const restoring = client.restoreSession('s1', '/work').finally(() => {
      settled = true
    })
    const assertion = expect(restoring).rejects.toBeInstanceOf(LoadStalled)
    // A restore reads for someone else (export does); it must not leave a session handle behind.
    expect(client.sessions.has('s1')).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    server.notify('_agnes/v1/session.loading', { sessionId: 's1', phase: 'open', done: 0, total: 0 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10_001)
    await assertion
    expect(client.sessions.has('s1')).toBe(false)
    await client.close()
  })
})

describe('session.storedOpening', () => {
  it('asks for the stored opening of a session', async () => {
    const { client, server } = await clientWithScriptedServer()
    const pending = client.session.storedOpening('s1', { maxNodes: 50 })
    await vi.waitFor(() => expect(server.received('_agnes/v1/session.storedOpening')).toHaveLength(1))
    expect(server.received('_agnes/v1/session.storedOpening')[0]).toEqual({ sessionId: 's1', maxNodes: 50 })
    server.reply('_agnes/v1/session.storedOpening', {
      timeline: {
        sessionId: 's1',
        generation: 1,
        upto: 0,
        opState: null,
        pendingInputs: [],
        nodes: [],
        turns: [],
      },
      hasEarlier: false,
      verified: false,
      lastSeq: 0,
    })
    await expect(pending).resolves.toMatchObject({ verified: false, lastSeq: 0 })
    await client.close()
  })
})
