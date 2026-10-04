import { describe, expect, it } from 'vitest'
import { parameterMode } from '../src/parameter-mode.js'
import type { JsonValue, ToolDescriptor } from '../src/types.js'

const tool: ToolDescriptor = {
  name: 'host',
  description: 'Host tool',
  parameters: {},
  output: {},
  revision: '1',
}
const closed: JsonValue = { type: 'object', properties: {}, additionalProperties: false }

describe('caller parameter classification', () => {
  it('recognizes an exact closed empty object or a consistent trusted host declaration', () => {
    expect(parameterMode({ ...tool, parameters: closed })).toBe('no_arguments')
    expect(parameterMode({ ...tool, parameters: { type: 'object', additionalProperties: false } })).toBe(
      'no_arguments',
    )
    expect(parameterMode({ ...tool, parameterMode: 'no_arguments' })).toBe('no_arguments')
    expect(parameterMode({ ...tool, parameters: closed, parameterMode: 'parameterized' })).toBe(
      'parameterized',
    )
  })

  it('does not infer no arguments from an open schema, optional fields or declared defaults', () => {
    for (const parameters of [
      {},
      true,
      false,
      [],
      null,
      { type: 'object', properties: {} },
      {
        type: 'object',
        properties: { mode: { type: 'string', default: 'normal' } },
        additionalProperties: false,
      },
      { type: 'object', patternProperties: { '^x': { type: 'string' } }, additionalProperties: false },
      { type: 'object', additionalProperties: false, $ref: '#/$defs/input' },
      { type: 'object', additionalProperties: false, allOf: [] },
      { type: 'object', additionalProperties: false, const: { impossible: true } },
      { type: 'object', additionalProperties: false, enum: [] },
      { type: 'object', additionalProperties: false, maxProperties: -1 },
    ] satisfies JsonValue[]) {
      expect(parameterMode({ ...tool, parameters, defaults: {} })).toBe('parameterized')
    }
  })

  it('rejects no-argument declarations that contradict explicit caller parameters', () => {
    for (const parameters of [
      { type: 'string' },
      { type: 'object', properties: { optional: { type: 'string' } } },
      { type: 'object', required: ['missing'] },
      { type: 'object', minProperties: 1 },
      { $ref: '#/$defs/input' },
      { oneOf: [{ type: 'object' }] },
    ] satisfies JsonValue[]) {
      expect(() => parameterMode({ ...tool, parameters, parameterMode: 'no_arguments' })).toThrow(
        'no_arguments declaration',
      )
    }
    expect(() =>
      parameterMode({ ...tool, parameterMode: 'no_arguments', defaults: { mode: 'normal' } }),
    ).toThrow('no_arguments declaration')
  })
})
