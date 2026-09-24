import { describe, expect, it, vi } from 'vitest'
import type { McpConnection } from '../../../src/mcp/register.js'
import { type ConnectionSupervisorDeps, RECONNECT_DEFAULTS, superviseConnection } from '../src/supervisor.js'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A fake `McpConnection` whose `onClose`/`onToolsChanged` listeners the test fires directly. */
function fakeConnection(
  id: string,
): McpConnection & { fireClose(): void; fireToolsChanged(): void; closed: boolean } {
  const closeListeners = new Set<() => void>()
  const toolsChangedListeners = new Set<() => void>()
  const conn = {
    id,
    closed: false,
    async listTools() {
      return []
    },
    async callTool() {
      return { content: [] }
    },
    async close() {
      conn.closed = true
    },
    onClose(listener: () => void) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    onToolsChanged(listener: () => void) {
      toolsChangedListeners.add(listener)
      return () => toolsChangedListeners.delete(listener)
    },
    fireClose() {
      for (const listener of [...closeListeners]) listener()
    },
    fireToolsChanged() {
      for (const listener of [...toolsChangedListeners]) listener()
    },
  }
  return conn
}

/** An immediately-resolving sleep, so reconnect-loop tests don't wait on real timers; a test that
 * needs to observe an in-flight backoff wait uses `deferredSleep()` instead. */
function instantSleep(): ConnectionSupervisorDeps['sleep'] {
  return async (_ms, signal) => {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  }
}

