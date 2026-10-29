import type { StreamContext } from '@agnes/extension-api'
import type { StreamSocket } from '@agnes/plugin-streams'
import { createPluginStreamBroker, type StreamPrincipal } from '@agnes/plugin-streams'
import { encodePluginStreamBinary, type PluginStreamGrant, type StreamDeclaration } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

const encoder = new TextEncoder()
const json = (value: unknown) => encoder.encode(JSON.stringify(value))
const declaration: StreamDeclaration = {
  name: 'sample.media',
  scope: 'profile',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  directions: ['outbound'],
  lane: 'media',
  maxFrameBytes: 1048576,
  maxBufferedBytes: 2097152,
  maxBytesPerSecond: 4194304,
}
function principal(profileId = 'one', subject = 'user'): StreamPrincipal {
  return {
    profileId,
    subject,
    connectionId: 'login-one',
    actor: { id: subject, org: 'synthetic', role: 'user', deptPath: [], attrs: {} },
    source: 'web',
    signal: new AbortController().signal,
  }
}
function peer() {
  const sent: (string | Uint8Array)[] = [],
    closed: { code: number; reason: string }[] = []
  const socket: StreamSocket & { bufferedAmount: number } = {
    bufferedAmount: 0,
    send(data, done) {
      sent.push(data)
      done()
    },
    close(code, reason) {
      closed.push({ code, reason })
    },
  }
  return { socket, sent, closed }
}
function fixture(d = declaration) {
  let now = 1000
  let tick = 1000
  let current = true
  let context: StreamContext | undefined
  const registrationAbort = new AbortController(),
    admissionAbort = new AbortController()
  const broker = createPluginStreamBroker({
    now: () => now,
    monotonicNow: () => tick,
    async authorize(p, req, registration) {
      if (
        req.owner !== 'sample/plugin' ||
        req.scope.profileId !== p.profileId ||
        registration.activationId !== 'active' ||
        !current
      )
        throw new Error('refused')
      return {
        signal: admissionAbort.signal,
        assertCurrent() {
          if (!current) throw new Error('revoked')
        },
        ...(registration.declaration.lane === 'control'
          ? { control: { grantId: 'approved-one', expiresAt: now + 30000 } }
          : {}),
      }
    },
  })
  const unregister = broker.register({
    owner: 'sample/plugin',
    profileId: 'one',
    activationId: 'active',
    declaration: d,
    signal: registrationAbort.signal,
    validateInput: (input) => JSON.stringify(input) === '{}',
    handler(_input, ctx) {
      context = ctx
    },
  })
  const actor = principal()
  const request = {
    owner: 'sample/plugin',
    name: d.name,
    scope: { kind: 'profile', profileId: 'one' },
    input: {},
  }
  const hello = (grant: PluginStreamGrant, p = actor) => {
    const remote = peer()
    const connection = broker.connect(p, remote.socket)
    connection.receive(json({ ticket: grant.ticket }), false)
    return {
      ...remote,
      connection,
      get context() {
        if (!context) throw new Error('handler was not admitted')
        return context
      },
    }
  }
  return {
    broker,
    actor,
    request,
    hello,
    registrationAbort,
    admissionAbort,
    unregister,
    get observedContext() {
      return context
    },
    advance(ms: number) {
      now += ms
      tick += Math.max(0, ms)
    },
    rollback(ms: number) {
      now -= ms
    },
    advanceTick(ms: number) {
      tick += ms
    },
    revoke() {
      current = false
    },
  }
}
afterEach(() => vi.useRealTimers())
describe('authenticated stream broker', () => {
  it('admits a reviewed profile producer without motion authority and bounds/revokes its data lane', async () => {
    const f = fixture({ ...declaration, directions: ['inbound', 'outbound'], producer: true })
    try {
      const grant = await f.broker.open(f.actor, f.request)
      expect(grant).toMatchObject({ producer: true, lane: 'media', maxFrameBytes: declaration.maxFrameBytes })
      const p = f.hello(grant)
      expect(p.context.control).toBeUndefined()
      const frames: unknown[] = []
      p.context.stream.onFrame((frame) => frames.push(frame))
      for (let i = 0; i < 40; i++)
        p.connection.receive(encodePluginStreamBinary(grant.streamId, i, new Uint8Array([i])), true)
      expect(frames).toHaveLength(40)
      f.revoke()
      p.connection.receive(encodePluginStreamBinary(grant.streamId, 40, new Uint8Array([40])), true)
      expect(frames).toHaveLength(40)
      expect(p.closed[0]?.reason).toBe('revoked')
    } finally {
      f.broker.close()
    }
  })
  it('atomically consumes tickets, binds subject/connection/profile and refuses expired or replaced owners', async () => {
    const f = fixture()
    for (const other of [
      principal('two'),
      principal('one', 'other'),
      { ...f.actor, connectionId: 'other-login' },
    ]) {
      const ticket = await f.broker.open(f.actor, f.request)
      const refused = f.hello(ticket, other)
      expect(refused.closed).toEqual([{ code: 1008, reason: 'revoked' }])
      expect(f.hello(ticket).closed).toEqual([{ code: 1008, reason: 'revoked' }])
    }
    const expired = await f.broker.open(f.actor, f.request)
    f.advance(10000)
    expect(f.hello(expired).closed[0]?.reason).toBe('revoked')
    const valid = await f.broker.open(f.actor, f.request)
    const admitted = f.hello(valid)
    expect(admitted.sent[0]).toContain('"ready":true')
    expect(f.hello(valid).closed[0]?.reason).toBe('revoked')
    const rollback = await f.broker.open(f.actor, f.request)
    f.advance(9000)
    f.rollback(8000)
    f.advanceTick(2000)
    expect(f.hello(rollback).closed[0]?.reason).toBe('revoked')
    const pending = await f.broker.open(f.actor, f.request)
    f.unregister()
    expect(admitted.closed[0]?.reason).toBe('revoked')
    expect(f.hello(pending).closed[0]?.reason).toBe('revoked')
    f.broker.close()
  })
  it('refuses undeclared scope, input, owner and control without an effect lease', async () => {
    const f = fixture()
    for (const patch of [
      { owner: 'other/plugin' },
      { input: { url: 'http://external.invalid' } },
      { scope: { kind: 'profile', profileId: 'two' } },
      { upstreamUrl: 'http://external.invalid' },
    ])
      await expect(f.broker.open(f.actor, { ...f.request, ...patch })).rejects.toThrow()
    const control = {
      ...declaration,
      name: 'sample.control',
      lane: 'control' as const,
      directions: ['inbound'] as 'inbound'[],
      controlService: 'sample.effect',
      maxFrameBytes: 4096,
      maxBufferedBytes: 32768,
      maxBytesPerSecond: 122880,
    }
    const broker = createPluginStreamBroker({
      async authorize() {
        return { signal: new AbortController().signal, assertCurrent() {} }
      },
    })
    broker.register({
      owner: 'sample/plugin',
      profileId: 'one',
      activationId: 'active',
      declaration: control,
      signal: new AbortController().signal,
      validateInput: () => true,
      handler: () => {},
    })
    await expect(broker.open(f.actor, { ...f.request, name: control.name })).rejects.toThrow()
    broker.close()
    const grant = await f.broker.open(f.actor, f.request)
    const failed = peer()
    failed.socket.send = (_data, done) => done(new Error('closed transport'))
    const connection = f.broker.connect(f.actor, failed.socket)
    connection.receive(json({ ticket: grant.ticket }), false)
    expect(f.observedContext).toBeUndefined()
    expect(failed.closed[0]).toEqual({ code: 1011, reason: 'unavailable' })
    f.broker.close()
  })
  it('keeps media bounded and independent of control; reliable events request reopen', async () => {
    const f = fixture()
    const media = f.hello(await f.broker.open(f.actor, f.request))
    let drops = 0
    media.context.stream.onDrop(({ count }) => {
      drops += count
    })
    media.socket.bufferedAmount = 2097152
    for (let i = 0; i < 100; i++) expect(media.context.stream.send(new Uint8Array(32))).toBe('dropped')
    expect(drops).toBe(100)
    expect(media.sent).toHaveLength(1)
    let controlContext: StreamContext | undefined
    f.broker.register({
      owner: 'sample/plugin',
      profileId: 'one',
      activationId: 'active',
      signal: f.registrationAbort.signal,
      declaration: {
        ...declaration,
        name: 'sample.control',
        lane: 'control',
        directions: ['inbound', 'outbound'],
        controlService: 'sample.effect',
        maxFrameBytes: 4096,
        maxBufferedBytes: 32768,
        maxBytesPerSecond: 122880,
      },
      validateInput: () => true,
      handler(_input, ctx) {
        controlContext = ctx
      },
    })
    const grant = await f.broker.open(f.actor, { ...f.request, name: 'sample.control' })
    const control = peer(),
      connection = f.broker.connect(f.actor, control.socket)
    connection.receive(json({ ticket: grant.ticket }), false)
    if (!controlContext) throw new Error('control was not admitted')
    expect(controlContext.stream.send({ stop: true })).toBe('accepted')
    control.socket.bufferedAmount = 32768
    expect(controlContext.stream.send({ stop: true })).toBe('closed')
    expect(control.closed[0]).toEqual({ code: 1013, reason: 'overloaded' })
    media.socket.bufferedAmount = 0
    expect(media.context.stream.send(new Uint8Array(32))).toBe('accepted')
    const e = fixture({ ...declaration, lane: 'events' })
    const events = e.hello(await e.broker.open(e.actor, e.request))
    events.socket.bufferedAmount = 2097152
    expect(events.context.stream.send({ cursor: 'last' })).toBe('closed')
    expect(events.closed[0]).toEqual({ code: 1013, reason: 'reopen' })
    f.broker.close()
    e.broker.close()
  })
  it('rejects replayed, foreign, oversized and flooded frames and disconnects/aborts exactly once', async () => {
    const control = {
      ...declaration,
      name: 'sample.control',
      lane: 'control' as const,
      directions: ['inbound', 'outbound'] as ('inbound' | 'outbound')[],
      controlService: 'sample.effect',
      maxFrameBytes: 4096,
      maxBufferedBytes: 32768,
      maxBytesPerSecond: 122880,
    }
    for (const invalid of ['replay', 'foreign', 'oversize', 'flood', 'revoke', 'abort', 'unregister']) {
      const f = fixture(control),
        grant = await f.broker.open(f.actor, f.request),
        remote = f.hello(grant)
      const frames: unknown[] = []
      let disconnects = 0
      remote.context.stream.onFrame((frame) => frames.push(frame))
      const off = remote.context.stream.onDisconnect(() => {
        disconnects++
      })
      remote.context.signal.addEventListener('abort', off, { once: true })
      const frame = encodePluginStreamBinary(grant.streamId, 0, new Uint8Array([4]))
      remote.connection.receive(frame, true)
      expect(frames).toEqual([new Uint8Array([4])])
      if (invalid === 'replay') remote.connection.receive(frame, true)
      if (invalid === 'foreign')
        remote.connection.receive(encodePluginStreamBinary(grant.streamId + 1, 1, new Uint8Array()), true)
      if (invalid === 'oversize') remote.connection.receive(new Uint8Array(4097), true)
      if (invalid === 'flood')
        for (let i = 1; i < 32; i++)
          remote.connection.receive(encodePluginStreamBinary(grant.streamId, i, new Uint8Array()), true)
      if (invalid === 'revoke') {
        f.revoke()
        expect(remote.context.stream.send({})).toBe('closed')
      }
      if (invalid === 'abort') f.admissionAbort.abort()
      if (invalid === 'unregister') f.unregister()
      remote.connection.disconnect()
      f.broker.close()
      await Promise.resolve()
      await Promise.resolve()
      expect(disconnects).toBe(1)
      expect(remote.context.signal.aborted).toBe(true)
      expect(remote.closed).toHaveLength(1)
    }
  })
  it('bounds opens and sockets and expires silent hello/control leases with fake clocks', async () => {
    vi.useFakeTimers()
    const f = fixture()
    for (let i = 0; i < 10; i++) await f.broker.open(f.actor, f.request)
    await expect(f.broker.open(f.actor, f.request)).rejects.toThrow('OVERLOADED')
    const peers = []
    for (let i = 0; i < 8; i++) {
      const p = peer()
      f.broker.connect(f.actor, p.socket)
      peers.push(p)
    }
    const extra = peer()
    expect(() => f.broker.connect(f.actor, extra.socket)).toThrow('OVERLOADED')
    await vi.advanceTimersByTimeAsync(5000)
    expect(peers.every((p) => p.closed[0]?.reason === 'expired')).toBe(true)
    f.broker.close()
  })
})
