import { describe, expect, it } from 'vitest'
import type { SessionReplyFrame } from '../src/frames.js'
import { SharedSessionChannel } from '../src/shared-session-channel.js'

describe('SharedSessionChannel', () => {
  it.each(['abort', 'close', 'closeAll'])('cancels a pending install prompt on %s', async (way) => {
    const sent: any[] = []
    const channel = new SharedSessionChannel((frame) => sent.push(frame))
    const controller = new AbortController()
    const request = channel.run('owner', () => channel.request('skill-install', {}, controller.signal))
    const rejected = expect(request).rejects.toBeDefined()
    if (way === 'abort') controller.abort()
    else if (way === 'close') channel.closeSession('owner')
    else channel.closeAll()
    await rejected
    expect(sent[1]).toMatchObject({
      sessionKey: 'owner',
      method: 'skill-install-abort',
      params: { requestId: sent[0].requestId },
    })
    expect(
      channel.settle({ kind: 'reply', sessionKey: 'owner', requestId: sent[0].requestId, result: {} }),
    ).toBe(false)
  })
  it.each(['abort', 'close', 'closeAll'])('cancels a pending plugin prompt on %s', async (way) => {
    const sent: any[] = []
    const channel = new SharedSessionChannel((frame) => sent.push(frame))
    const controller = new AbortController()
    const request = channel.run('owner', () => channel.request('plugin-manage', {}, controller.signal))
    const rejected = expect(request).rejects.toBeDefined()
    if (way === 'abort') controller.abort()
    else if (way === 'close') channel.closeSession('owner')
    else channel.closeAll()
    await rejected
    expect(sent[1]).toMatchObject({
      sessionKey: 'owner',
      method: 'plugin-manage-abort',
      params: { requestId: sent[0].requestId },
    })
    expect(
      channel.settle({ kind: 'reply', sessionKey: 'owner', requestId: sent[0].requestId, result: {} }),
    ).toBe(false)
  })
  it.each(['abort', 'deadline', 'close', 'closeAll'])(
    'withdraws a permission offer on %s and ignores late allow',
    async (way) => {
      const sent: any[] = []
      const channel = new SharedSessionChannel((frame) => sent.push(frame))
      const controller = new AbortController()
      const pending = channel.run('owner', () => channel.ask({} as never, { signal: controller.signal }))
      const result =
        way === 'abort'
          ? expect(pending).resolves.toEqual({ verdict: 'cancelled', reason: 'stopped' })
          : way === 'deadline'
            ? expect(pending).resolves.toEqual({ verdict: 'unavailable', reason: 'deadline' })
            : expect(pending).rejects.toBeDefined()
      if (way === 'abort') controller.abort()
      else if (way === 'deadline') controller.abort('deadline')
      else if (way === 'close') channel.closeSession('owner')
      else channel.closeAll()
      await result
      expect(sent[1]).toMatchObject({
        sessionKey: 'owner',
        method: 'permission-abort',
        params: { requestId: sent[0].requestId, reason: way === 'deadline' ? 'deadline' : 'stopped' },
      })
      expect(
        channel.settle({
          kind: 'reply',
          sessionKey: 'owner',
          requestId: sent[0].requestId,
          result: 'allowed-once',
        }),
      ).toBe(false)
    },
  )
  it('routes screenshot reads to their owning session and rejects a different session reply', async () => {
    const sent: Array<{ requestId: string; sessionKey: string; method: string }> = []
    const channel = new SharedSessionChannel((frame) => sent.push(frame as (typeof sent)[number]))
    const read = channel.run('image-owner', () =>
      channel.request(
        'artifact-media-read',
        { lane: 'main', nodeSeq: 21, sha256: 'a'.repeat(64) },
        new AbortController().signal,
      ),
    )
    expect(sent[0]).toMatchObject({ sessionKey: 'image-owner', method: 'artifact-media-read' })
    const requestId = sent[0]?.requestId ?? ''
    expect(() => channel.settle({ kind: 'reply', requestId, sessionKey: 'other', result: {} })).toThrow(
      'session mismatch',
    )
    channel.settle({ kind: 'reply', requestId, sessionKey: 'image-owner', result: { ok: true } })
    await expect(read).resolves.toEqual({ ok: true })
  })
  it('attributes overlapping approval requests and rejects a cross-session reply', async () => {
    const sent: Array<{ requestId: string; sessionKey: string }> = []
    const channel = new SharedSessionChannel((frame) => sent.push(frame as (typeof sent)[number]))
    const signal = new AbortController().signal
    const request = {} as never
    const a = channel.run('a', () => channel.ask(request, { signal }))
    const b = channel.run('b', () => channel.ask(request, { signal }))
    expect(sent.map(({ sessionKey }) => sessionKey)).toEqual(['a', 'b'])

    expect(() =>
      channel.settle({
        kind: 'reply',
        requestId: sent[0]?.requestId ?? '',
        sessionKey: 'b',
        result: 'allowed-once',
      } satisfies SessionReplyFrame),
    ).toThrow('session mismatch')
    channel.settle({
      kind: 'reply',
      requestId: sent[0]?.requestId ?? '',
      sessionKey: 'a',
      result: 'allowed-once',
    })
    channel.settle({
      kind: 'reply',
      requestId: sent[1]?.requestId ?? '',
      sessionKey: 'b',
      result: 'rejected',
    })
    await expect(a).resolves.toBe('allowed-once')
    await expect(b).resolves.toBe('rejected')
  })

  it('fails closed when a Host callback has no session context', () => {
    const channel = new SharedSessionChannel(() => undefined)
    expect(() => channel.currentSessionKey()).toThrow('no session context')
  })

  it('owns approval and notice requests in one session-scoped registry', async () => {
    const sent: Array<{ requestId: string; sessionKey: string; method: string }> = []
    const channel = new SharedSessionChannel((frame) => sent.push(frame as (typeof sent)[number]))
    const signal = new AbortController().signal
    const approval = channel.run('a', () => channel.ask({} as never, { signal }))
    const notice = channel.run('a', () => channel.request('notice', { message: 'a' }, signal))
    const other = channel.run('b', () => channel.request('notice', { message: 'b' }, signal))

    expect(sent.map(({ sessionKey, method }) => ({ sessionKey, method }))).toEqual([
      { sessionKey: 'a', method: 'permission' },
      { sessionKey: 'a', method: 'notice' },
      { sessionKey: 'b', method: 'notice' },
    ])
    channel.closeSession('a')
    await expect(approval).rejects.toThrow('session closed')
    await expect(notice).rejects.toThrow('session closed')

    const otherFrame = sent[2]
    expect(
      channel.settle({
        kind: 'reply',
        requestId: otherFrame?.requestId ?? '',
        sessionKey: 'b',
        result: 'ok',
      }),
    ).toBe(true)
    await expect(other).resolves.toBe('ok')
  })
})

