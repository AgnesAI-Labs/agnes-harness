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
    const provider: Provider = {
      models: vi.fn(() => []),
      count: vi.fn(async () => ({ source: 'unsupported' as const })),
      async *infer() {
        yield { type: 'text_delta', delta: id }
      },
    }
    const contractForModel: NonNullable<KernelOptions['contractForModel']> = () => ({
      contract_id: id,
      parser_version: '1',
    })
    return { provider, contractForModel }
  }
  const old = make('old'),
    fresh = make('fresh')
  const runtime = modelRuntime(old)
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
  resume()
  expect(await inflight).toEqual([{ type: 'text_delta', delta: 'old' }])
  expect(old.provider.count).toHaveBeenCalledOnce()
  expect(fresh.provider.count).not.toHaveBeenCalled()
  expect(old.provider.models).toHaveBeenCalledOnce()
  expect(fresh.provider.models).toHaveBeenCalledOnce()
})
