import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MemorySessionPrincipalOwnership,
  SessionPrincipalOwnershipIndex,
} from '../src/storage/session-ownership.js'
import { sqliteTables } from './sqlite-tables.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.each([
  [
    'memory',
    () => ({
      ownership: new MemorySessionPrincipalOwnership(),
      close: async (): Promise<void> => undefined,
    }),
  ],
  [
    'sqlite',
    () => {
      const tables = sqliteTables()
      return {
        ownership: new SessionPrincipalOwnershipIndex(tables.table('session_principal_ownership')),
        close: (): Promise<void> => tables.close(),
      }
    },
  ],
])('session principal ownership: %s', (_name, fixture) => {
  it('binds once, permits the same owner, and refuses reassignment', async () => {
    const f = fixture()
    expect(f.ownership.resolve('session-a')).toBeUndefined()
    expect(f.ownership.bindNew('session-a', 'owner-a')).toBe(true)
    expect(f.ownership.resolve('session-a')).toBeUndefined()
    expect(f.ownership.bindNew('session-a', 'owner-a')).toBe(true)
    expect(f.ownership.bindNew('session-a', 'owner-b')).toBe(false)
    expect(f.ownership.activateNew('session-a', 'owner-a')).toBe(true)
    expect(f.ownership.resolve('session-a')).toEqual({ active: true, principalId: 'owner-a' })
    expect(f.ownership.activeSessionIds('owner-a')).toEqual(['session-a'])
    expect(f.ownership.activeSessionIds('owner-b')).toEqual([])
    await f.close()
  })

  it('inherits only from the authenticated parent owner and never rewrites a child', async () => {
    const f = fixture()
    expect(f.ownership.bindNew('parent', 'owner-a')).toBe(true)
    expect(f.ownership.activateNew('parent', 'owner-a')).toBe(true)
    expect(f.ownership.inherit('missing', 'child', 'owner-a', 7)).toBe(false)
    expect(f.ownership.inherit('parent', 'child', 'owner-b', 7)).toBe(false)
    expect(f.ownership.inherit('parent', 'parent', 'owner-a', 7)).toBe(false)
    expect(f.ownership.inherit('parent', 'child', 'owner-a', 7)).toBe(true)
    expect(f.ownership.resolve('child')).toBeUndefined()
    expect(f.ownership.inherit('parent', 'child', 'owner-a', 8)).toBe(false)
    expect(f.ownership.inherit('parent', 'child', 'owner-a', 7)).toBe(true)
    expect(f.ownership.bindNew('child', 'owner-a')).toBe(false)
    expect(f.ownership.activateFork('parent', 'child', 'owner-a', 7)).toBe(true)
    expect(f.ownership.bindNew('other-child', 'owner-b')).toBe(true)
    expect(f.ownership.activateNew('other-child', 'owner-b')).toBe(true)
    expect(f.ownership.inherit('parent', 'other-child', 'owner-a', 7)).toBe(false)
    expect(f.ownership.resolve('child')).toEqual({ active: true, principalId: 'owner-a' })
    await f.close()
  })

  it('rejects malformed identities without creating a claim', async () => {
    const f = fixture()
    for (const value of ['', 'bad\u0000id', 'x'.repeat(513)]) {
      expect(f.ownership.bindNew(value, 'owner-a')).toBe(false)
      expect(f.ownership.bindNew('session-a', value)).toBe(false)
      expect(f.ownership.resolve(value)).toBeUndefined()
    }
    expect(f.ownership.resolve('session-a')).toBeUndefined()
    await f.close()
  })
})

it('persists the immutable principal across sqlite reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-session-owner-'))
  roots.push(root)
  const file = join(root, 'owners.db')
  const first = sqliteTables(file)
  expect(
    new SessionPrincipalOwnershipIndex(first.table('session_principal_ownership')).bindNew(
      'session-a',
      'owner-a',
    ),
  ).toBe(true)
  expect(
    new SessionPrincipalOwnershipIndex(first.table('session_principal_ownership')).activateNew(
      'session-a',
      'owner-a',
    ),
  ).toBe(true)
  await first.close()
  const second = sqliteTables(file)
  const reopened = new SessionPrincipalOwnershipIndex(second.table('session_principal_ownership'))
  expect(reopened.resolve('session-a')).toEqual({ active: true, principalId: 'owner-a' })
  expect(reopened.bindNew('session-a', 'owner-b')).toBe(false)
  await second.close()
})

it('rejects proxy and accessor-bearing storage capabilities without invoking them', () => {
  expect(
    () =>
      new SessionPrincipalOwnershipIndex(
        new Proxy({} as never, {
          get() {
            throw new Error('must not execute')
          },
        }),
      ),
  ).toThrow('session principal ownership unavailable')
  let touched = false
  const hostile = Object.defineProperty({}, 'exec', {
    enumerable: true,
    get() {
      touched = true
      return () => undefined
    },
  })
  expect(() => new SessionPrincipalOwnershipIndex(hostile as never)).toThrow(
    'session principal ownership unavailable',
  )
  expect(touched).toBe(false)
})

it('fails closed when an active ownership row is structurally corrupt', async () => {
  const tables = sqliteTables()
  const table = tables.table('session_principal_ownership')
  const ownership = new SessionPrincipalOwnershipIndex(table)
  expect(ownership.bindNew('session-a', 'owner-a')).toBe(true)
  expect(ownership.activateNew('session-a', 'owner-a')).toBe(true)
  table.exec('UPDATE session_principal_ownership SET parent_session_id = ? WHERE session_id = ?', [
    'forged-parent',
    'session-a',
  ])
  expect(() => ownership.activeSessionIds('owner-a')).toThrow('session principal ownership unavailable')
  await tables.close()
})
