import { createServer } from 'node:http'
import type { InferenceEvent, RouteTable } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createProvider, NullContractStore, PiAdapter } from '../src/index.js'
import { resolveSlot } from '../src/route.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'
import { assertLoopbackOnly, installLoopbackOnly, restoreLoopbackOnly } from './loopback-only.js'

it('sends selected models through two real Pi adapters to their declared loopback endpoints', async () => {
  installLoopbackOnly()
  const hits: Array<{ path: string; model: string }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string }
    hits.push({ path: req.url ?? '', model: body.model })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = {
      id: 'test',
      object: 'chat.completion.chunk',
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.write(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } })}\n\n`,
    )
    res.end('data: [DONE]\n\n')
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing loopback port')
    const adapters = ['a', 'b'].map((route, index) => {
      const baseUrl = `http://127.0.0.1:${address.port}/${route}`
      return new PiAdapter({
        manualRoutes: [
          {
            route,
            api: 'openai-completions',
            baseUrl,
            credentialRef: `secret://test/${route}`,
            models: [
              fakeModel({
                route,
                id: `model-${route}`,
                baseUrl,
                cost: { input: index + 1, output: index + 1, cacheRead: 0, cacheWrite: 0 },
              }),
            ],
          },
        ],
        maxRetries: 0,
      })
    })
    const routes: RouteTable = { primary: { route: 'a', model: 'model-a' } }
    const provider = createProvider({
      adapters,
      routes,
      contract: new NullContractStore(),
      secrets: () => 'test-only-marker',
      clock: () => 0,
    })
    const defaultSelection = resolveSlot(routes, provider.registry, 'primary')
    const run = async (route: string, model: string) => {
      const events: InferenceEvent[] = []
      for await (const event of provider.infer(
        Object.freeze(fakeRequest({ route, model, timeoutMs: { firstToken: 2000, total: 5000 } })),
        { signal: new AbortController().signal, toolNames: [] },
      ))
        events.push(event)
      return events
    }
    const first = await run(defaultSelection.route, defaultSelection.model.id)
    const second = await run('b', 'model-b')
    const again = await run(defaultSelection.route, defaultSelection.model.id)
    expect(hits).toEqual([
      { path: '/a/chat/completions', model: 'model-a' },
      { path: '/b/chat/completions', model: 'model-b' },
      { path: '/a/chat/completions', model: 'model-a' },
    ])
    for (const [events, route, credits] of [
      [first, 'a', 0.002],
      [second, 'b', 0.004],
      [again, 'a', 0.002],
    ] as const) {
      expect(events[0]).toMatchObject({ type: 'sent', stamp: { model: { route, id: `model-${route}` } } })
      expect(events.find((event) => event.type === 'usage')).toMatchObject({ credits })
      expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
    }
    expect(await run('b', 'unsealed')).toEqual([
      expect.objectContaining({ type: 'error', code: 'NO_MODEL', retryable: false }),
    ])
    expect(hits).toHaveLength(3)
    assertLoopbackOnly()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    restoreLoopbackOnly()
  }
})
