import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { MemorySource } from '../gen/ts/app-server.js'

describe('MemorySource', () => {
  it('MemorySource with maintenance validates and without it is unchanged', () => {
    expect(Value.Check(MemorySource, { sessionKey: 's', turn: 0 })).toBe(true)
    expect(Value.Check(MemorySource, { sessionKey: 's', turn: 2, toolUseId: 'call-1' })).toBe(true)
    expect(Value.Check(MemorySource, { sessionKey: 's', turn: 2, maintenance: 'run-1' })).toBe(true)
    expect(Value.Check(MemorySource, { sessionKey: 's', turn: 2, maintenance: 'r'.repeat(128) })).toBe(true)
  })

  it('keeps turn required and closed to unknown fields', () => {
    expect(Value.Check(MemorySource, { sessionKey: 's', maintenance: 'run-1' })).toBe(false)
    expect(Value.Check(MemorySource, { sessionKey: 's', turn: 2, maintenance: '' })).toBe(false)
    expect(Value.Check(MemorySource, { sessionKey: 's', turn: 2, maintenance: 'r'.repeat(129) })).toBe(false)
    expect(Value.Check(MemorySource, { sessionKey: 's', turn: 2, evidenceTurn: 1 })).toBe(false)
  })
})
