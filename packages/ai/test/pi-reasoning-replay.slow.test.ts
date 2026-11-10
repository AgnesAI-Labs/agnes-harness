import { createServer, type Server } from 'node:http'
import type { RequestBody } from '@agnes/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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
 * The previous step's reasoning must reach the model again. This runs two rounds against a real
 * socket speaking chat-completions: round one streams `reasoning_content`, round two replays that
 * history, and the second request body must carry the first round's reasoning as `reasoning_content`.
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

type SentMessage = { role: string; content?: unknown; reasoning_content?: string }

async function listen(bodies: Array<{ messages: SentMessage[] }>): Promise<string> {
  server = createServer((request, response) => {
    let raw = ''
    request.on('data', (part) => {
      raw += part
    })
    request.on('end', () => {
      bodies.push(JSON.parse(raw))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const delta of [
        { reasoning_content: 'first, ' },
        { reasoning_content: 'then this' },
        { content: 'answer' },
      ])
        response.write(chunk({ choices: [{ index: 0, delta, finish_reason: null }] }))
      response.write(
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        }),
      )
      response.end('data: [DONE]\n\n')
    })
  })
  const port = await new Promise<number>((resolve) =>
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }),
  )
  return `http://127.0.0.1:${port}/v1`
}

async function twoRounds(model: Parameters<typeof fakeModel>[0]) {
  const bodies: Array<{ messages: SentMessage[] }> = []
  const baseUrl = await listen(bodies)
  const adapter = new PiAdapter({
    manualRoutes: [
      {
        route: 'gw',
        api: 'openai-completions',
        baseUrl,
        credentialRef: 'secret://agnes/gateway',
        models: [fakeModel({ ...model, baseUrl })],
      },
    ],
    maxRetries: 0,
  })
  adapter.bindCredential('gw', 'sk-test')
  const run = async (messages: RequestBody['messages']) => {
    const events: WireEvent[] = []
    for await (const event of adapter.stream('gw', fakeRequest({ route: 'gw', model: 'flash', messages }), {
      signal: new AbortController().signal,
      toolNames: [],
      sessionKey: 'k',
      timeoutMs: { firstToken: 5_000, total: 5_000 },
    }))
      events.push(event)
    return events
  }
  const first = await run([{ role: 'user', content: [{ type: 'text', text: 'q' }] }])
  const done = first.at(-1)
  const thinking = first.flatMap((e) => (e.type === 'thinking_delta' ? [e.delta] : [])).join('')
  const signature = done?.type === 'done' ? done.thinkingSignature : undefined
  await run([
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: thinking, ...(signature ? { signature } : {}) },
        { type: 'text', text: 'answer' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'q2' }] },
  ])
  return { first, thinking, signature, bodies }
}

describe('replaying the previous step reasoning', () => {
  it('second request carries reasoning_content', async () => {
    const { thinking, signature, bodies } = await twoRounds({
      id: 'flash',
      route: 'gw',
      api: 'openai-completions',
      reasoning: true,
      thinkingReplay: 'native',
    })
    expect(thinking).toBe('first, then this')
    expect(signature).toBe('reasoning_content')
    expect(bodies).toHaveLength(2)
    const replayed = bodies[1]?.messages.find((m) => m.role === 'assistant')
    expect(replayed?.reasoning_content).toBe('first, then this')
  })

  it('compatible-account record (reasoning:false, thinkingReplay:native) still sends reasoning_content in round 2', async () => {
    const { signature, bodies } = await twoRounds({
      id: 'flash',
      route: 'gw',
      api: 'openai-completions',
      reasoning: false,
      thinkingReplay: 'native',
    })
    expect(signature).toBe('reasoning_content')
    const replayed = bodies[1]?.messages.find((m) => m.role === 'assistant')
    expect(replayed?.reasoning_content).toBe('first, then this')
  })
})
