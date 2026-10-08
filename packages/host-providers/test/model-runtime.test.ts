import type { KernelOptions, Provider } from '@agnes/core'
import type { RequestBody } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { modelRuntime } from '../src/assemble/model-runtime.js'

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const event of stream) result.push(event)
  return result
}

it('pins preparation, catalogue, counting and inference together while a new image is published', async () => {
  const make = (id: string) => {
    let disposed = false
    const provider: Provider = {
      models: vi.fn(() => []),
      count: vi.fn(async () => ({ source: 'unsupported' as const })),
      async *infer() {
        if (disposed) throw new Error('provider disposed during request')
        yield { type: 'text_delta', delta: id }
      },
    }
    const contractForModel: NonNullable<KernelOptions['contractForModel']> = () => ({
      contract_id: id,
      parser_version: '1',
    })
    return {
      provider,
      contractForModel,
      dispose: async () => {
        disposed = true
      },
      disposed: () => disposed,
    }
  }
  const old = make('old'),
    fresh = make('fresh')
  const runtime = modelRuntime(old, () => {})
  const request = {} as RequestBody
  const options = { signal: new AbortController().signal, toolNames: [] }
  let resume!: () => void
  const barrier = new Promise<void>((resolve) => {
    resume = resolve
  })
  const inflight = runtime.run(async () => {
    runtime.provider.models()
    expect(runtime.contractForModel({ route: 'r', model: 'm' }).contract_id).toBe('old')
    await barrier
    await runtime.provider.count?.(request, options)
    expect(runtime.contractForModel({ route: 'r', model: 'm' }).contract_id).toBe('old')
    return collect(runtime.provider.infer(request, options))
  })
  runtime.publish(fresh)
  await runtime.run(async () => {
    runtime.provider.models()
    expect(runtime.contractForModel({ route: 'r', model: 'm' }).contract_id).toBe('fresh')
    expect(await collect(runtime.provider.infer(request, options))).toEqual([
      { type: 'text_delta', delta: 'fresh' },
    ])
  })
  expect(old.disposed()).toBe(false)
  expect(fresh.disposed()).toBe(false)
  const closing = runtime.dispose()
  resume()
  expect(await inflight).toEqual([{ type: 'text_delta', delta: 'old' }])
  expect(old.disposed()).toBe(true)
  await closing
  expect(fresh.disposed()).toBe(true)
  expect(old.provider.count).toHaveBeenCalledOnce()
  expect(fresh.provider.count).not.toHaveBeenCalled()
  expect(old.provider.models).toHaveBeenCalledOnce()
  expect(fresh.provider.models).toHaveBeenCalledOnce()
})

it('drains direct inference and counting, including iterator cancellation and cleanup errors', async () => {
  let finishCount!: () => void
  const counting = new Promise<void>((resolve) => {
    finishCount = resolve
  })
  let disposed = false
  const old = {
    provider: {
      models: () => [],
      count: async () => {
        await counting
        return { source: 'unsupported' as const }
      },
      async *infer() {
        yield { type: 'text_delta' as const, delta: 'old' }
      },
    },
    contractForModel: () => ({ contract_id: 'old', parser_version: '1' }),
    dispose: async () => {
      disposed = true
      throw new Error('cleanup failed')
    },
  }
  const errors: unknown[] = []
  const runtime = modelRuntime(old, (error) => {
    errors.push(error)
  })
  const request = {} as RequestBody
  const options = { signal: new AbortController().signal, toolNames: [] }
  const stream = runtime.provider.infer(request, options)[Symbol.asyncIterator]()
  await stream.next()
  const count = runtime.provider.count!(request, options)
  runtime.publish({ ...old, dispose: async () => {} })
  await stream.return?.()
  expect(disposed).toBe(false)
  finishCount()
  await count
  expect(disposed).toBe(true)
  await expect(runtime.dispose()).rejects.toThrow('model provider cleanup failed')
  expect(disposed).toBe(true)
  expect(errors).toHaveLength(1)
})
