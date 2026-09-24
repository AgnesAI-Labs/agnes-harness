import { CoreError } from '@agnes/core'
import { BRIDGE_ERRORS, validateBridgeFrame } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { hasBridgeCode, toBridgeError } from '../src/extensions/code-mode/bridge-errors.js'

it('maps the actual CoreError depth refusal without exposing operands', () => {
  expect(toBridgeError(new CoreError('E_DEPTH_EXCEEDED', 'private detail', { secret: 'private' }))).toEqual({
    code: 1003,
    message: BRIDGE_ERRORS[1003],
  })
})
it.each([
  ['BUDGET_EXCEEDED', 1001],
  ['APPROVAL_REJECTED', 1002],
  ['DEPTH_EXCEEDED', 1003],
  ['TOOL_NOT_FOUND', 1004],
  ['TOOL_NOT_DISCLOSED', 1004],
  ['TOOL_ARGS_INVALID', 1005],
  ['SCHEMA_INVALID', 1005],
] as const)('maps result code %s onto protocol code %i', (code, expected) => {
  const error = toBridgeError({ code, message: 'private detail' })
  expect(error.code).toBe(expected)
  expect(validateBridgeFrame({ jsonrpc: '2.0', id: 1, error }).ok).toBe(true)
  expect(JSON.stringify(error)).not.toContain('private')
})
it('maps real AbortError and keeps unrecognized failures internal', () => {
  expect(toBridgeError(new DOMException('private reason', 'AbortError'))).toEqual({
    code: -32800,
    message: 'bridge call cancelled',
  })
  for (const error of [
    new Error('private secret'),
    { code: 'E_STORAGE_FAULT', detail: 'private' },
    null,
    'private',
  ]) {
    expect(toBridgeError(error)).toEqual({ code: -32603, message: 'internal bridge error' })
  }
})
it('only accepts explicit protocol-owned bridge codes', () => {
  expect(hasBridgeCode({ bridgeCode: 1004 })).toBe(true)
  expect(toBridgeError({ bridgeCode: 1004, message: 'private' })).toEqual({
    code: 1004,
    message: 'TOOL_NOT_FOUND',
  })
  for (const bridgeCode of [1006, -32604, NaN, '1004', 1004.5]) {
    expect(hasBridgeCode({ bridgeCode })).toBe(false)
    expect(toBridgeError({ bridgeCode }).code).toBe(-32603)
  }
})
it('does not evaluate error code accessors or inherit governed codes', () => {
  let calls = 0
  const error = {
    get code() {
      calls++
      return 'BUDGET_EXCEEDED'
    },
    get bridgeCode() {
      calls++
      return 1001
    },
  }
  expect(toBridgeError(error).code).toBe(-32603)
  expect(calls).toBe(0)
  expect(toBridgeError(Object.create({ code: 'BUDGET_EXCEEDED' })).code).toBe(-32603)
})
