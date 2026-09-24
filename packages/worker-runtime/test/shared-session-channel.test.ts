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
