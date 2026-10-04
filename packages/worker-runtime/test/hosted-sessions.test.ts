import type { Host, HostSession } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import type { SessionCommandFrame, SessionOpenFrame } from '../src/frames.js'
import { HostedSessions } from '../src/hosted-sessions.js'
import { SharedSessionChannel } from '../src/shared-session-channel.js'

function open(sessionKey: string): SessionOpenFrame {
  return {
    kind: 'session.open',
    requestId: `open:${sessionKey}`,
    sessionKey,
    params: {
      binding: {
        version: 1,
        sessionKey,
        workspaceId: 'a'.repeat(64),
        revision: 1,
        canonicalRoot: '/workspace',
      },
    },
  }
}

function command(
  sessionKey: string,
  method: SessionCommandFrame['method'],
  params = {},
): SessionCommandFrame {
  return { kind: 'command', requestId: `${sessionKey}:${method}`, sessionKey, method, params }
}

describe('HostedSessions', () => {
  const acceptWorkspaceBinding = (envelope: unknown) => envelope as never

  it('keeps two sessions independent when one is aborted and closed', async () => {
    const closes: string[] = []
    const runResolvers = new Map<string, () => void>()
    const sessions = new Map<string, HostSession>()
    const createSession = vi.fn(async ({ key }: { key: string }) => {
      const session = {
        key,
        writerRunId: `writer:${key}`,
        lastSeq: 0,
        preset: { name: 'default' },
        d: { log: {} },
        latest: () => null,
        async run({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((resolve) => {
            runResolvers.set(key, resolve)
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return { reason: signal.aborted ? 'aborted' : 'idle', lastSeq: 0 }
        },
        async close() {
          closes.push(key)
        },
      } as unknown as HostSession
      sessions.set(key, session)
      return session
    })
    const kernelSessions = new Map<string, unknown>()
    const host = {
      acceptWorkspaceBinding,
      createSession,
      kernel: { sessions: kernelSessions },
    } as unknown as Host
    const channel = new SharedSessionChannel(() => undefined)
    const hosted = new HostedSessions({
      host,
      channel,
      send: () => undefined,
      workerGeneration: 1,
      workspaceRoot: '/workspace',
    })

    await Promise.all([hosted.open(open('a')), hosted.open(open('b'))])
    expect(createSession).toHaveBeenCalledTimes(2)
    const runA = hosted.dispatch(command('a', 'run', { runId: 'same', until: 'idle' }))
    const runB = hosted.dispatch(command('b', 'run', { runId: 'same', until: 'idle' }))
    await vi.waitFor(() => expect(runResolvers.size).toBe(2))
    await hosted.dispatch(command('a', 'abort', { runId: 'same' }))
    await expect(runA).resolves.toMatchObject({ reason: 'aborted' })
    expect(runResolvers.has('b')).toBe(true)
    runResolvers.get('b')?.()
    await expect(runB).resolves.toMatchObject({ reason: 'idle' })

    await hosted.close('a')
    expect(closes).toEqual(['a'])
    await expect(hosted.dispatch(command('b', 'ping'))).resolves.toMatchObject({ ok: true })
    expect(hosted.keys()).toEqual(['b'])
    const sessionScoped = vi.fn(() => 'called')
    await expect(hosted.withSession('a', 'callService', sessionScoped)).rejects.toThrow(/closing/)
    expect(sessionScoped).not.toHaveBeenCalled()
    await expect(hosted.withSession('never-owned', 'callService', sessionScoped)).resolves.toBe('called')
  })

  it('rejects a binding for another session before creating a session', async () => {
    const createSession = vi.fn()
    const hosted = new HostedSessions({
      host: { createSession } as unknown as Host,
      channel: new SharedSessionChannel(() => undefined),
      send: () => undefined,
      workerGeneration: 1,
      workspaceRoot: '/workspace',
    })
    await expect(hosted.open({ ...open('other'), sessionKey: 'a' })).rejects.toThrow(
      'invalid workspace binding',
    )
    expect(createSession).not.toHaveBeenCalled()
  })

  it('waits for an in-flight open before closing the same session', async () => {
    let release: ((session: HostSession) => void) | undefined
    const created = new Promise<HostSession>((resolve) => {
      release = resolve
    })
    const close = vi.fn(async () => undefined)
    const hosted = new HostedSessions({
      host: {
        acceptWorkspaceBinding,
        createSession: vi.fn(() => created),
        kernel: { sessions: new Map() },
      } as unknown as Host,
      channel: new SharedSessionChannel(() => undefined),
      send: () => undefined,
      workerGeneration: 1,
      workspaceRoot: '/workspace',
    })
    const opening = hosted.open(open('a'))
    const closing = hosted.close('a')
    release?.({
      key: 'a',
      writerRunId: 'writer:a',
      lastSeq: 0,
      latest: () => null,
      close,
    } as unknown as HostSession)

    await expect(opening).rejects.toThrow('closed while opening')
    await closing
    expect(close).toHaveBeenCalledOnce()
    expect(hosted.keys()).toEqual([])
  })

  it('retains the failed owner and refuses reopening after close fails', async () => {
    const kernelSessions = new Map<string, unknown>()
    let attempt = 0
    const createSession = vi.fn(async ({ key }: { key: string }) => {
      attempt++
      const session = {
        key,
        writerRunId: `writer:${attempt}`,
        lastSeq: 0,
        preset: { name: 'default' },
        d: { log: {} },
        latest: () => null,
        close: attempt === 1 ? vi.fn(async () => Promise.reject(new Error('close failed'))) : vi.fn(),
      } as unknown as HostSession
      kernelSessions.set(key, session)
      return session
    })
    const hosted = new HostedSessions({
      host: {
        acceptWorkspaceBinding,
        createSession,
        kernel: { sessions: kernelSessions },
      } as unknown as Host,
      channel: new SharedSessionChannel(() => undefined),
      send: () => undefined,
      workerGeneration: 1,
      workspaceRoot: '/workspace',
    })

    await hosted.open(open('a'))
    await expect(hosted.close('a')).rejects.toThrow('close failed')
    expect(kernelSessions.has('a')).toBe(true)
    const owner = { sessionKey: 'a', writerRunId: 'writer:1', generation: 1, workerGeneration: 1 }
    await expect(hosted.closeAndConfirm('a', owner)).resolves.toEqual({
      exited: false,
      reason: 'close-failed',
      owner,
    })
    await expect(hosted.close('a')).rejects.toThrow('close failed')
    await expect(hosted.open(open('a'))).rejects.toThrow('close failed')
    expect(hosted.keys()).toEqual([])
    expect(createSession).toHaveBeenCalledOnce()
    const retained = kernelSessions.get('a') as HostSession
    const retry = vi.fn(async () => undefined)
    retained.close = retry
    await expect(
      hosted.closeAndConfirm('a', { ...owner, writerRunId: 'replacement' }),
    ).resolves.toMatchObject({ exited: false, reason: 'generation-mismatch' })
    expect(retry).not.toHaveBeenCalled()
    await expect(hosted.closeAndConfirm('a', owner)).resolves.toEqual({ exited: true, owner })
    expect(retry).toHaveBeenCalledOnce()
    expect(kernelSessions.has('a')).toBe(false)
    expect(createSession).toHaveBeenCalledOnce()
    await hosted.open(open('a'))
    await expect(hosted.closeAndConfirm('a', owner)).resolves.toMatchObject({
      exited: false,
      reason: 'generation-mismatch',
    })
    expect(hosted.keys()).toEqual(['a'])
    await hosted.closeAll()
  })
  it('confirms only the exact owner after its running command has drained', async () => {
    let finishRun: (() => void) | undefined
    const session = {
      key: 'a',
      writerRunId: 'writer:a',
      lastSeq: 0,
      latest: () => null,
      close: vi.fn(async () => undefined),
      run: async () =>
        new Promise((resolve) => {
          finishRun = () => resolve({ reason: 'aborted', lastSeq: 0 })
        }),
    } as unknown as HostSession
    const hosted = new HostedSessions({
      host: {
        acceptWorkspaceBinding,
        createSession: async () => session,
        kernel: { sessions: new Map([['a', session]]) },
      } as unknown as Host,
      channel: new SharedSessionChannel(() => undefined),
      send: () => undefined,
      workerGeneration: 2,
      workspaceRoot: '/workspace',
    })
    await hosted.open(open('a'))
    const owner = { sessionKey: 'a', writerRunId: 'writer:a', generation: 1, workerGeneration: 2 }
    await expect(hosted.closeAndConfirm('a', { ...owner, workerGeneration: 1 })).resolves.toMatchObject({
      exited: false,
      reason: 'generation-mismatch',
    })
    expect(hosted.keys()).toEqual(['a'])
    const running = hosted.dispatch(command('a', 'run', { runId: 'run' }))
    await vi.waitFor(() => expect(finishRun).toBeDefined())
    const confirmation = hosted.closeAndConfirm('a', owner)
    let confirmed = false
    void confirmation.then(() => {
      confirmed = true
    })
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledOnce())
    expect(confirmed).toBe(false)
    expect(hosted.keys()).toEqual([])
    finishRun?.()
    await running
    await expect(confirmation).resolves.toEqual({ exited: true, owner })
    await expect(hosted.closeAndConfirm('a', owner)).resolves.toEqual({ exited: true, owner })
    await expect(hosted.closeAndConfirm('missing', owner)).resolves.toMatchObject({ exited: false })
  })
})
