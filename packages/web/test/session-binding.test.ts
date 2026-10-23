import type { JsonRpcMessage, JsonRpcRequest, RpcEndpoint } from '@agnes/sdk'
import { createClient, localAuth, memoryJournal } from '@agnes/sdk'
import type { Session } from '@agnes/sdk/browser'
import { describe, expect, it, vi } from 'vitest'
import { SessionBindingOwner } from '../src/app/session-owner.js'
import { ComposerDrafts } from '../src/composer-drafts.js'
import { bindWebSession, loadWebSession } from '../src/session-binding.js'

type Handler = (request: JsonRpcRequest, push: (message: JsonRpcMessage) => void) => unknown

function endpointFor(handlers: Record<string, Handler>): {
  endpoint: RpcEndpoint
  calls: JsonRpcMessage[]
  push(message: JsonRpcMessage): void
} {
  const calls: JsonRpcMessage[] = []
  const queue: JsonRpcMessage[] = []
  let wake: (() => void) | undefined
  let closed = false
  const push = (message: JsonRpcMessage) => {
    queue.push(message)
    wake?.()
  }
  const endpoint: RpcEndpoint = {
    async handle(message) {
      calls.push(message)
      if (!('method' in message)) return
      const request = message as JsonRpcRequest
      const handler = handlers[request.method]
      if (!handler || request.id === undefined) return
      try {
        return { jsonrpc: '2.0', id: request.id, result: await handler(request, push) }
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'internal error',
            data: { code: 'INTERNAL_ERROR' },
          },
        }
      }
    },
    notifications: (async function* () {
      while (!closed) {
        const message = queue.shift()
        if (message) {
          yield message
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = undefined
      }
    })(),
    async close() {
      closed = true
      wake?.()
    },
  }
  return { endpoint, calls, push }
}

const request = {
  sessionId: 'web-load',
  toolCall: { toolCallId: 'tool-1', status: 'pending', title: 'Read a file' },
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
  ],
}

const initialize = () => ({
  protocolVersion: 1,
  agentCapabilities: { _meta: { 'ai.agnes.harness': { sessionOpen: true } } },
  _meta: { agnes: { agnesVersion: '0.0.0-test' } },
})

describe('Web session permission binding', () => {
  it.each(['load', 'open'] as const)('keeps a pending request alive through the %s handoff', async (mode) => {
    const progress = vi.fn()
    let loadReturned = false
    let resolvePermission: ((outcome: { optionId: string }) => void) | undefined
    const f = endpointFor({
      initialize,
      'session/new': () => ({ sessionId: 'created' }),
      [mode === 'load' ? 'session/load' : '_agnes/v1/session.open']: (_request, push) => {
        push({
          jsonrpc: '2.0',
          method: '_agnes/v1/session.loading',
          params: { sessionId: request.sessionId, phase: 'verifying', verifiedSeq: 1, lastSeq: 2 },
        })
        push({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: request })
        return {}
      },
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      auth: { kind: 'local' },
      authProviders: { local: () => localAuth() },
      journal: memoryJournal(),
    })

    try {
      await client.initialize()
      const bindingPromise = loadWebSession(
        client.session[mode],
        request.sessionId,
        async (_incoming, context) => {
          expect(loadReturned).toBe(false)
          return new Promise((resolve) => {
            resolvePermission = resolve
            context.signal.addEventListener('abort', () => resolve({ optionId: 'reject' }), { once: true })
          })
        },
        { onProgress: progress },
      )
      const binding = await bindingPromise
      loadReturned = true

      for (let i = 0; i < 20; i++) await Promise.resolve()

      expect(binding.session.id).toBe(request.sessionId)
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'verifying', verifiedSeq: 1, lastSeq: 2 }),
      )
      expect(resolvePermission).toBeDefined()
      resolvePermission?.({ optionId: 'allow' })
      for (let i = 0; i < 20; i++) await Promise.resolve()

      const sent = f.calls.find((message) => !('method' in message) && message.id === 'permission-1')
      expect(sent).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } })
    } finally {
      await client.close()
    }
  })

  it('lets a superseded load dispose a pending request after its response arrives', async () => {
    let releaseLoad!: () => void
    let permissionSeen!: () => void
    const seen = new Promise<void>((resolve) => {
      permissionSeen = resolve
    })
    const loadReleased = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const f = endpointFor({
      initialize,
      'session/load': async (_request, push) => {
        push({
          jsonrpc: '2.0',
          id: 'permission-before-release',
          method: 'session/request_permission',
          params: request,
        })
        await loadReleased
        return {}
      },
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      auth: { kind: 'local' },
      authProviders: { local: () => localAuth() },
      journal: memoryJournal(),
    })

    try {
      await client.initialize()
      const load = loadWebSession(client.session.load, request.sessionId, async () => {
        permissionSeen()
        return new Promise(() => {})
      })
      await seen
      releaseLoad()
      const binding = await load
      // This is the branch open() takes when selection changed while load was in flight.
      binding.offPermission?.()
      for (let i = 0; i < 20; i++) await Promise.resolve()

      const sent = f.calls.find(
        (message) => !('method' in message) && message.id === 'permission-before-release',
      )
      expect(sent).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    } finally {
      await client.close()
    }
  })

  it('retains the disposer for newly created sessions', async () => {
    const f = endpointFor({
      initialize,
      '_agnes/v1/workspace.add': () => ({
        workspace: {
          path: '/workspace',
          name: 'workspace',
          lastUsedAt: null,
          sessionCount: 0,
          available: true,
        },
      }),
      'session/new': () => ({ sessionId: 'created' }),
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      auth: { kind: 'local' },
      authProviders: { local: () => localAuth() },
      journal: memoryJournal(),
    })
    try {
      await client.initialize()
      const session = await client.session.new({ cwd: '/workspace' })
      const off = bindWebSession(session, async () => ({ optionId: 'allow' })).offPermission
      expect(off).toBeTypeOf('function')
      const sessionRequest = { ...request, sessionId: session.id }
      f.push({
        jsonrpc: '2.0',
        id: 'before-dispose',
        method: 'session/request_permission',
        params: sessionRequest,
      })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      const allowed = f.calls.find((message) => !('method' in message) && message.id === 'before-dispose')
      expect(allowed).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } })
      off?.()
      f.push({
        jsonrpc: '2.0',
        id: 'after-dispose',
        method: 'session/request_permission',
        params: sessionRequest,
      })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      const sent = f.calls.find((message) => !('method' in message) && message.id === 'after-dispose')
      expect(sent).toMatchObject({
        result: {
          outcome: { outcome: 'cancelled' },
          _meta: { 'ai.agnes.harness': { reason: 'no-handler' } },
        },
      })
    } finally {
      await client.close()
    }
  })

  it('does not leave the Web handler installed when load fails', async () => {
    const f = endpointFor({
      initialize,
      'session/load': () => {
        throw new Error('load failed')
      },
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      auth: { kind: 'local' },
      authProviders: { local: () => localAuth() },
      journal: memoryJournal(),
    })
    try {
      await client.initialize()
      await expect(
        loadWebSession(client.session.load, request.sessionId, async () => ({ optionId: 'allow' })),
      ).rejects.toThrow('load failed')
      f.push({
        jsonrpc: '2.0',
        id: 'after-failed-load',
        method: 'session/request_permission',
        params: request,
      })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      const sent = f.calls.find((message) => !('method' in message) && message.id === 'after-failed-load')
      expect(sent).toMatchObject({
        result: {
          outcome: { outcome: 'cancelled' },
          _meta: { 'ai.agnes.harness': { reason: 'no-handler' } },
        },
      })
    } finally {
      await client.close()
    }
  })
})

