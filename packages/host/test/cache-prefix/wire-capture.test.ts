import { describe, expect, it } from 'vitest'
import {
  type CapturedRequest,
  expectExtends,
  renderedParts,
  sharedPrefix,
} from '../../testkit/wire-capture.js'

const captured = (api: CapturedRequest['api'], body: Record<string, unknown>): CapturedRequest => ({
  api,
  body,
  raw: JSON.stringify(body),
})

describe('wire prefix capture', () => {
  it('orders provider cache parts and removes cache-control metadata', () => {
    const anthropic = captured('anthropic-messages', {
      tools: [{ name: 'read', cache_control: { type: 'ephemeral' } }],
      system: [{ text: 'rules', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] },
      ],
    })
    expect(renderedParts(anthropic)).toEqual([
      { key: 'tools', bytes: '[{"name":"read"}]' },
      { key: 'system', bytes: '[{"text":"rules"}]' },
      {
        key: 'messages[0]',
        bytes: '[{"role":"user","content":[{"type":"text","text":"hello"}]}]'.slice(1, -1),
      },
    ])
    const completions = captured('openai-completions', {
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{ type: 'function', function: { name: 'read' } }],
    })
    expect(renderedParts(completions).map((part) => part.key)).toEqual(['tools', 'system', 'messages[0]'])
    const responses = captured('openai-responses', {
      instructions: 'rules',
      input: [{ role: 'user', content: 'hello' }],
    })
    expect(renderedParts(responses).map((part) => part.key)).toEqual(['instructions', 'input[0]'])
  })

  it('reports the first divergent part and compares only the requested prefix', () => {
    const first = captured('anthropic-messages', {
      tools: [{ name: 'read' }],
      system: 'rules',
      messages: [{ role: 'user', content: 'one' }],
    })
    const appended = captured('anthropic-messages', {
      tools: [{ name: 'read' }],
      system: 'rules',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
    })
    expectExtends(first, appended)
    expect(sharedPrefix(first, appended)).toMatchObject({ breakAt: null })
    const changed = captured('anthropic-messages', {
      tools: [{ name: 'write' }],
      system: 'rules',
      messages: [{ role: 'user', content: 'one' }],
    })
    expect(sharedPrefix(first, changed).breakAt).toBe('tools')
    expect(() => expectExtends(first, changed)).toThrow('Wire prefix diverged at tools')
  })
})