it('stamps session policy outside tool params and persists automatic decision evidence before returning', async () => {
  const sent: unknown[] = []
  const evidence: unknown[] = []
  const context = {
    sessionKey: 's',
    sessionId: 'fixture-backend',
    epoch: 0,
    policy: 'full-access',
    actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  }
  const channel = new SharedSessionChannel((frame) => sent.push(frame), {
    context: () => context,
    record: async (_key, rows) => {
      evidence.push(...rows)
    },
  })
  const waiting = channel.run('s', () =>
    channel.request(
      'plugin-manage',
      { permissionContext: { policy: 'forged' } },
      new AbortController().signal,
    ),
  )
  expect(sent[0]).toMatchObject({
    permissionContext: context,
    params: { permissionContext: { policy: 'forged' } },
  })
  channel.settle({
    kind: 'reply',
    sessionKey: 's',
    requestId: 'w1',
    result: {
      value: 'published',
      __aghPermissionEvidence: [{ reason: 'full-access' }],
    },
  })
  expect(await waiting).toBe('published')
  expect(evidence).toEqual([{ reason: 'full-access' }])
  const failed = channel.run('s', () => channel.request('plugin-manage', {}, new AbortController().signal))
  channel.settle({
    kind: 'reply',
    sessionKey: 's',
    requestId: 'w2',
    error: { code: 'E_REQUEST', message: 'fixture' },
    permissionEvidence: [{ reason: 'full-access', failed: true }],
  })
  await expect(failed).rejects.toMatchObject({ code: 'E_REQUEST' })
  expect(evidence).toContainEqual({ reason: 'full-access', failed: true })
})

it('retains the revocation handshake after a background submission settles, until the session releases', async () => {
  const context = {
    sessionKey: 'owner',
    sessionId: 'instance',
    epoch: 0,
    policy: 'full-access',
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  }
  let revoke: (() => Promise<void>) | undefined
  const sent: Array<{ method: string; requestId: string }> = []
  const channel = new SharedSessionChannel(
    (raw) => {
      const frame = raw as { method: string; requestId: string }
      sent.push(frame)
      if (frame.method === 'permission-revoke')
        queueMicrotask(() =>
          channel.settle({ kind: 'reply', sessionKey: 'owner', requestId: frame.requestId, result: null }),
        )
    },
    {
      context: () => context,
      record: async () => undefined,
      beforeChange: (_key, listener) => {
        revoke = listener
        return () => {
          revoke = undefined
        }
      },
    },
  )
  const submitted = channel.run('owner', () =>
    channel.request('skill-install', {}, new AbortController().signal),
  )
  channel.settle({
    kind: 'reply',
    sessionKey: 'owner',
    requestId: sent[0]!.requestId,
    result: { state: 'submitted' },
  })
  expect(await submitted).toEqual({ state: 'submitted' })
  expect(channel.hasPending('owner')).toBe(false)
  if (!revoke) throw new Error('Missing revocation subscription')
  await revoke()
  expect(sent.at(-1)).toMatchObject({
    method: 'permission-revoke',
    params: { sessionId: 'instance', epoch: 0 },
  })
  channel.releaseSession('owner')
  expect(revoke).toBeUndefined()
  channel.closeAll()
})

it('rejects new authority requests immediately after worker transport closure', async () => {
  const channel = new SharedSessionChannel(() => {
    throw new Error('must not send')
  })
  channel.closeAll()
  await expect(
    channel.run('closed', () => channel.request('permission-revoke', {}, new AbortController().signal)),
  ).rejects.toThrow('worker channel closed')
})
