import { describe, expect, it } from 'vitest'
import { compilePluginConfig, redactPluginConfig } from '../src/plugin-config-validation.js'

describe('plugin configuration JSON Schema', () => {
  it.each([
    [
      {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      { name: 'agent' },
      {},
    ],
    [{ type: 'array', items: { type: 'integer' }, uniqueItems: true }, [1, 2], [1, 1]],
    [{ enum: ['a', 'b'] }, 'a', 'c'],
    [{ oneOf: [{ type: 'number' }, { type: 'string' }] }, 1, null],
    [{ anyOf: [{ type: 'number' }, { type: 'integer' }] }, 1, true],
    [
      {
        $defs: {
          node: {
            type: 'object',
            properties: {
              children: { type: 'array', items: { $ref: '#/$defs/node' } },
              count: { type: 'integer' },
            },
          },
        },
        $ref: '#/$defs/node',
      },
      { children: [{ count: 2 }] },
      { children: [{ count: 'bad' }] },
    ],
    [{ type: 'object', additionalProperties: { type: 'number' } }, { custom: 2 }, { custom: 'bad' }],
    [
      { type: 'string', format: 'email', description: 'A contact', default: 'agent@example.com' },
      'agent@example.com',
      'bad',
    ],
    [
      { type: 'object', patternProperties: { '^x': { type: 'integer' } }, additionalProperties: false },
      { x1: 2 },
      { y1: 2 },
    ],
    [{ type: 'array', prefixItems: [{ type: 'string' }], items: false }, ['hello'], ['hello', 1]],
  ])('validates all constructs without mutating values or exposing them (%j)', (schema, good, bad) => {
    const validate = compilePluginConfig(schema)
    const before = JSON.stringify(good)
    expect(validate(good)).toEqual([])
    expect(validate(bad).length).toBeGreaterThan(0)
    expect(JSON.stringify(good)).toBe(before)
    expect(validate(bad).every((issue) => Object.keys(issue).sort().join(',') === 'code,path')).toBe(true)
  })

  it('refuses plaintext in nested, variant, reference and map secret fields and redacts their audit', () => {
    const schema = {
      $defs: { key: { type: 'string', 'x-secret': true } },
      type: 'object',
      properties: {
        api: { $ref: '#/$defs/key' },
        map: { type: 'object', additionalProperties: { type: 'string', writeOnly: true } },
        variant: { anyOf: [{ $ref: '#/$defs/key' }, { type: 'null' }] },
      },
    }
    const validate = compilePluginConfig(schema)
    const safe = { api: 'secret://demo/key', map: { arbitrary: 'secret://demo/map' }, variant: null }
    expect(validate(safe)).toEqual([])
    const bad = {
      api: 'synthetic-plaintext',
      map: { arbitrary: 'synthetic-plaintext' },
      variant: 'synthetic-plaintext',
    }
    expect(validate(bad).map((issue) => issue.path)).toContain('/api')
    expect(JSON.stringify(validate(bad))).not.toContain('synthetic-plaintext')
    expect(JSON.stringify(redactPluginConfig(safe))).not.toContain('secret://')
    for (const schema of [
      { $ref: 'https://invalid/schema' },
      { type: 'invalid' },
      { format: 'unregistered' },
      { type: 'string', 'x-secret': true, default: 'synthetic-plaintext' },
      { $async: true },
      {
        type: 'object',
        properties: { auth: { type: 'string', 'x-secret': true } },
        default: { auth: 'synthetic-plaintext' },
      },
    ])
      expect(() => compilePluginConfig(schema)).toThrow('Invalid synchronous')
  })
})
