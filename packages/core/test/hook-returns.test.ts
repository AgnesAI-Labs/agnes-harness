import type { HookEvent, HookReturnMap } from '@agnes/extension-api'
import { HOOK_EVENTS } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { HookDispatch } from '../src/hooks/dispatch.js'
import { authorHookReturn, contextReturnToWire } from '../src/hooks/returns.js'
import type { ContextResult } from '../src/request/transforms.js'
import { applyContextResults } from '../src/request/transforms.js'

const artifact = { sha256: 'a'.repeat(64), size: 12, mime: 'image/png' }
const valid: { [E in HookEvent]: HookReturnMap[E] } = {
  session_start: undefined,
  resources_discover: {
    resources: [{ id: 'skill-a', kind: 'skill', name: 'A', description: 'example' }],
    additionalContext: 'resource note',
  },
  before_step: { block: false },
  context: {
    sections: [{ id: 'a', order: 5, content: 'author text', source: 'untrusted source' }],
    additionalContext: 'note',
  },
  before_request: { patch: { maxTokens: 10, samplingParams: { temperature: 0 }, metadata: { test: true } } },
  before_provider_headers: { headers: { 'X-Ext-Test': 'value' } },
  request_error: undefined,
  tool_call: { allow: false, reason: 'refused' },
  tool_result: {
    result: {
      content: [
        { type: 'text', text: 'done' },
        { type: 'image', ref: artifact, mime: 'image/png' },
        { type: 'ref', ref: artifact },
      ],
      details: { ui: 'only' },
      terminate: true,
    },
  },
  turn_stopping: { action: 'continue', note: 'unfinished' },
  approval_request: { request: { risk: 'always', context: 'context', summary: 'review this' } },
  before_compact: {
    keepFromSeq: 5,
    summarizeRange: [1, 4],
    prompts: { system: 'summarize', history: 'history' },
    maxTokens: 100,
    details: { readFiles: [], modifiedFiles: [] },
  },
  compact: undefined,
  subagent_start: undefined,
  subagent_end: undefined,
  format_deviation: undefined,
  shutdown: undefined,
}

describe('author hook return boundary', () => {
  it.each(HOOK_EVENTS)('%s accepts its author contract and retains all author fields', (event) => {
    expect(authorHookReturn(event, valid[event])).toEqual(valid[event])
  })

  it.each(HOOK_EVENTS)('%s rejects an extra root property', (event) => {
    expect(() => authorHookReturn(event, { ...valid[event], injected: true })).toThrow(
      'invalid author hook return',
    )
  })

  it('uses an independent detached snapshot for nested author fields', () => {
    const input = structuredClone(valid.tool_result)
    const output = authorHookReturn('tool_result', input)
    if (!input.result || !output.result) throw new Error('missing fixture result')
    input.result.content.splice(0)
    input.result.details = { modified: true }
    expect(output).toEqual(valid.tool_result)
    output.result.terminate = false
    expect(input.result.terminate).toBe(true)
  })

  it.each(['enforcement', 'authz', 'toolUseId', 'transformedBy', 'structured', 'code'])(
    'refuses author-controlled ledger %s',
    (key) => {
      expect(() => authorHookReturn('tool_result', { result: { content: [], [key]: {} } })).toThrow(
        'invalid author hook return',
      )
    },
  )

  it.each(['tool', 'argv', 'argvHash', 'actor', 'decisionId'])(
    'refuses an approval patch changing bound field %s',
    (key) => {
      expect(() => authorHookReturn('approval_request', { request: { [key]: 'forged' } })).toThrow(
        'invalid author hook return',
      )
    },
  )

  it('retains approval summary without coercing it into context or the binding', () => {
    expect(authorHookReturn('approval_request', { request: { summary: 'review', context: 'why' } })).toEqual({
      request: { summary: 'review', context: 'why' },
    })
    expect(() => authorHookReturn('approval_request', { request: { summary: 3 } })).toThrow()
    expect(() => authorHookReturn('approval_request', { request: { risk: 'unknown' } })).toThrow()
  })

  it('maps context content to wire text and lets core18 stamp registered provenance', () => {
    const wire = contextReturnToWire(valid.context)
    expect(wire).toEqual({
      sections: [{ id: 'a', order: 5, text: 'author text' }],
      additionalContext: 'note',
    })
    const transformed = applyContextResults([], [{ ext: 'agnes/registered', result: wire }])
    expect(transformed.sections).toContainEqual({
      id: 'a',
      order: 5,
      text: 'author text',
      source: 'agnes/registered',
    })
    expect(JSON.stringify(transformed)).not.toContain('untrusted source')
  })

  it.each([
    { sections: [{ id: 'a', order: 1, text: 'wire field' }] },
    { sections: [{ id: 'a', order: 1, content: 'ok', text: 'hidden' }] },
    { sections: [{ id: 'a', order: -1, content: 'negative order' }] },
    { sections: [{ id: 'a', order: 1, content: 'ok', source: 1 }] },
    { sections: [{ id: 'a', order: 1, content: 'ok', actor: 'forged' }] },
  ])('rejects malformed or extra context fields %#', (value) => {
    expect(() => authorHookReturn('context', value)).toThrow('invalid author hook return')
  })

  it.each([
    { content: [{ type: 'image', ref: artifact }] },
    { content: [{ type: 'ref', ref: { ...artifact, sha256: 'bad' } }] },
    { content: [{ type: 'text', text: 'ok', uri: 'hidden' }] },
    { content: [], terminate: 'yes' },
    { content: [], details: Number.NaN },
  ])('rejects invalid author tool results %#', (result) => {
    expect(() => authorHookReturn('tool_result', { result })).toThrow('invalid author hook return')
  })

  it('rejects accessors without executing them or exposing their content', () => {
    let reads = 0
    const value = {
      get result() {
        reads++
        throw new Error('credential secret')
      },
    }
    expect(() => authorHookReturn('tool_result', value)).toThrow('invalid author hook return')
    expect(reads).toBe(0)
  })

  it('rejects nested toJSON hooks without invoking them', () => {
    let calls = 0
    const result = {
      content: [],
      details: {
        toJSON: () => {
          calls++
          return 'secret'
        },
      },
    }
    expect(() => authorHookReturn('tool_result', { result })).toThrow()
    expect(calls).toBe(0)
  })

  it('rejects sparse arrays, cycles and non-JSON values before schema traversal', () => {
    const cycle: unknown[] = []
    cycle.push(cycle)
    for (const details of [cycle, new Date(), new Map(), BigInt(2), new Array(1), Symbol('x')]) {
      expect(() => authorHookReturn('tool_result', { result: { content: [], details } })).toThrow()
    }
  })

  it('preserves safe own __proto__ data in UI-only details', () => {
    const result = { content: [], details: JSON.parse('{"__proto__":{"ui":"only"}}') }
    const checked = authorHookReturn('tool_result', { result })
    expect(JSON.stringify(checked)).toBe(JSON.stringify({ result }))
    expect(Object.getPrototypeOf(checked.result?.details)).toBeNull()
  })

  it('accepts null only for before_compact, not as an implicit transform or observe return', () => {
    expect(authorHookReturn('before_compact', null)).toBeNull()
    for (const event of ['context', 'tool_call', 'session_start'] as const) {
      expect(() => authorHookReturn(event, null)).toThrow()
    }
  })

  it('does not allow default headers to be overwritten through an extension header return', () => {
    expect(() =>
      authorHookReturn('before_provider_headers', { headers: { Authorization: 'secret' } }),
    ).toThrow('invalid author hook return')
  })
})

