import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { keepCacheBreakpointOnHistory } from '../src/adapters/pi/cache-breakpoint.js'

const NOTE = '[turn time]\n30s of this turn time limit used.'
const MARK = { type: 'ephemeral' }

function request(requestOnlyMessages?: number): RequestBody {
  return {
    kind: 'inference',
    sessionKey: 's',
    slot: 'primary',
    route: 'r',
    model: 'm',
    contractId: null,
    derivedHash: '0'.repeat(64),
    system: 'system',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ toolUseId: 't1', name: 'read', args: {}, ordinal: 0 }],
      },
      { role: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'ok' }], isError: false },
      { role: 'user', content: [{ type: 'text', text: NOTE }] },
    ],
    tools: [],
    ...(requestOnlyMessages === undefined ? {} : { requestOnlyMessages }),
  }
}

/** The shape pi-ai builds for Anthropic Messages: the mark on the last block of the last message. */
const anthropicPayload = () => ({
  system: [{ type: 'text', text: 'system', cache_control: MARK }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: NOTE, cache_control: MARK }] },
  ],
})

describe('the cache breakpoint stays on the history a request-only message follows', () => {
  it('moves the Anthropic mark from the request-only note to the last history block', () => {
    const payload = anthropicPayload()
    keepCacheBreakpointOnHistory('anthropic-messages', payload, request(1))
    expect(payload.messages[3]).toEqual({ role: 'user', content: [{ type: 'text', text: NOTE }] })
    expect(payload.messages[2]?.content[0]).toMatchObject({ type: 'tool_result', cache_control: MARK })
    // The system mark is not touched, and the number of marks stays the same.
    expect(payload.system[0]?.cache_control).toBe(MARK)
    expect(JSON.stringify(payload).split('cache_control').length - 1).toBe(2)
  })

  it('leaves the payload as built without request-only messages, or when its tail is not them', () => {
    for (const req of [request(), { ...request(1), messages: request().messages.slice(0, 3) }]) {
      const payload = anthropicPayload()
      keepCacheBreakpointOnHistory('anthropic-messages', payload, req)
      expect(payload).toEqual(anthropicPayload())
    }
    // An api without such marks is left alone too.
    const other = anthropicPayload()
    keepCacheBreakpointOnHistory('openai-responses', other, request(1))
    expect(other).toEqual(anthropicPayload())
  })

  it('moves an OpenAI-compatible Anthropic-style mark onto the last history text', () => {
    const payload = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system', cache_control: MARK }] },
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] },
        { role: 'tool', tool_call_id: 't1', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: NOTE, cache_control: MARK }] },
      ],
    }
    keepCacheBreakpointOnHistory('openai-completions', payload, request(1))
    expect(payload.messages[4]).toEqual({ role: 'user', content: [{ type: 'text', text: NOTE }] })
    expect(payload.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 't1',
      content: [{ type: 'text', text: 'ok', cache_control: MARK }],
    })
  })

  it('moves a Bedrock cache point to the last history user message', () => {
    const point = { cachePoint: { type: 'default' } }
    const payload = {
      messages: [
        { role: 'user', content: [{ text: 'do it' }] },
        { role: 'assistant', content: [{ toolUse: { toolUseId: 't1' } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'ok' }] } }] },
        { role: 'user', content: [{ text: NOTE }, point] },
      ],
    }
    keepCacheBreakpointOnHistory('bedrock-converse-stream', payload, request(1))
    expect(payload.messages[3]).toEqual({ role: 'user', content: [{ text: NOTE }] })
    expect(payload.messages[2]?.content.at(-1)).toBe(point)
  })
})
