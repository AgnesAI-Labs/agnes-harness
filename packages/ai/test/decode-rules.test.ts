import { describe, expect, it } from 'vitest'
import { RULES } from '../src/decode/rules/index.js'
import { balancedClose } from '../src/decode/rules/inline-json.js'
import { parseLenient } from '../src/decode/rules/lenient-json.js'

const rule = (id: string) => {
  const found = RULES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing decode rule: ${id}`)
  return found
}

describe('decode rules', () => {
  it('keeps the syntactic rule order frozen', () => {
    expect(RULES.map((candidate) => candidate.id)).toEqual([
      'think_tag',
      'qwen3_coder',
      'anthropic_invoke',
      'hermes_tool_call',
      'inline_json',
    ])
  })

  it('extracts typed qwen and anthropic parameters', () => {
    expect(
      rule('qwen3_coder').extract(
        '<function=shell>',
        '<parameter=command>ls</parameter><parameter=n>3</parameter>',
      ),
    ).toEqual({ name: 'shell', args: { command: 'ls', n: 3 } })
    expect(
      rule('anthropic_invoke').extract('<invoke name="read">', '<parameter name="path">a</parameter>'),
    ).toEqual({ name: 'read', args: { path: 'a' } })
  })

  it('accepts Hermes object and string arguments and rejects garbage', () => {
    expect(rule('hermes_tool_call').extract('<tool_call>', '{"name":"read","arguments":{"p":1}}')).toEqual({
      name: 'read',
      args: { p: 1 },
    })
    expect(
      rule('hermes_tool_call').extract('<tool_call>', '{"name":"read","arguments":"{\\"p\\":2}"}'),
    ).toEqual({ name: 'read', args: { p: 2 } })
    expect(rule('hermes_tool_call').extract('<tool_call>', 'garbage')).toBeNull()
  })

  it('balances nested braces while ignoring braces in quoted strings', () => {
    expect(balancedClose('{"a":"}"} tail')).toBe(8)
    expect(balancedClose('{"a":{"b":1}} tail')).toBe(12)
    expect(balancedClose('{"a": {')).toBe(-1)
  })

  it('repairs the explicitly supported Python-shaped JSON tokens', () => {
    expect(parseLenient("{'name': 'read', 'arguments': {'p': True, 'q': None,},}")).toEqual({
      name: 'read',
      arguments: { p: true, q: null },
    })
  })
})
