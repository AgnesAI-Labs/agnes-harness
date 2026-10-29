import { describe, expect, it } from 'vitest'
import { isNotification, isRequest, isResponse } from '../src/rpc.js'

describe('json-rpc three-way split', () => {
  it('classifies request / notification / response', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe(true)
    expect(isNotification({ jsonrpc: '2.0', method: 'session/cancel' })).toBe(true)
    expect(isResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true)
    expect(isRequest({ jsonrpc: '2.0', method: 'x' })).toBe(false)
    expect(isResponse({ jsonrpc: '2.0', id: 1, method: 'x' })).toBe(false)
  })
})
