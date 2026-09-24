import { describe, expect, it } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { NoticeSink } from '../src/local/notice.js'

describe('NoticeSink', () => {
  it('routes by attachment and broadcasts shutting_down', () => {
    const a = new LocalEndpoint({ clock: () => 0, principalId: 'a' })
    const b = new LocalEndpoint({ clock: () => 0, principalId: 'b' })
    a.conn.attached.set('k1', {
      cursor: { fromSeq: 1, generation: 1 },
      filter: { preview: false, acpUpdates: false },
    })
    const audit: unknown[] = []
    const sink = new NoticeSink({
      endpoints: () => [
        { ep: a, conn: a.conn },
        { ep: b, conn: b.conn },
      ],
      audit: (r) => audit.push(r),
      clock: () => 42,
    })
    sink.emit('resumed', { sessionId: 'k1', detail: { lastStep: 4 } })
    sink.emit('shutting_down', { detail: {} })
    // a is attached to k1: gets the resumed notice plus the broadcast shutting_down notice.
    expect(a.pending().events).toBe(2)
    // b is attached to nothing: skipped for resumed, still reached by the shutting_down broadcast.
    expect(b.pending().events).toBe(1)
    expect(audit).toHaveLength(2)
    // The audit record's own 'daemon.notice' tag must survive: params carries its own `kind` (e.g.
    // 'resumed'), so a flat spread would silently overwrite the outer tag with the inner one.
    expect(audit[0]).toMatchObject({ kind: 'daemon.notice', notice: { kind: 'resumed', sessionId: 'k1' } })
  })

  it('broadcasts packages_changed to every authorized connection in its profile without attachment', () => {
    const first = new LocalEndpoint({ clock: () => 0, principalId: 'first', profile: 'p1' })
    const second = new LocalEndpoint({ clock: () => 0, principalId: 'second', profile: 'p1' })
    const otherProfile = new LocalEndpoint({ clock: () => 0, principalId: 'other', profile: 'p2' })
    for (const ep of [first, second, otherProfile]) {
      ep.conn.initialized = true
      ep.conn.authKind = 'local'
      ep.conn.clientModuleNotices = true
    }
    const sink = new NoticeSink({
      endpoints: () =>
        [first, second, otherProfile].map((ep) => ({
          ep,
          conn: ep.conn,
        })),
      clock: () => 42,
    })

    sink.emit('packages_changed', {
      detail: { profile: 'p1', revision: 'rev-2', reason: 'activation', packageId: '@agnes/example' },
    })

    expect(first.pending().events).toBe(1)
    expect(second.pending().events).toBe(1)
    expect(otherProfile.pending().events).toBe(0)
  })

  it('broadcasts tree_changed with profile, target digest and identity without attachment', () => {
    const first = new LocalEndpoint({ clock: () => 0, principalId: 'first', profile: 'p1' })
    first.conn.initialized = true
    first.conn.authKind = 'local'
    first.conn.clientModuleNotices = true
    const sink = new NoticeSink({
      endpoints: () => [{ ep: first, conn: first.conn }],
      clock: () => 42,
    })
    const identity = {
      treeHash: 'a'.repeat(64),
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
    }
    sink.emit('tree_changed', {
      detail: {
        profile: 'p1',
        targetDigest: `sha256-${'d'.repeat(64)}`,
        identity,
        hash: `sha256-${'d'.repeat(64)}`,
      },
    })
    expect(first.pending().events).toBe(1)
  })

  it('does not send packages_changed to uninitialized or unverified connections', () => {
    const authorized = new LocalEndpoint({ clock: () => 0, principalId: 'authorized', profile: 'p1' })
    authorized.conn.initialized = true
    authorized.conn.authKind = 'local'
    authorized.conn.clientModuleNotices = true
    const uninitialized = new LocalEndpoint({ clock: () => 0, principalId: 'uninitialized', profile: 'p1' })
    uninitialized.conn.authKind = 'local'
    uninitialized.conn.clientModuleNotices = true
    const unverified = new LocalEndpoint({ clock: () => 0, principalId: 'unverified', profile: 'p1' })
    unverified.conn.initialized = true
    unverified.conn.clientModuleNotices = true
    const sink = new NoticeSink({
      endpoints: () =>
        [authorized, uninitialized, unverified].map((ep) => ({
          ep,
          conn: ep.conn,
        })),
      clock: () => 42,
    })

    sink.emit('packages_changed', {
      detail: { profile: 'p1', revision: 'rev-3', reason: 'inventory' },
    })

    expect(authorized.pending().events).toBe(1)
    expect(uninitialized.pending().events).toBe(0)
    expect(unverified.pending().events).toBe(0)
  })

  it('does not infer client-module notice authority from transport authentication alone', () => {
    const authenticated = new LocalEndpoint({ clock: () => 0, principalId: 'unix', profile: 'p1' })
    authenticated.conn.initialized = true
    authenticated.conn.authKind = 'local'
    const sink = new NoticeSink({
      endpoints: () => [{ ep: authenticated, conn: authenticated.conn }],
      clock: () => 42,
    })
    sink.emit('packages_changed', {
      detail: { profile: 'p1', revision: 'rev-4', reason: 'inventory' },
    })
    expect(authenticated.pending().events).toBe(0)
  })

  it('preserves session routing when packages_changed support is present', () => {
    const attached = new LocalEndpoint({ clock: () => 0, principalId: 'attached', profile: 'p1' })
    const idle = new LocalEndpoint({ clock: () => 0, principalId: 'idle', profile: 'p1' })
    attached.conn.attached.set('session', {
      cursor: { fromSeq: 1, generation: 1 },
      filter: { preview: false, acpUpdates: false },
    })
    const sink = new NoticeSink({
      endpoints: () => [attached, idle].map((ep) => ({ ep, conn: ep.conn })),
      clock: () => 42,
    })

    sink.emit('resumed', { sessionId: 'session', detail: { lastStep: 4 } })

    expect(attached.pending().events).toBe(1)
    expect(idle.pending().events).toBe(0)
  })
})