describe('selected session owner', () => {
  it('cancels stale opening waits and handlers, keeping the new selection independent', () => {
    const owner = new SessionBindingOwner()
    const a = owner.begin('a').binding
    const signal = owner.loadingSignal(a)
    const off = vi.fn()
    owner.loadingPermission(a, off)
    owner.begin('b')
    expect(signal.aborted).toBe(true)
    expect(off).toHaveBeenCalledOnce()
    expect(owner.targetId).toBe('b')
    expect(owner.loadingSignal(owner.capture()).aborted).toBe(false)
    const staleOff = vi.fn()
    owner.loadingPermission(a, staleOff)
    expect(staleOff).toHaveBeenCalledOnce()
  })

  it('keeps A→B→A drafts independent across sessions and profiles, even without browser storage', () => {
    const drafts = new ComposerDrafts(
      {
        getItem: () => {
          throw new Error('private mode')
        },
        setItem: () => {
          throw new Error('private mode')
        },
      },
      'http://synthetic',
    )
    expect(drafts.select('profile', 'a', '')).toBe('')
    expect(drafts.select('profile', 'b', 'draft A')).toBe('')
    expect(drafts.select('profile', 'a', 'draft B')).toBe('draft A')
    expect(drafts.select('other-profile', 'a', 'edited A')).toBe('')
    expect(drafts.select('profile', 'b', 'other profile draft')).toBe('draft B')
    expect(drafts.select('profile', 'a', 'edited B')).toBe('edited A')
  })
  it.each(['other-session', 'same-session'])('rejects late load and result after %s switch', async (id) => {
    const owner = new SessionBindingOwner()
    const first = owner.capture()
    const session = { id: 'same-session' } as Session
    const off = vi.fn()
    owner.attach(first, { session, offPermission: off })
    let finish!: (value: string) => void
    const result = new Promise<string>((resolve) => {
      finish = resolve
    })
    const apply = vi.fn()
    const work = result.then((value) => {
      if (owner.isCurrent(first, session)) apply(value)
    })
    const next = owner.begin()
    expect(next.previous.session).toBe(session)
    expect(off).toHaveBeenCalledOnce()
    const selected = { id } as Session
    owner.attach(next.binding, { session: selected })
    finish('obsolete result')
    await work
    expect(apply).not.toHaveBeenCalled()
    const staleOff = vi.fn()
    expect(owner.attach(first, { session, offPermission: staleOff })).toBe(false)
    expect(staleOff).toHaveBeenCalledOnce()
    expect(owner.session).toBe(selected)
    // An old cleanup cannot release the replacement binding.
    expect(owner.release(first)).toEqual({})
    expect(owner.session).toBe(selected)
  })
})
