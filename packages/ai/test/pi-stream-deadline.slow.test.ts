import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import type { WireEvent } from '../src/index.js'
import { PiAdapter } from '../src/index.js'
import {
  assertLoopbackOnly,
  fakeModel,
  fakeRequest,
  installLoopbackOnly,
  restoreLoopbackOnly,
} from '../testkit/index.js'

/**
 * The request deadline bounds a model request only until its answer starts. Three layers are handed
 * it: this adapter's own timer, the deployment fetch, and the `timeout` pi-ai passes to the OpenAI
 * SDK. The first two have their own tests; the SDK's can only be seen on a real socket, so this
 * streams a real answer for four times the request deadline and expects all of it.
 */
const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const savedEnv = new Map<string, string | undefined>()
let server: Server | undefined

beforeAll(() => {
  installLoopbackOnly()
  for (const key of [...PROXY_VARIABLES, 'NO_PROXY']) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.NO_PROXY = '127.0.0.1,localhost'
})

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restoreLoopbackOnly()
})

afterEach(async () => {
  const closing = server
  server = undefined
  if (closing)
    await new Promise<void>((resolve) => {
      closing.closeAllConnections()
      closing.close(() => resolve())
    })
  assertLoopbackOnly()
})

const chunk = (body: object) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'flash', ...body })}\n\n`

it('streams an OpenAI-compatible answer well past the request deadline it was given', async () => {
  const parts = 16
  server = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    let sent = 0
    const tick = setInterval(() => {
      if (sent < parts) {
        response.write(chunk({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }))
        sent++
        return
      }
      clearInterval(tick)
      response.write(
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: parts, total_tokens: parts + 1 },
        }),
      )
      response.end('data: [DONE]\n\n')
    }, 50)
    response.on('close', () => clearInterval(tick))
  })
  const port = await new Promise<number>((resolve) =>
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }),
  )
  const baseUrl = `http://127.0.0.1:${port}/v1`
  const adapter = new PiAdapter({
    manualRoutes: [
      {
        route: 'gw',
        api: 'openai-completions',
        baseUrl,
        credentialRef: 'secret://agnes/gateway',
        // About 850 ms of answer against a 200 ms request deadline; gaps stay far below the idle limit.
        networkTimeouts: { requestMs: 200, streamIdleMs: 1_000 },
        models: [fakeModel({ id: 'flash', route: 'gw', api: 'openai-completions', baseUrl })],
      },
    ],
    maxRetries: 0,
  })
  adapter.bindCredential('gw', 'sk-test')
  const events: WireEvent[] = []
  for await (const event of adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash' }), {
    signal: new AbortController().signal,
    toolNames: [],
    sessionKey: 'k',
    timeoutMs: { firstToken: 5_000, total: 5_000 },
  }))
    events.push(event)
  expect(events.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : [])).join('')).toBe(
    'a'.repeat(parts),
  )
  expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
})
