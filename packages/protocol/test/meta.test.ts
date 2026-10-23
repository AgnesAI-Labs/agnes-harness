import { describe, expect, it } from 'vitest'
import { getHarnessMeta, META_KEY, parseSystemPromptAppend, setHarnessMeta } from '../src/index.js'

describe('meta', () => {
  const meta = { promptTurnId: '12', eventSequence: 40, generation: 2, lane: 'main', phase: 'event' as const }
  it('round-trips under the harness key', () => {
    const msg = setHarnessMeta({ method: 'session/update', params: {} }, meta)
    expect(msg._meta[META_KEY]).toEqual(meta)
    expect(getHarnessMeta(msg)).toEqual(meta)
  })
  it('returns undefined when absent or malformed', () => {
    expect(getHarnessMeta({})).toBeUndefined()
    expect(getHarnessMeta({ _meta: { [META_KEY]: { phase: 'nope' } } })).toBeUndefined()
  })
  it('defends against top-level malformed input', () => {
    expect(getHarnessMeta(null as never)).toBeUndefined()
    expect(getHarnessMeta(undefined as never)).toBeUndefined()
    expect(getHarnessMeta('nope' as never)).toBeUndefined()
    expect(getHarnessMeta(5 as never)).toBeUndefined()
  })
})

describe('session/new systemPromptAppend', () => {
  it('accepts 1 to 8192 characters', () => {
    expect(parseSystemPromptAppend('Answer in French.')).toBe('Answer in French.')
    expect(parseSystemPromptAppend('x'.repeat(8192))).toHaveLength(8192)
  })
  it.each([
    ['empty', ''],
    ['over the cap', 'x'.repeat(8193)],
    ['NUL', 'a\0b'],
    ['not a string', 5],
    ['absent value', undefined],
  ])('refuses %s', (_name, value) => {
    expect(() => parseSystemPromptAppend(value)).toThrow(TypeError)
  })
})