describe('dispatch to author validation to core18 context composition', () => {
  it('passes normalized prior sections to the next transform and caps multibyte additional context', async () => {
    const dispatcher = new HookDispatch({ diag: () => undefined, onFailure: () => undefined })
    const collected: Array<{ ext: string; result: ContextResult }> = []
    let applied = applyContextResults([], collected)
    const seen: string[] = []
    const result = await dispatcher.run(
      'context',
      [
        {
          source: 'agnes/one',
          invoke: () =>
            authorHookReturn('context', {
              sections: [{ id: 's', order: 10, content: 'first', source: 'forged' }],
              additionalContext: '界'.repeat(3000),
            }),
        },
        {
          source: 'agnes/two',
          invoke: () => {
            seen.push(applied.sections[0]?.text ?? '')
            return authorHookReturn('context', { additionalContext: '界'.repeat(3000) })
          },
        },
      ],
      new AbortController().signal,
      {
        commit: (value, source) => {
          collected.push({ ext: source, result: contextReturnToWire(value) })
          applied = applyContextResults([], collected)
        },
      },
    )
    expect(result.kind).toBe('ok')
    expect(seen).toEqual(['first'])
    expect(applied.sections[0]?.source).toBe('agnes/one')
    expect(new TextEncoder().encode(applied.additionalContext).length).toBe(8190)
    expect(applied.overflow).toEqual([{ ext: 'agnes/one', bytes: 9000 }])
  })

  it('refuses a malformed closed author return before downstream dispatch', async () => {
    const dispatcher = new HookDispatch({ diag: () => undefined, onFailure: () => undefined })
    let downstream = false
    const result = await dispatcher.run(
      'context',
      [
        {
          source: 'agnes/bad',
          invoke: () =>
            authorHookReturn('context', {
              sections: [{ id: 'a', order: 1, text: 'wire masquerading as author' }],
            }),
        },
        {
          source: 'agnes/next',
          invoke: () => {
            downstream = true
            return authorHookReturn('context', {})
          },
        },
      ],
      new AbortController().signal,
    )
    expect(result).toMatchObject({ kind: 'rejected', source: 'agnes/bad' })
    expect(downstream).toBe(false)
  })
})