describe('superviseConnection', () => {
  it('connects once, syncs, and ready resolves with no error', async () => {
    const conn = fakeConnection('a')
    const sync = vi.fn(async () => vi.fn())
    const handle = superviseConnection({ connect: async () => conn, sync, sleep: instantSleep() })
    const outcome = await handle.ready
    expect(outcome).toEqual({})
    expect(sync).toHaveBeenCalledWith(conn, expect.anything())
    await handle.dispose()
  })

  it('ready reports the error when the first attempt fails, and keeps retrying', async () => {
    let attempts = 0
    const conn = fakeConnection('a')
    const connect = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return conn
    })
    const sync = vi.fn(async () => vi.fn())
    const handle = superviseConnection({ connect, sync, sleep: instantSleep() })
    const outcome = await handle.ready
    expect(outcome.error).toBeInstanceOf(Error)
    expect((outcome.error as Error).message).toBe('boom')
    // The supervisor keeps retrying after a failed first attempt regardless of what `ready` reports.
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith(conn, expect.anything()))
    await handle.dispose()
  })

  it('reconnects after the live connection reports an unexpected close, disposing the old registration', async () => {
    const first = fakeConnection('gen1')
    const second = fakeConnection('gen2')
    const connections = [first, second]
    const disposeFirst = vi.fn()
    const disposeSecond = vi.fn()
    const disposers = [disposeFirst, disposeSecond]
    let syncCalls = 0
    const connect = vi.fn(async () => connections.shift() as McpConnection)
    const sync = vi.fn(async () => {
      const dispose = disposers[syncCalls]
      syncCalls += 1
      return dispose as () => void
    })
    const handle = superviseConnection({ connect, sync, sleep: instantSleep() })
    await handle.ready
    expect(disposeFirst).not.toHaveBeenCalled()

    first.fireClose()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    // The old generation's registration is retired before the new one registers the same names
    // (Host's tool registry refuses a duplicate name -- see the registry test below).
    expect(disposeFirst).toHaveBeenCalledOnce()
    expect(disposeFirst.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[1] ?? 0)
    expect(disposeSecond).not.toHaveBeenCalled()
    await handle.dispose()
    expect(disposeSecond).toHaveBeenCalledOnce()
  })

  it('re-syncs on tools/list_changed without reconnecting', async () => {
    const conn = fakeConnection('a')
    const disposeFirst = vi.fn()
    const disposeSecond = vi.fn()
    let calls = 0
    const connect = vi.fn(async () => conn)
    const sync = vi.fn(async () => {
      calls += 1
      return calls === 1 ? disposeFirst : disposeSecond
    })
    const handle = superviseConnection({ connect, sync, sleep: instantSleep() })
    await handle.ready
    expect(connect).toHaveBeenCalledOnce()

    conn.fireToolsChanged()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    // No reconnect happened -- `connect` is still called exactly once.
    expect(connect).toHaveBeenCalledOnce()
    expect(disposeFirst).toHaveBeenCalledOnce()
    expect(disposeFirst.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[1] ?? 0)
    await handle.dispose()
    expect(disposeSecond).toHaveBeenCalledOnce()
  })

  it('re-syncs and reconnects against a registry that refuses a name still registered', async () => {
    // Host's tool registry throws E_REGISTRY_DUPLICATE for a name already held. Every re-sync
    // registers the same names again, so it only works if the previous registration is gone first.
    const registered = new Set<string>()
    const sync = vi.fn(async () => {
      if (registered.has('mcp_a_ping')) throw new Error('E_REGISTRY_DUPLICATE: mcp_a_ping')
      registered.add('mcp_a_ping')
      return () => {
        registered.delete('mcp_a_ping')
      }
    })
    const first = fakeConnection('gen1')
    const second = fakeConnection('gen2')
    const connections = [first, second]
    const handle = superviseConnection({
      connect: async () => connections.shift() as McpConnection,
      sync,
      sleep: instantSleep(),
    })
    expect(await handle.ready).toEqual({})

    first.fireToolsChanged()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    first.fireClose()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(3))
    await expect(sync.mock.results[1]?.value).resolves.toBeTypeOf('function')
    await expect(sync.mock.results[2]?.value).resolves.toBeTypeOf('function')
    expect(registered).toEqual(new Set(['mcp_a_ping']))
    await handle.dispose()
    expect(registered).toEqual(new Set())
  })

  it('gives up after maxAttempts consecutive failed reconnects and unregisters', async () => {
    const conn = fakeConnection('a')
    const dispose = vi.fn()
    let calls = 0
    const connect = vi.fn(async () => {
      calls += 1
      if (calls === 1) return conn
      throw new Error(`fail ${calls}`)
    })
    const sync = vi.fn(async () => dispose)
    const policy = { initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 }
    const handle = superviseConnection({ connect, sync, sleep: instantSleep() }, policy)
    await handle.ready
    conn.fireClose()
    // 1 initial connect + up to maxAttempts reconnect attempts.
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1 + policy.maxAttempts))
    // Giving up unregisters the last-known-good tools.
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    const callsAtGiveUp = connect.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    // No further attempts after giving up.
    expect(connect).toHaveBeenCalledTimes(callsAtGiveUp)
    await handle.dispose()
  })

  it('resets the failure budget once a reconnected generation survives past the stability window', async () => {
    let calls = 0
    const connections: ReturnType<typeof fakeConnection>[] = []
    const connect = vi.fn(async () => {
      calls += 1
      const conn = fakeConnection(`gen${calls}`)
      connections.push(conn)
      return conn
    })
    const sync = vi.fn(async () => vi.fn())
    // maxDelayMs is tiny so the test can cross the stability window without a long real wait.
    const policy = { initialDelayMs: 1, maxDelayMs: 5, maxAttempts: 2 }
    const handle = superviseConnection({ connect, sync, sleep: instantSleep() }, policy)
    await handle.ready
    connections[0]?.fireClose()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    // Let the second generation cross the stability window before dropping it too.
    await new Promise((resolve) => setTimeout(resolve, 10))
    connections[1]?.fireClose()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3))
    // A third drop, then a fourth: if the budget had NOT reset, attempt 2 after the first outage
    // would already have exhausted maxAttempts=2 and the supervisor would stop retrying here.
    connections[2]?.fireClose()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(4))
    await handle.dispose()
  })

  it('dispose closes the live connection, stops the reconnect loop, and unregisters tools', async () => {
    const conn = fakeConnection('a')
    const dispose = vi.fn()
    const connect = vi.fn(async () => conn)
    const sync = vi.fn(async () => dispose)
    const handle = superviseConnection({ connect, sync, sleep: instantSleep() })
    await handle.ready
    await handle.dispose()
    expect(conn.closed).toBe(true)
    expect(dispose).toHaveBeenCalledOnce()

    conn.fireClose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Disposal already ran; a stray close notification after the fact must not restart anything.
    expect(connect).toHaveBeenCalledOnce()
  })

  it('does not finish disposal while the transport is still open after the close deadline', async () => {
    const conn = fakeConnection('slow-close')
    const closeGate = deferred<void>()
    conn.close = async () => {
      await closeGate.promise
      conn.closed = true
    }
    const handle = superviseConnection({
      connect: async () => conn,
      sync: async () => () => {},
      sleep: instantSleep(),
    })
    await handle.ready
    vi.useFakeTimers()
    try {
      let disposed = false
      const disposing = handle.dispose().then(() => {
        disposed = true
      })
      await vi.advanceTimersByTimeAsync(5_100)
      expect(disposed).toBe(false)
      expect(conn.closed).toBe(false)
      closeGate.resolve()
      await disposing
      expect(conn.closed).toBe(true)
    } finally {
      closeGate.resolve()
      vi.useRealTimers()
    }
  })

  it('waits for a failed-sync generation whose close exceeded the deadline', async () => {
    const conn = fakeConnection('failed-sync')
    const closeGate = deferred<void>()
    conn.close = async () => {
      await closeGate.promise
      conn.closed = true
    }
    const connect = vi.fn(async () => conn)
    vi.useFakeTimers()
    try {
      const handle = superviseConnection({
        connect,
        sync: async () => {
          throw new Error('sync failed')
        },
        sleep: instantSleep(),
      })
      await vi.advanceTimersByTimeAsync(5_100)
      await handle.ready
      let disposed = false
      const disposing = handle.dispose().then(() => {
        disposed = true
      })
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(connect).toHaveBeenCalledOnce()
      closeGate.resolve()
      await disposing
      expect(conn.closed).toBe(true)
    } finally {
      closeGate.resolve()
      vi.useRealTimers()
    }
  })

  it('dispose waits out an in-flight backoff wait instead of leaving a dangling reconnect', async () => {
    const conn = fakeConnection('a')
    const gate = deferred<void>()
    let calls = 0
    const connect = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('first attempt fails')
      return conn
    })
    const sync = vi.fn(async () => vi.fn())
    const sleep: ConnectionSupervisorDeps['sleep'] = async (_ms, signal) => {
      if (calls < 1) return
      // Block the reconnect wait until the test releases it, simulating dispose() racing a pending
      // backoff timer.
      await Promise.race([
        gate.promise,
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        }),
      ])
    }
    const handle = superviseConnection({ connect, sync, sleep })
    await handle.ready
    const disposing = handle.dispose()
    gate.resolve()
    await disposing
    // The aborted backoff wait must not go on to call connect() a second time.
    expect(connect).toHaveBeenCalledOnce()
  })

  it('defaults match the documented dsh-equivalent policy', () => {
    expect(RECONNECT_DEFAULTS).toEqual({ initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 })
  })

  describe('onStatus', () => {
    it('reports connecting immediately, then ready with the reported catalog info', async () => {
      const conn = fakeConnection('a')
      const events: unknown[] = []
      const sync = vi.fn(async (_conn: McpConnection, report?: (info: unknown) => void) => {
        report?.({ toolCount: 3, catalogRevision: 'rev1' })
        return vi.fn()
      })
      const handle = superviseConnection({
        connect: async () => conn,
        sync,
        sleep: instantSleep(),
        onStatus: (event) => events.push(event),
      })
      expect(events).toEqual([{ state: 'connecting' }])
      await handle.ready
      expect(events).toEqual([
        { state: 'connecting' },
        { state: 'ready', toolCount: 3, catalogRevision: 'rev1' },
      ])
      await handle.dispose()
    })

    it('reports unavailable (not final) immediately on a dropped connection, then ready again with updated numbers', async () => {
      const first = fakeConnection('gen1')
      const second = fakeConnection('gen2')
      const connections = [first, second]
      const events: unknown[] = []
      let calls = 0
      const sync = vi.fn(async (_conn: McpConnection, report?: (info: unknown) => void) => {
        calls += 1
        report?.({ toolCount: calls, catalogRevision: `rev${calls}` })
        return vi.fn()
      })
      const handle = superviseConnection({
        connect: async () => connections.shift() as McpConnection,
        sync,
        sleep: instantSleep(),
        onStatus: (event) => events.push(event),
      })
      await handle.ready
      first.fireClose()
      await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
      expect(events).toEqual([
        { state: 'connecting' },
        { state: 'ready', toolCount: 1, catalogRevision: 'rev1' },
        { state: 'unavailable', error: new Error('MCP transport closed unexpectedly'), reason: 'lost' },
        { state: 'ready', toolCount: 2, catalogRevision: 'rev2' },
      ])
      await handle.dispose()
    })

    it('reports unavailable once the reconnect budget is exhausted, with the last attempt error', async () => {
      const conn = fakeConnection('a')
      const events: unknown[] = []
      let calls = 0
      const connect = vi.fn(async () => {
        calls += 1
        if (calls === 1) return conn
        throw new Error(`fail ${calls}`)
      })
      const sync = vi.fn(async () => vi.fn())
      const policy = { initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 }
      const handle = superviseConnection(
        { connect, sync, sleep: instantSleep(), onStatus: (event) => events.push(event) },
        policy,
      )
      await handle.ready
      conn.fireClose()
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({ state: 'unavailable', error: new Error('fail 3') }),
      )
      await handle.dispose()
    })

    it('never reports a sync that calls back after dispose already gave up ownership', async () => {
      const conn = fakeConnection('a')
      const events: unknown[] = []
      const gate = deferred<void>()
      const sync = vi.fn(async (_conn: McpConnection, report?: (info: unknown) => void) => {
        await gate.promise
        // Called after dispose() below already ran; the generation this belongs to is no longer
        // current, so it must not be allowed to report 'ready' out from under the disposed row.
        report?.({ toolCount: 1, catalogRevision: 'rev1' })
        return vi.fn()
      })
      const handle = superviseConnection({
        connect: async () => conn,
        sync,
        sleep: instantSleep(),
        onStatus: (event) => events.push(event),
      })
      await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce())
      const disposing = handle.dispose()
      gate.resolve()
      await disposing
      expect(events.some((event) => (event as { state: string }).state === 'ready')).toBe(false)
    })
  })
})
