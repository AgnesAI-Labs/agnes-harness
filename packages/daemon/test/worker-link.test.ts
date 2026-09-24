import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { rpcError } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedSessionChannel } from '../../worker-runtime/src/shared-session-channel.js'
import { encodeFrame } from '../src/supervisor/framing.js'
import { WorkerLink } from '../src/supervisor/worker-link.js'

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = []

  write(chunk: Buffer): boolean {
    this.writes.push(chunk)
    return true
  }

  end(): this {
    return this
  }

  reply(requestId: string, value: { result?: unknown; error?: { code: string; message: string } }): void {
    this.emit('data', encodeFrame({ kind: 'reply', requestId, ...value }))
  }
}

function setup() {
  const socket = new FakeSocket()
  const link = new WorkerLink(socket as unknown as Socket, {
    onEvent() {},
    async onRequest() {},
  })
  return { link, socket }
}

afterEach(() => vi.useRealTimers())

describe('WorkerLink command settlement', () => {
  it('fails the process link on an unsafe hello generation', async () => {
    const { link, socket } = setup()
    socket.emit(
      'data',
      encodeFrame({
        kind: 'hello',
        token: 'token',
        workerKey: '@shared',
        workerGeneration: Number.MAX_SAFE_INTEGER + 1,
        profileHash: 'profile',
        workerKind: 'session',
      }),
    )
    await vi.waitFor(() => expect(link.alive).toBe(false))
  })

  it('rejects a reply carrying another session key', async () => {
    const { link, socket } = setup()
    const command = link.commandForSession('a', 'ping', {})
    socket.emit(
      'data',
      encodeFrame({ kind: 'reply', requestId: 's1', sessionKey: 'b', result: { ok: true } }),
    )
    await expect(command).rejects.toThrow('session mismatch')
    expect(link.alive).toBe(true)
  })

  it('routes logs by their frame session and rejects a session frame without a key', async () => {
    const socket = new FakeSocket()
    const logs: string[] = []
    const link = new WorkerLink(socket as unknown as Socket, {
      onEvent() {},
      async onRequest() {},
      onLog: (sessionKey, _level, message) => logs.push(`${sessionKey}:${message}`),
    })
    socket.emit(
      'data',
      Buffer.concat([
        encodeFrame({ kind: 'log', sessionKey: 'a', level: 'info', message: 'one' }),
        encodeFrame({ kind: 'log', sessionKey: 'b', level: 'info', message: 'two' }),
      ]),
    )
    await vi.waitFor(() => expect(logs).toEqual(['a:one', 'b:two']))
    socket.emit('data', encodeFrame({ kind: 'event', event: { seq: 1 } }))
    await vi.waitFor(() => expect(link.alive).toBe(false))
  })

  it('does not settle a later reply before an earlier event projection finishes', async () => {
    let release: (() => void) | undefined
    const projected = new Promise<void>((resolve) => {
      release = resolve
    })
    const socket = new FakeSocket()
    const link = new WorkerLink(socket as unknown as Socket, {
      onEvent: () => projected,
      async onRequest() {},
    })
    const command = link.commandForSession('session-a', 'ping', {}, { timeoutMs: 31_000 })
    let settled = false
    void command.then(() => {
      settled = true
    })
    socket.emit(
      'data',
      Buffer.concat([
        encodeFrame({
          kind: 'hello',
          token: 'token',
          workerKey: '@shared',
          workerGeneration: 1,
          profileHash: 'profile',
          workerKind: 'session',
        }),
        encodeFrame({ kind: 'event', sessionKey: 'session-a', event: { seq: 1 } }),
        encodeFrame({ kind: 'reply', sessionKey: 'session-a', requestId: 's1', result: { ok: true } }),
      ]),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    await expect(command).resolves.toEqual({ ok: true })
  })

  it('prevents a closed session channel from commanding a replacement with the same key', async () => {
    const { link, socket } = setup()
    const old = link.session('session-a', {
      binding: {
        version: 1,
        sessionKey: 'session-a',
        workspaceId: 'a'.repeat(64),
        revision: 1,
        canonicalRoot: '/workspace',
      },
    })
    socket.emit(
      'data',
      encodeFrame({
        kind: 'reply',
        sessionKey: 'session-a',
        requestId: 's1',
        result: { writerRunId: 'old', generation: 1 },
      }),
    )
    await old.hello
    const closing = old.closeSession()
    socket.emit(
      'data',
      encodeFrame({ kind: 'reply', sessionKey: 'session-a', requestId: 's2', result: undefined }),
    )
    await closing

    const replacement = link.session('session-a', {
      binding: {
        version: 1,
        sessionKey: 'session-a',
        workspaceId: 'a'.repeat(64),
        revision: 1,
        canonicalRoot: '/workspace',
      },
      resume: true,
    })
    socket.emit(
      'data',
      encodeFrame({
        kind: 'reply',
        sessionKey: 'session-a',
        requestId: 's3',
        result: { writerRunId: 'new', generation: 2 },
      }),
    )
    await replacement.hello
    const writesBeforeStaleCalls = socket.writes.length

    await expect(old.command('ping', {})).rejects.toThrow('worker session channel closed')
    await expect(old.tail(1)).rejects.toThrow('worker session channel closed')
    expect(socket.writes).toHaveLength(writesBeforeStaleCalls)
  })

  it('isolates a failed session projection without blocking another session', async () => {
    const socket = new FakeSocket()
    const order: number[] = []
    const onSessionFailure = vi.fn()
    const link = new WorkerLink(socket as unknown as Socket, {
      onEvent: async (sessionKey, event) => {
        order.push(event.seq)
        if (sessionKey === 'session-a') throw new Error('projection failed')
      },
      async onRequest() {},
      onSessionFailure,
    })
    socket.emit(
      'data',
      Buffer.concat([
        encodeFrame({
          kind: 'hello',
          token: 'token',
          workerKey: '@shared',
          workerGeneration: 1,
          profileHash: 'profile',
          workerKind: 'session',
        }),
        encodeFrame({ kind: 'event', sessionKey: 'session-a', event: { seq: 1 } }),
        encodeFrame({ kind: 'event', sessionKey: 'session-a', event: { seq: 2 } }),
        encodeFrame({ kind: 'event', sessionKey: 'session-b', event: { seq: 3 } }),
      ]),
    )
    await vi.waitFor(() => expect(onSessionFailure).toHaveBeenCalledOnce())
    expect(link.alive).toBe(true)
    expect(order).toEqual([1, 3])
  })

  it.each([
    ['result', { result: { ok: true } }],
    ['error', { error: { code: 'E_TEST', message: 'refused' } }],
  ] as const)('clears the command deadline after a %s reply', async (_kind, reply) => {
    vi.useFakeTimers()
    const { link, socket } = setup()
    const command = link.command('ping', {}, { timeoutMs: 31_000 })
    expect(vi.getTimerCount()).toBe(1)

    socket.reply('s1', reply)
    if ('error' in reply) await expect(command).rejects.toEqual(reply.error)
    else await expect(command).resolves.toEqual(reply.result)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears every pending deadline when the link closes', async () => {
    vi.useFakeTimers()
    const { link } = setup()
    const first = link.command('ping', {}, { timeoutMs: 31_000 })
    const second = link.command('ping', {}, { timeoutMs: 31_000 })
    expect(vi.getTimerCount()).toBe(2)

    link.close('test')
    await expect(first).rejects.toThrow('worker link closed')
    await expect(second).rejects.toThrow('worker link closed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('immediately notifies an exit observer registered after local close', () => {
    const { link } = setup()
    link.close('before observer registration')
    const exited = vi.fn()
    link.onExit(exited)
    expect(exited).toHaveBeenCalledOnce()
  })

  it('keeps timeout and late-reply settlement single-shot', async () => {
    vi.useFakeTimers()
    const { link, socket } = setup()
    const command = link.command('ping', {}, { timeoutMs: 10 })
    const rejection = expect(command).rejects.toThrow('worker command ping timed out')
    await vi.advanceTimersByTimeAsync(10)
    await rejection
    expect(vi.getTimerCount()).toBe(0)

    socket.reply('s1', { result: { late: true } })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('installation errors across worker frames', () => {
  it.each([
    [
      rpcError('CAPABILITY_DENIED', { code: 'SKILL_INSTALL_LOCAL_OWNER_REQUIRED', secret: 'private' }),
      'SKILL_INSTALL_LOCAL_OWNER_REQUIRED',
    ],
    [rpcError('INVALID_PARAMS', { secret: 'private' }), 'SKILL_INSTALL_INVALID'],
    [new Error('SKILL_READ_REJECTED'), 'SKILL_READ_REJECTED'],
    [new Error('private path and token'), 'SKILL_INSTALL_FAILED'],
  ])('preserves safe categories without arbitrary messages', async (failure, code) => {
    const socket = new FakeSocket()
    const link = new WorkerLink(socket as unknown as Socket, {
      onEvent() {},
      async onRequest() {
        throw failure
      },
    })
    const channel = new SharedSessionChannel((frame) => socket.emit('data', encodeFrame(frame)))
    const pending = channel.run('session', () =>
      channel.request('skill-install', {}, new AbortController().signal),
    )
    const rejected = expect(pending).rejects.toEqual({ code, message: code })
    await vi.waitFor(() => expect(socket.writes.length).toBe(1))
    const bytes = socket.writes[0]
    if (!bytes) throw new Error('missing reply')
    const reply = JSON.parse(bytes.toString())
    expect(JSON.stringify(reply)).not.toContain('private')
    channel.settle(reply)
    await rejected
    socket.emit('close')
    expect(link.alive).toBe(false)
  })
})

describe('WorkerLink preview frames', () => {
  it('hands a preview frame to onPreview after the events before it, without its kind or key', async () => {
    const socket = new FakeSocket()
    const order: string[] = []
    let releaseEvent!: () => void
    const eventDone = new Promise<void>((resolve) => {
      releaseEvent = resolve
    })
    new WorkerLink(socket as unknown as Socket, {
      onEvent: async () => {
        await eventDone
        order.push('event')
      },
      onPreview: (key, update) => order.push(`preview:${key}:${JSON.stringify(update)}`),
      async onRequest() {},
    })
    socket.emit('data', encodeFrame({ kind: 'event', sessionKey: 's', seq: 1, event: { seq: 1, type: 'x' } }))
    socket.emit(
      'data',
      encodeFrame({
        kind: 'preview',
        sessionKey: 's',
        lane: 'main',
        effectId: 'e1',
        stream: 'text',
        offset: 0,
        delta: 'hi',
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([])
    releaseEvent()
    await vi.waitFor(() => expect(order).toHaveLength(2))
    expect(order).toEqual([
      'event',
      'preview:s:{"lane":"main","effectId":"e1","stream":"text","offset":0,"delta":"hi"}',
    ])
  })

  it('closes the link on a preview frame without a session key', async () => {
    const { link, socket } = setup()
    socket.emit(
      'data',
      encodeFrame({ kind: 'preview', lane: 'main', effectId: 'e1', stream: 'text', offset: 0, delta: 'x' }),
    )
    await vi.waitFor(() => expect(link.alive).toBe(false))
  })
})
