import { describe, expect, it } from 'vitest'
import {
  MemorySessionPrincipalOwnership,
  SessionPrincipalOwnershipIndex,
} from '../src/storage/session-ownership.js'
import { captureSessionOwnershipFact } from '../src/supervisor/session-ownership-fact.js'
import { sqliteTables } from './sqlite-tables.js'

describe.each(['memory', 'sqlite'] as const)('original session ownership fact: %s', (kind) => {
  it('requires an active original row and rechecks the same owner', async () => {
    const tables = kind === 'sqlite' ? sqliteTables() : undefined
    try {
      const original = tables
        ? new SessionPrincipalOwnershipIndex(tables.table('session_principal_ownership'))
        : new MemorySessionPrincipalOwnership()
      expect(() => captureSessionOwnershipFact(original, 'missing', 'local')).toThrow(
        'original session ownership unavailable',
      )
      expect(original.bindNew('session-a', 'local')).toBe(true)
      expect(() => captureSessionOwnershipFact(original, 'session-a', 'local')).toThrow(
        'original session ownership unavailable',
      )
      expect(original.activateNew('session-a', 'local')).toBe(true)
      expect(() => captureSessionOwnershipFact(original, 'session-a', 'foreign')).toThrow(
        'original session ownership unavailable',
      )
      const fact = captureSessionOwnershipFact(original, 'session-a', 'local')
      expect(fact.principalId).toBe('local')
      expect(fact.sessionId).toBe('session-a')
      expect(fact.check()).toBeUndefined()
      expect(original.bindNew('session-a', 'foreign')).toBe(false)
      expect(fact.check()).toBeUndefined()
    } finally {
      await tables?.close()
    }
  })
})

it('rejects a changed or unavailable source on every recheck', () => {
  let principalId: string | undefined = 'local'
  let failed = false
  const source = {
    resolve: () => {
      if (failed) throw new Error('source failed')
      return principalId ? ({ active: true, principalId } as const) : undefined
    },
  }
  const fact = captureSessionOwnershipFact(source, 'session-a', 'local')
  principalId = 'foreign'
  expect(fact.check).toThrow('original session ownership unavailable')
  principalId = undefined
  expect(fact.check).toThrow('original session ownership unavailable')
  failed = true
  expect(fact.check).toThrow('original session ownership unavailable')
})

it('rejects replacement of the original resolver even when the forged row is identical', () => {
  const source = { resolve: () => ({ active: true as const, principalId: 'local' }) }
  const fact = captureSessionOwnershipFact(source, 'session-a', 'local')
  expect(fact.check()).toBeUndefined()
  source.resolve = () => ({ active: true as const, principalId: 'local' })
  expect(fact.check).toThrow('original session ownership unavailable')
})

it('rejects a damaged durable owner row after capture', async () => {
  const tables = sqliteTables()
  try {
    const table = tables.table('session_principal_ownership')
    const original = new SessionPrincipalOwnershipIndex(table)
    expect(original.bindNew('session-a', 'local')).toBe(true)
    expect(original.activateNew('session-a', 'local')).toBe(true)
    const fact = captureSessionOwnershipFact(original, 'session-a', 'local')
    table.exec('UPDATE session_principal_ownership SET principal_id = ? WHERE session_id = ?', [
      'foreign',
      'session-a',
    ])
    expect(fact.check).toThrow('original session ownership unavailable')
  } finally {
    await tables.close()
  }
})
