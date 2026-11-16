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
    expect(f.ownership.lineage('child')).toBeUndefined() // pending forks are not visible yet
    expect(f.ownership.inherit('parent', 'child', 'owner-a', 8)).toBe(false)
    expect(f.ownership.inherit('parent', 'child', 'owner-a', 7)).toBe(true)
    expect(f.ownership.bindNew('child', 'owner-a')).toBe(false)
    expect(f.ownership.activateFork('parent', 'child', 'owner-a', 7)).toBe(true)
    expect(f.ownership.bindNew('other-child', 'owner-b')).toBe(true)
    expect(f.ownership.activateNew('other-child', 'owner-b')).toBe(true)
    expect(f.ownership.inherit('parent', 'other-child', 'owner-a', 7)).toBe(false)
    expect(f.ownership.resolve('child')).toEqual({ active: true, principalId: 'owner-a' })
    expect(f.ownership.lineage('child')).toEqual({ parent: 'parent', forkAt: 7 })
    expect(f.ownership.lineage('parent')).toBeUndefined()
    expect(f.ownership.lineage('other-child')).toBeUndefined()
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

  it('records the creator with the first reservation only, through replays and activation, never later', async () => {
    const f = fixture()
    expect(f.ownership.bindNew('app', 'owner-a', 'bundled-app')).toBe(true)
    expect(f.ownership.creator('app')).toBe('bundled-app')
    // A creation interrupted before activation and replayed by any caller keeps the first creator.
    expect(f.ownership.bindNew('app', 'owner-a')).toBe(true)
    expect(f.ownership.bindNew('app', 'owner-b', 'bundled-app')).toBe(false)
    expect(f.ownership.activateNew('app', 'owner-a')).toBe(true)
    expect(f.ownership.bindNew('app', 'owner-a')).toBe(true)
    expect(f.ownership.creator('app')).toBe('bundled-app')
    // A reservation made without one is never given one, pending or active.
    expect(f.ownership.bindNew('plain', 'owner-a')).toBe(true)
    expect(f.ownership.bindNew('plain', 'owner-a', 'bundled-app')).toBe(true)
    expect(f.ownership.creator('plain')).toBeUndefined()
    expect(f.ownership.activateNew('plain', 'owner-a')).toBe(true)
    expect(f.ownership.bindNew('plain', 'owner-a', 'bundled-app')).toBe(true)
    expect(f.ownership.creator('plain')).toBeUndefined()
    // A fork inherits the owner, not the creator.
    expect(f.ownership.inherit('app', 'app/child', 'owner-a', 3)).toBe(true)
    expect(f.ownership.activateFork('app', 'app/child', 'owner-a', 3)).toBe(true)
    expect(f.ownership.creator('app/child')).toBeUndefined()
    // An unknown creator reserves nothing.
    expect(f.ownership.bindNew('odd', 'owner-a', 'someone-else' as never)).toBe(false)
    expect(f.ownership.creator('odd')).toBeUndefined()
    expect(f.ownership.bindNew('odd', 'owner-a')).toBe(true)
    expect(f.ownership.creator('odd')).toBeUndefined()
    expect(f.ownership.creator('missing')).toBeUndefined()
    await f.close()
  })
})

it('keeps the creator across sqlite reopen and adds none to a database that predates it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-session-creator-'))
  roots.push(root)
  const file = join(root, 'owners.db')
  // The ownership table as a release without creators left it, with a session it reserved.
  const before = sqliteTables(file)
  const old = before.table('session_principal_ownership')
  old.exec(`CREATE TABLE session_principal_ownership (
    session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, reservation_kind TEXT NOT NULL,
    reservation_state TEXT NOT NULL, parent_session_id TEXT, boundary_seq INTEGER)`)
  old.exec(
    "INSERT INTO session_principal_ownership VALUES ('superagent:worker:old', 'owner-a', 'new', 'active', NULL, NULL)",
  )
  await before.close()
  const first = sqliteTables(file)
  const upgraded = new SessionPrincipalOwnershipIndex(first.table('session_principal_ownership'))
  expect(upgraded.resolve('superagent:worker:old')).toEqual({ active: true, principalId: 'owner-a' })
  expect(upgraded.bindNew('superagent:worker:old', 'owner-a', 'bundled-app')).toBe(true)
  expect(upgraded.creator('superagent:worker:old')).toBeUndefined()
  expect(upgraded.bindNew('superagent:worker:new', 'owner-a', 'bundled-app')).toBe(true)
  await first.close()
  const second = sqliteTables(file)
  const reopened = new SessionPrincipalOwnershipIndex(second.table('session_principal_ownership'))
  // Reopened before activation, as after a stop mid-creation: the replay finds the creator it began with.
  expect(reopened.bindNew('superagent:worker:new', 'owner-a')).toBe(true)
  expect(reopened.activateNew('superagent:worker:new', 'owner-a')).toBe(true)
  expect(reopened.creator('superagent:worker:new')).toBe('bundled-app')
  expect(reopened.creator('superagent:worker:old')).toBeUndefined()
  await second.close()
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
