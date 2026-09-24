import { isDateTime } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { Lease, leaseFor, ROW_BOUND_LEASE_TTL_MS } from '../../src/ext-host/lease.js'

const options = () => ({
  extId: 'agnes/test',
  expiresAt: '2099-01-01T00:00:00Z',
  scope: { events: true, slots: ['status.line'], toolPrefix: 'test_' },
  budget: 2,
  clock: () => 0,
})
const manifest = () => ({
  id: 'agnes/test',
  version: '1.0.0',
  apiRange: '^1.0',
  entry: './index.ts',
  capabilities: {},
})

describe('extension Lease', () => {
  it('does not charge registration but rejects both paths when execution budget is exhausted', () => {
    const lease = new Lease(options())
    lease.assertAlive('register')
    lease.assertAlive('register')
    expect(lease.view().budget.remaining).toBe(2)
    lease.consume()
    lease.consume()
    expect(lease.view().budget.remaining).toBe(0)
    expect(() => lease.assertAlive('register')).toThrow('E_LEASE_EXPIRED')
    expect(() => lease.assertAlive('execute')).toThrow('E_LEASE_EXPIRED')
    expect(() => lease.consume()).toThrow('E_LEASE_EXPIRED')
    expect(lease.view().budget.remaining).toBe(0)
    expect(lease.allows('event', 'x')).toBe(false)
  })

  it('enforces the exact expiry boundary with a live clock', () => {
    let now = 999
    const lease = new Lease({ ...options(), expiresAt: new Date(1000).toISOString(), clock: () => now })
    lease.assertAlive('execute')
    now = 1000
    expect(() => lease.consume()).toThrow('lease expired')
    expect(lease.allows('toolPrefix', 'test_read')).toBe(false)
  })

  it('uses the actual default clock path', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const { clock: _clock, ...rest } = options()
      const lease = new Lease({ ...rest, expiresAt: new Date(1001).toISOString() })
      lease.assertAlive('register')
      now.mockReturnValue(1001)
      expect(() => lease.assertAlive('register')).toThrow('lease expired')
    } finally {
      now.mockRestore()
    }
  })

  it('revokes irreversibly and does not include arbitrary revocation text in an error', () => {
    const lease = new Lease(options())
    lease.revoke('synthetic secret')
    lease.revoke('second')
    expect(lease.revoked).toBe('synthetic secret')
    expect(() => lease.consume()).toThrow('lease revoked')
    try {
      lease.consume()
    } catch (error) {
      expect(String(error)).not.toContain('synthetic secret')
    }
    expect(lease.allows('slot', 'status.line')).toBe(false)
  })

  it('takes an immutable scope snapshot and never exposes mutable remaining budget', () => {
    const input = options(),
      lease = new Lease(input)
    input.scope.slots.push('notification')
    input.scope.toolPrefix = ''
    const view = lease.view()
    expect(Reflect.set(view.scope, 'events', false)).toBe(false)
    expect(Reflect.set(view.budget, 'remaining', 999)).toBe(false)
    expect(Object.isFrozen(view.scope.slots)).toBe(true)
    expect(lease.allows('slot', 'notification')).toBe(false)
    expect(lease.allows('toolPrefix', 'elsewhere')).toBe(false)
    lease.consume()
    expect(view.budget.remaining).toBe(2)
    expect(lease.view().budget.remaining).toBe(1)
  })

  it('checks exact slots and prefixes without granting undeclared scopes', () => {
    const lease = new Lease(options())
    expect(lease.allows('slot', 'status.line')).toBe(true)
    expect(lease.allows('slot', 'status')).toBe(false)
    expect(lease.allows('toolPrefix', 'test_read')).toBe(true)
    expect(lease.allows('toolPrefix', 'other_read')).toBe(false)
    const empty = new Lease({ ...options(), scope: {} })
    expect(empty.allows('event', 'x')).toBe(false)
    expect(empty.allows('slot', 'status.line')).toBe(false)
    expect(empty.allows('toolPrefix', 'anything')).toBe(false)
  })

  it.each([NaN, -1, 0.5, -Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid budget %s', (budget) => {
    expect(() => new Lease({ ...options(), budget })).toThrow('invalid lease configuration')
  })

  it.each(['not a date', '2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T24:00:00Z'])(
    'rejects invalid expiry %s using the protocol date-time rule',
    (expiresAt) => {
      expect(isDateTime(expiresAt)).toBe(false)
      expect(() => new Lease({ ...options(), expiresAt })).toThrow('invalid lease configuration')
    },
  )

  it('accepts valid timezone-offset and leap-day timestamps', () => {
    for (const expiresAt of ['2028-02-29T00:00:00Z', '2099-01-01T08:00:00+08:00']) {
      expect(isDateTime(expiresAt)).toBe(true)
      expect(() => new Lease({ ...options(), expiresAt })).not.toThrow()
    }
  })

  it('fails closed if the clock becomes non-finite', () => {
    const lease = new Lease({ ...options(), clock: () => NaN })
    expect(() => lease.consume()).toThrow('lease expired')
    expect(lease.allows('event', 'x')).toBe(false)
  })

  it('refuses malformed scope without running accessors', () => {
    let reads = 0
    const scope = {
      get events() {
        reads++
        return true
      },
    }
    expect(() => new Lease({ ...options(), scope })).toThrow('invalid lease scope')
    expect(reads).toBe(0)
    for (const bad of [{ events: 'true' }, { slots: ['unknown'] }, { toolPrefix: 'BAD' }, { hidden: true }]) {
      expect(() => new Lease({ ...options(), scope: bad as never })).toThrow('invalid lease scope')
    }
  })

  it('derives default unbounded execution budget through the actual missing-manifest-field path', () => {
    const lease = leaseFor(manifest(), { now: 0, ttlMs: 1000, clock: () => 0 })
    for (let i = 0; i < 300; i++) lease.consume()
    expect(lease.view()).toEqual({
      expiresAt: new Date(1000).toISOString(),
      scope: {},
      budget: { remaining: Infinity },
    })
  })

  it('preserves explicit empty tool prefix and declared capabilities from the manifest', () => {
    const lease = leaseFor(
      {
        ...manifest(),
        capabilities: { tools: { prefix: '' }, events: false, slots: ['status.line'] },
        lease: { budget: 1 },
      },
      { now: 0, ttlMs: 1000, clock: () => 0 },
    )
    expect(lease.allows('toolPrefix', 'read')).toBe(true)
    expect(lease.allows('event', 'x')).toBe(false)
    expect(lease.allows('slot', 'status.line')).toBe(true)
    lease.consume()
    expect(() => lease.assertAlive('register')).toThrow('lease budget exhausted')
  })

  it.each([0, -1, NaN, Infinity, 0.5])('refuses invalid TTL %s', (ttlMs) => {
    expect(() => leaseFor(manifest(), { now: 0, ttlMs })).toThrow('invalid lease configuration')
  })

  it('accepts the row-bound TTL and puts the deadline past any process lifetime', () => {
    const now = Date.now()
    const lease = leaseFor(manifest(), { ttlMs: ROW_BOUND_LEASE_TTL_MS, now })
    const { expiresAt } = lease.view()
    expect(isDateTime(expiresAt)).toBe(true)
    expect(Date.parse(expiresAt)).toBeGreaterThan(now + 50 * 365 * 24 * 3600_000)
    lease.assertAlive('execute')
  })
})
