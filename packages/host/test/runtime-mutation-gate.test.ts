import { describe, expect, it } from 'vitest'
import { RuntimeMutationGate } from '../src/runtime-mutation-gate.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('RuntimeMutationGate', () => {
  it('waits new runtime reads until a mutation completes, while admitted reads drain first', async () => {
    const gate = new RuntimeMutationGate()
    const admitted = await gate.enterRead()
    const mutationStarted = deferred<void>()
    const releaseMutation = deferred<void>()
    const mutation = gate.mutate(async () => {
      mutationStarted.resolve()
      await releaseMutation.promise
    })
    let readEntered = false
    const read = gate.enterRead().then((lease) => {
      readEntered = true
      return lease
    })
    await Promise.resolve()
    expect(readEntered).toBe(false)

    admitted.release()
    await mutationStarted.promise
    expect(readEntered).toBe(false)
    releaseMutation.resolve()
    await mutation
    const lease = await read
    expect(readEntered).toBe(true)
    lease.release()
  })

  it('allows a host callback to re-enter the same mutation without waiting on itself', async () => {
    const gate = new RuntimeMutationGate()
    let callbackTicket = false
    const result = await gate.mutate(async (ticket) => {
      callbackTicket = gate.currentMutationTicket() === ticket
      return gate.withMutationTicket(ticket, async () => {
        const lease = await gate.enterRead()
        lease.release()
        return 're-entered'
      })
    })

    expect(result).toBe('re-entered')
    expect(callbackTicket).toBe(true)
    expect(gate.currentMutationTicket()).toBeUndefined()
  })

  it('releases read leases when the callback throws', async () => {
    const gate = new RuntimeMutationGate()
    await expect(
      gate.withRead(async () => {
        throw new Error('read failed')
      }),
    ).rejects.toThrow('read failed')

    await expect(gate.mutate(() => 'after-failure')).resolves.toBe('after-failure')
  })

  it('cancels a queued read without leaking a waiter', async () => {
    const gate = new RuntimeMutationGate()
    const hold = deferred<void>()
    const mutation = gate.mutate(() => hold.promise)
    const controller = new AbortController()
    const read = gate.enterRead(controller.signal)
    controller.abort()

    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    hold.resolve()
    await mutation
    await expect(gate.withRead(() => 'usable')).resolves.toBe('usable')
  })

  it('reopens the gate after a cancelled or failed mutation', async () => {
    const gate = new RuntimeMutationGate()
    const controller = new AbortController()
    controller.abort()
    await expect(gate.mutate(() => 'never', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(gate.mutate(() => Promise.reject(new Error('mutation failed')))).rejects.toThrow(
      'mutation failed',
    )
    await expect(gate.withRead(() => 'usable')).resolves.toBe('usable')
  })

  it('does not let a later mutation overtake a cancelled queued mutation', async () => {
    const gate = new RuntimeMutationGate()
    const firstStarted = deferred<void>()
    const releaseFirst = deferred<void>()
    const first = gate.mutate(async () => {
      firstStarted.resolve()
      await releaseFirst.promise
    })
    await firstStarted.promise

    const controller = new AbortController()
    const cancelled = gate.mutate(() => 'cancelled', controller.signal)
    const laterStarted = deferred<void>()
    let laterHasStarted = false
    const later = gate.mutate(() => {
      laterHasStarted = true
      laterStarted.resolve()
      return 'later'
    })
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(laterHasStarted).toBe(false)
    releaseFirst.resolve()
    await first
    await laterStarted.promise
    await expect(later).resolves.toBe('later')
  })
})
