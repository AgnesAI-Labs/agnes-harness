import { describe, expect, it, vi } from 'vitest'
import { PublicationGate } from '../src/publication-gate.js'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('PublicationGate', () => {
  it('drains existing readers and queues new readers for the whole writer closure', async () => {
    const gate = new PublicationGate()
    const first = await gate.enterDispatch()
    const second = await gate.enterDispatch()
    const writerBody = deferred()
    const events: string[] = []

    const writer = gate.withClosed(async () => {
      events.push('writer:start')
      await writerBody.promise
      events.push('writer:end')
    })
    const queuedReader = gate.enterDispatch().then((ticket) => {
      events.push('reader:admitted')
      return ticket
    })

    await flushMicrotasks()
    expect(events).toEqual([])

    first.release()
    await flushMicrotasks()
    expect(events).toEqual([])

    second.release()
    await flushMicrotasks()
    expect(events).toEqual(['writer:start'])

    writerBody.resolve()
    await writer
    const admitted = await queuedReader
    expect(events).toEqual(['writer:start', 'writer:end', 'reader:admitted'])
    admitted.release()
  })

  it('allows a synchronous handoff to release its read ticket before the handed operation settles', async () => {
    const gate = new PublicationGate()
    const ticket = await gate.enterDispatch()
    const operationBody = deferred()
    const handedOperation = operationBody.promise
    let operationSettled = false
    void handedOperation.then(() => {
      operationSettled = true
    })

    const writerBody = vi.fn()
    const writer = gate.withClosed(writerBody)
    ticket.release()

    await writer
    expect(writerBody).toHaveBeenCalledOnce()
    expect(operationSettled).toBe(false)

    operationBody.resolve()
    await handedOperation
  })

  it('reopens admission after a writer callback fails by default', async () => {
    const gate = new PublicationGate()
    const failure = new Error('candidate validation failed')

    await expect(
      gate.withClosed(() => {
        throw failure
      }),
    ).rejects.toBe(failure)

    const ticket = await gate.enterDispatch()
    ticket.release()
  })

  it('keeps readers closed after a fatal writer failure', async () => {
    const gate = new PublicationGate()
    const failure = new Error('publication invariant failed')

    await expect(
      gate.withClosed(
        () => {
          throw failure
        },
        { onError: 'keep-closed' },
      ),
    ).rejects.toBe(failure)

    let admitted = false
    void gate.enterDispatch().then(() => {
      admitted = true
    })
    await flushMicrotasks()
    expect(admitted).toBe(false)
  })

  it('rejects queued or new writers after a fatal writer failure', async () => {
    const gate = new PublicationGate()
    const failure = new Error('publication invariant failed')
    const read = await gate.enterDispatch()
    const fatalWriter = gate.withClosed(
      () => {
        throw failure
      },
      { onError: 'keep-closed' },
    )
    const queuedCallback = vi.fn()
    const queuedWriter = gate.withClosed(queuedCallback)

    read.release()
    await expect(fatalWriter).rejects.toBe(failure)
    await expect(queuedWriter).rejects.toBe(failure)
    expect(queuedCallback).not.toHaveBeenCalled()

    const laterCallback = vi.fn()
    await expect(gate.withClosed(laterCallback)).rejects.toBe(failure)
    expect(laterCallback).not.toHaveBeenCalled()
  })

  it('makes read-ticket release idempotent', async () => {
    const gate = new PublicationGate()
    const ticket = await gate.enterDispatch()
    const writerBody = vi.fn()
    const writer = gate.withClosed(writerBody)

    ticket.release()
    ticket.release()
    await writer

    expect(writerBody).toHaveBeenCalledOnce()
    const next = await gate.enterDispatch()
    next.release()
  })

  it('serializes writers without admitting readers between queued writers', async () => {
    const gate = new PublicationGate()
    const firstBody = deferred()
    const events: string[] = []

    const first = gate.withClosed(async () => {
      events.push('writer:one:start')
      await firstBody.promise
      events.push('writer:one:end')
    })
    const queuedReader = gate.enterDispatch().then((ticket) => {
      events.push('reader')
      return ticket
    })
    const second = gate.withClosed(() => {
      events.push('writer:two')
    })

    await flushMicrotasks()
    expect(events).toEqual(['writer:one:start'])
    firstBody.resolve()
    await Promise.all([first, second])
    const ticket = await queuedReader

    expect(events).toEqual(['writer:one:start', 'writer:one:end', 'writer:two', 'reader'])
    ticket.release()
  })

  it('does not implicitly upgrade a held read ticket into a writer', async () => {
    const gate = new PublicationGate()
    const read = await gate.enterDispatch()
    let writerRan = false

    const writer = gate.withClosed(() => {
      writerRan = true
    })
    await flushMicrotasks()

    // Awaiting `writer` while retaining `read` would self-lock. Dispatch must complete its
    // synchronous handoff and explicitly release the read ticket before awaiting publication.
    expect(writerRan).toBe(false)
    read.release()
    await writer
    expect(writerRan).toBe(true)
  })
})
