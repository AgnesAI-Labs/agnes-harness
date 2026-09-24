import { beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_V, normalize, registerMigration, supportedVersions } from '../src/index.js'
// resetMigrations is a test back door and is not on the root export surface (the same treatment
// DATA_DEFS gets), so tests that need it import the implementation module directly.
import { resetMigrations } from '../src/migrate.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const ev = (over: Record<string, unknown>) =>
  ({
    seq: 1,
    ts: '2026-09-07T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'hi' }] },
    actor,
    origin: 'principal',
    trust: 'trusted',
    ...over,
  }) as never

describe('migrate', () => {
  beforeEach(() => resetMigrations())
  it('is identity for current version and fills v', () => {
    expect(normalize(ev({}))).toMatchObject({ v: CURRENT_V })
    expect(supportedVersions()).toEqual({ min: 1, current: CURRENT_V })
  })
  it('throws on unknown type without ignorable, passes with ignorable', () => {
    expect(() => normalize(ev({ type: 'nope/x' }))).toThrow(/E_UNKNOWN_EVENT/)
    expect(normalize(ev({ type: 'nope/x', ignorable: true })).type).toBe('nope/x')
  })
  it('applies chained migrations and rejects gaps and duplicates', () => {
    registerMigration('user/message', 0, (d) => ({ ...(d as object), migrated0: true }))
    expect(() => registerMigration('user/message', 0, (d) => d)).toThrow(/duplicate/)
    const out = normalize(ev({ v: 0 }))
    expect(out.v).toBe(1)
    expect((out.data as { migrated0?: boolean }).migrated0).toBe(true)
    expect(() => normalize(ev({ v: 5 }))).toThrow(/E_UNSUPPORTED_VERSION/)
  })
})
