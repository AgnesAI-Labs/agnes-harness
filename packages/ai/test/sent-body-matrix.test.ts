import { createServer } from 'node:http'
import type { InferenceEvent } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { sha256Hex } from '../src/hash.js'
import { createProvider, NullContractStore, PiAdapter } from '../src/index.js'
import { fakeModel, fakeRequest } from '../testkit/index.js'
import { assertLoopbackOnly, installLoopbackOnly, restoreLoopbackOnly } from './loopback-only.js'

const apis = [
  'openai-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'mistral-conversations',
  'pi-messages',
] as const
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
function reply(api: string): string {
  let events: Array<Record<string, unknown>>
  if (api.endsWith('responses')) {
    events = [
      { type: 'response.created', response: { id: 'resp-loopback' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg', role: 'assistant', content: [] },
      },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'matrix-ok' },
      {
        type: 'response.completed',
        response: {
          id: 'resp-loopback',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]
  } else if (api === 'anthropic-messages') {
    events = [
      {
        type: 'message_start',
        message: {
          id: 'msg',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'm',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'matrix-ok' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
  } else if (api === 'mistral-conversations') {
    events = [
      {
        choices: [{ index: 0, delta: { role: 'assistant', content: 'matrix-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]
  } else {
    events = [
      { type: 'start' },
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 0, delta: 'matrix-ok' },
      { type: 'text_end', contentIndex: 0, content: 'matrix-ok' },
      { type: 'done', reason: 'stop', usage },
    ]
  }
  return events
    .map((event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
    .join('')
}

it.each(apis)('%s reports final real HTTP bodies on defaults, errors and recovery', async (api) => {
  installLoopbackOnly()
  const bodies: Buffer[] = []
  const paths: string[] = []
  let fail = false
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    bodies.push(Buffer.concat(chunks))
    paths.push(req.url ?? '')
    if (fail) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"temporary loopback failure"}}')
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(reply(api))
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('missing loopback port')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const adapter = new PiAdapter({
      manualRoutes: [
        {
          route: 'matrix',
          api,
          baseUrl,
          credentialRef: 'fixture-marker',
          models: [
            fakeModel({ id: 'm', route: 'matrix', api, baseUrl, reasoning: true }),
            fakeModel({
              id: 'compat',
              route: 'matrix',
              api,
              baseUrl,
              reasoning: true,
              compat: { supportsDeveloperRole: false },
            }),
          ],
        },
      ],
      maxRetries: 0,
    })
    const provider = createProvider({
      adapters: [adapter],
      routes: { primary: { route: 'matrix', model: 'm' } },
      contract: new NullContractStore(),
      secrets: () => 'fixture-secret-never-in-stamp',
      clock: () => 0,
    })
    const execute = async (model = 'm', system = 'matrix system é', maxTokens?: number) => {
      const request = fakeRequest({
        route: 'matrix',
        model,
        system,
        ...(maxTokens === undefined ? {} : { sampling: { maxTokens } }),
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello é' }] }],
      })
      const start = bodies.length
      const events: InferenceEvent[] = []
      for await (const event of provider.infer(request, {
        signal: new AbortController().signal,
        toolNames: [],
      }))
        events.push(event)
      expect(bodies).toHaveLength(start + 1)
      const body = bodies[start]
      if (!body) throw new Error('missing actual body')
      expect(events[0]).toMatchObject({
        type: 'sent',
        stamp: {
          sent_hash: sha256Hex(body),
          derived_hash: request.derivedHash,
          transforms: model === 'compat' ? [{ event: 'compat', ext: 'pi' }] : [],
        },
      })
      expect(JSON.stringify(events[0])).not.toContain('fixture-secret')
      expect(body.toString()).toContain(system)
      expect(body.toString()).toContain('hello é')
      return { events, body: JSON.parse(body.toString()) as Record<string, unknown> }
    }
    const first = await execute()
    expect(first.events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
    expect(first.events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('')).toBe('matrix-ok')
    fail = true
    const failed = await execute('m', 'failing system')
    expect(failed.events.at(-1)).toMatchObject({ type: 'error' })
    fail = false
    const recovered = await execute('m', 'recovered system')
    expect(recovered.events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
    if (api.endsWith('responses')) {
      const compatible = await execute('compat')
      expect(compatible.events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
      expect(first.body.input).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'developer' })]),
      )
      expect(compatible.body.input).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'system' })]),
      )
    }
    if (api === 'mistral-conversations') {
      expect(first.body).not.toHaveProperty('max_tokens')
      const sampled = await execute('m', 'sampled system', 64)
      expect(sampled.events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
      expect(sampled.body).toHaveProperty('max_tokens', 64)
      expect(sampled.body).not.toHaveProperty('maxTokens')
    }
    expect(
      paths.every((path) =>
        path.includes(
          api.endsWith('responses')
            ? 'responses'
            : api === 'mistral-conversations'
              ? 'chat/completions'
              : 'messages',
        ),
      ),
    ).toBe(true)
    assertLoopbackOnly()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    restoreLoopbackOnly()
  }
})
