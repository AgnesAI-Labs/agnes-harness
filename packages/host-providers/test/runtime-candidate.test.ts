import { describe, expect, it, vi } from 'vitest'
import {
  CandidateRuntimeError,
  E_CANDIDATE_REVOKED,
  stageCandidateRuntime,
} from '../src/runtime-candidate.js'

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrow(expect.objectContaining({ code }))
}

describe('CandidateRuntime transaction', () => {
  it('revokes retained facades immediately when commit synchronously returns the built value', async () => {
    let retained!: { read(): string }
    const cleanup = vi.fn()
    const candidate = await stageCandidateRuntime({
      build(transaction) {
        transaction.onAbort('candidate', cleanup)
        retained = transaction.createFacade({ read: () => 'candidate' })
        expect(retained.read()).toBe('candidate')
        return Object.freeze({ generation: 2 })
      },
    })

    const published = candidate.commit()

    expect(published).toEqual({ generation: 2 })
    expect(published).not.toBeInstanceOf(Promise)
    expect(cleanup).not.toHaveBeenCalled()
    expectCode(() => retained.read(), E_CANDIDATE_REVOKED)
  })

  it('revokes retained facades on abort and refuses every second terminal transition', async () => {
    let retained!: { read(): string }
    const aborted = await stageCandidateRuntime({
      build(transaction) {
        retained = transaction.createFacade({ read: () => 'candidate' })
        return { generation: 2 }
      },
    })
    await aborted.abort()
    expectCode(() => retained.read(), E_CANDIDATE_REVOKED)
    expectCode(() => aborted.commit(), 'E_CANDIDATE_FINALIZED')
    await expect(aborted.abort()).rejects.toMatchObject({ code: 'E_CANDIDATE_FINALIZED' })

    const committed = await stageCandidateRuntime({ build: () => ({ generation: 3 }) })
    committed.commit()
    expectCode(() => committed.commit(), 'E_CANDIDATE_FINALIZED')
    await expect(committed.abort()).rejects.toMatchObject({ code: 'E_CANDIDATE_FINALIZED' })
  })

  it('recursively revokes sync and async descendants, including a promise settled after commit', async () => {
    let parent!: {
      child(): { invoke(): string }
      delayed(): Promise<{ invoke(): string }>
    }
    let resolveDelayed!: (value: { invoke(): string }) => void
    const delayed = new Promise<{ invoke(): string }>((resolve) => {
      resolveDelayed = resolve
    })
    const candidate = await stageCandidateRuntime({
      build(transaction) {
        parent = transaction.createFacade({
          child: () => ({ invoke: () => 'sync-child' }),
          delayed: () => delayed,
        })
        return { generation: 2 }
      },
    })
    const child = parent.child()
    const pendingChild = parent.delayed()

    candidate.commit()
    resolveDelayed({ invoke: () => 'async-child' })

    expectCode(() => child.invoke(), E_CANDIDATE_REVOKED)
    await expect(pendingChild).rejects.toMatchObject({ code: E_CANDIDATE_REVOKED })
  })

  it('wraps capabilities carried by synchronous throws and promise rejections', async () => {
    const syncError = { retry: () => 'sync-retry' }
    const asyncError = { retry: () => 'async-retry' }
    let facade!: {
      failSync(): never
      failAsync(): Promise<never>
    }
    const candidate = await stageCandidateRuntime({
      build(transaction) {
        facade = transaction.createFacade({
          failSync(): never {
            throw syncError
          },
          failAsync: () => Promise.reject(asyncError),
        })
        return { generation: 2 }
      },
    })

    let caughtSync!: typeof syncError
    try {
      facade.failSync()
    } catch (error) {
      caughtSync = error as typeof syncError
    }
    const caughtAsync = await facade.failAsync().catch((error: unknown) => error as typeof asyncError)
    expect(caughtSync.retry()).toBe('sync-retry')
    expect(caughtAsync.retry()).toBe('async-retry')

    candidate.commit()
    expectCode(() => caughtSync.retry(), E_CANDIDATE_REVOKED)
    expectCode(() => caughtAsync.retry(), E_CANDIDATE_REVOKED)
  })

  it('wraps capabilities thrown by proxy getters and hostile then accessors', async () => {
    const getterError = { retry: () => 'getter-retry' }
    const thenError = { retry: () => 'then-retry' }
    let facade!: { leak: unknown }
    let wrapHostileThen!: () => unknown
    const candidate = await stageCandidateRuntime({
      build(transaction) {
        facade = transaction.createFacade(
          Object.defineProperty({}, 'leak', {
            get() {
              throw getterError
            },
          }),
        ) as { leak: unknown }
        wrapHostileThen = () =>
          transaction.createFacade(
            Object.defineProperty({}, 'then', {
              get() {
                throw thenError
              },
            }),
          )
        return { generation: 2 }
      },
    })

    let caughtGetter!: typeof getterError
    try {
      void facade.leak
    } catch (error) {
      caughtGetter = error as typeof getterError
    }
    let caughtThen!: typeof thenError
    try {
      wrapHostileThen()
    } catch (error) {
      caughtThen = error as typeof thenError
    }
    expect(caughtGetter.retry()).toBe('getter-retry')
    expect(caughtThen.retry()).toBe('then-retry')

    candidate.commit()
    expectCode(() => caughtGetter.retry(), E_CANDIDATE_REVOKED)
    expectCode(() => caughtThen.retry(), E_CANDIDATE_REVOKED)
  })

  it('keeps the resolver and side-effect ports transaction-local without writing the live port', async () => {
    const live = { writes: [] as string[] }
    const local = { writes: [] as string[] }
    let delayedWrite!: (value: string) => void
    const candidate = await stageCandidateRuntime({
      build(transaction) {
        transaction.provide(
          'audit',
          transaction.createSideEffectPort({
            write(value: string) {
              local.writes.push(value)
            },
          }),
        )
        const audit = transaction.resolve<{ write(value: string): void }>('audit')
        audit.write('staged')
        delayedWrite = audit.write
        return { generation: 2, local }
      },
    })

    expect(local.writes).toEqual(['staged'])
    expect(live.writes).toEqual([])
    candidate.commit()
    expectCode(() => delayedWrite('late'), E_CANDIDATE_REVOKED)
    expect(live.writes).toEqual([])
  })

  it('runs candidate failure cleanup in reverse order and retains cleanup failures after the primary', async () => {
    const order: string[] = []
    const primary = new Error('mount failed')
    const cleanupFailure = new Error('resource cleanup failed')

    const error = await stageCandidateRuntime({
      build(transaction) {
        transaction.onAbort('ordinary-root', () => {
          order.push('ordinary-root')
        })
        transaction.onAbort('resource-generation', () => {
          order.push('resource-generation')
          throw cleanupFailure
        })
        transaction.onAbort('session-overlay', async () => {
          order.push('session-overlay')
        })
        throw primary
      },
    }).catch((caught: unknown) => caught)

    expect(order).toEqual(['session-overlay', 'resource-generation', 'ordinary-root'])
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([primary, cleanupFailure])
  })

  it('auto-aborts a failed initial validator before returning any candidate', async () => {
    const cleanup = vi.fn()
    const failure = new Error('invalid candidate')

    await expect(
      stageCandidateRuntime({
        build(transaction) {
          transaction.onAbort('candidate', cleanup)
          return { generation: 2 }
        },
        validate() {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('leaves a precommit validation failure staged so the caller can abort it in finally', async () => {
    const cleanup = vi.fn()
    const candidate = await stageCandidateRuntime({
      build(transaction) {
        transaction.onAbort('candidate', cleanup)
        return { generation: 2 }
      },
    })

    await expect(
      candidate.precommit(() => {
        throw new Error('session set changed')
      }),
    ).rejects.toThrow('session set changed')
    expect(cleanup).not.toHaveBeenCalled()
    await candidate.abort()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('refuses commit while asynchronous precommit validation is still running', async () => {
    let release!: () => void
    const validation = new Promise<void>((resolve) => {
      release = resolve
    })
    const candidate = await stageCandidateRuntime({ build: () => ({ generation: 2 }) })
    const pending = candidate.precommit(() => validation)

    expectCode(() => candidate.commit(), 'E_CANDIDATE_VALIDATION_PENDING')
    release()
    await pending
    expect(candidate.commit()).toEqual({ generation: 2 })
  })

  it('does not expose a terminal token or transaction owner through the frozen builder', async () => {
    let keys: readonly string[] = []
    let frozen = false
    let retainedBuilder!: Parameters<Parameters<typeof stageCandidateRuntime>[0]['build']>[0]
    const candidate = await stageCandidateRuntime({
      build(transaction) {
        retainedBuilder = transaction
        keys = Object.keys(transaction).sort()
        frozen = Object.isFrozen(transaction)
        return { generation: 2 }
      },
    })

    expect(keys).toEqual(['createFacade', 'createSideEffectPort', 'onAbort', 'provide', 'resolve'])
    expect(frozen).toBe(true)
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('commit')
    candidate.commit()
    expectCode(() => retainedBuilder.resolve('late'), E_CANDIDATE_REVOKED)
  })

  it('uses the fixed candidate error type for revoked access', async () => {
    let facade!: { value: string }
    const candidate = await stageCandidateRuntime({
      build(transaction) {
        facade = transaction.createFacade({ value: 'candidate' })
        return { generation: 2 }
      },
    })
    candidate.commit()

    let caught: unknown
    try {
      void facade.value
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CandidateRuntimeError)
    expect(caught).toMatchObject({ code: E_CANDIDATE_REVOKED })
  })
})
