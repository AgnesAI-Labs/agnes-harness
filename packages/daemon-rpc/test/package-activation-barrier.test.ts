import { createExtensionActivationBarrier } from '@agnes/host'
import { expect, it } from 'vitest'
import { openTestHost, slowProvider } from './host.js'

const deferred = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('gives daemon prompt admission a retryable activation-in-progress refusal', async () => {
  const barrier = createExtensionActivationBarrier()
  const activeTurn = barrier.admit('turn'),
    release = deferred()
  const running = activeTurn.run(() => release.promise)
  const activation = barrier.quiesce('package-operation-1', async () => undefined)

  expect(() => barrier.admit('turn')).toThrow(
    expect.objectContaining({
      code: 'OVERLOADED',
      reason: 'activation-in-progress',
      retryable: true,
      operationId: 'package-operation-1',
    }),
  )
  release.resolve()
  await Promise.all([running, activation])
  const nextTurn = barrier.admit('turn')
  nextTurn.finish()
})

it('refuses a local endpoint barrier that differs from its Host barrier', async () => {
  const opened = await openTestHost({ provider: slowProvider(10_000) })
  try {
    expect(() => opened.endpoint({ activationBarrier: createExtensionActivationBarrier() })).toThrow(
      /must be the Host activation barrier/,
    )
  } finally {
    await opened.close()
  }
})

it('keeps supervisor-queued prompts on the new side of the package switch', async () => {
  const barrier = createExtensionActivationBarrier()
  const running = barrier.admit('turn'),
    queued = barrier.enqueue('turn'),
    release = deferred()
  const turn = running.run(() => release.promise)
  const generations: number[] = []
  let generation = 1
  const activation = barrier.quiesce('package-operation-2', async () => {
    generation = 2
  })
  const queuedTurn = queued.start().then((invocation) => {
    generations.push(generation)
    invocation.finish()
  })

  release.resolve()
  await Promise.all([turn, activation, queuedTurn])
  expect(generations).toEqual([2])
})

it('wires the real local prompt path to wait for an active turn and rejects new prompts as retryable', async () => {
  const opened = await openTestHost({ provider: slowProvider(10_000) })
  const endpoint = opened.endpoint({ pollMs: 5 })
  try {
    await endpoint.handle({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
    })
    const created = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 'new',
      method: 'session/new',
      params: { cwd: opened.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const sessionId = created.result.sessionId
    const prompt = endpoint.handle({
      jsonrpc: '2.0',
      id: 'first',
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hold' }] },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    let switched = false
    const activation = opened.host.activationBarrier.quiesce('real-local-operation', async () => {
      switched = true
    })
    await Promise.resolve()
    expect(switched).toBe(false)
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 'late',
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'late' }] },
      }),
    ).resolves.toMatchObject({
      error: {
        code: -32001,
        data: {
          code: 'OVERLOADED',
          reason: 'activation-in-progress',
          operationId: 'real-local-operation',
        },
      },
    })
    expect(switched).toBe(false)
    await endpoint.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    await Promise.all([prompt, activation])
    expect(switched).toBe(true)
  } finally {
    await endpoint.close()
    await opened.close()
  }
})
