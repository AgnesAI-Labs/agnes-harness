import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
const rollback = vi.hoisted(() => vi.fn())
const save = vi.hoisted(() => vi.fn())
vi.mock('@agnes/host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/host')>()),
  requestRefinement: request,
  rollbackRefinement: rollback,
  saveEntryToWorkspace: save,
}))
const { registerSessionRefine } = await import('../src/local/methods/refinement.js')

type Handler = (params: unknown, c: CallContext) => Promise<unknown>
const LOCAL = { authKind: 'local', credentialKind: 'local' }

function setup(sessions: Record<string, object>, method = '_agnes/v1/session.refine') {
  const handlers = new Map<string, Handler>()
  const ep = { register: (name: string, fn: Handler) => handlers.set(name, fn) }
  const owner = vi.fn((_m: string, id: string) => {
    if (id === 'foreign') throw rpcError('CAPABILITY_DENIED', {})
  })
  registerSessionRefine(
    ep as never,
    { registry: { get: (id) => (sessions[id] ? ({ session: sessions[id] } as never) : undefined) } },
    owner,
  )
  const call = (params: unknown, conn: object = LOCAL) =>
    (handlers.get(method) as Handler)(params, { signal: new AbortController().signal, conn } as CallContext)
  return { call, owner }
}

describe('_agnes/v1/session.refine', () => {
  it('refuses a non-owner and an unknown session before anything is queued', async () => {
    const { call, owner } = setup({ foreign: {} })
    await expect(call({ sessionId: 'foreign' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(call({ sessionId: 'gone' })).rejects.toMatchObject({ data: { code: 'SESSION_NOT_FOUND' } })
    expect(owner).toHaveBeenCalledWith('session.refine', 'gone', expect.anything())
    expect(request).not.toHaveBeenCalled()
  })

  it('queues on the session this process holds, or asks the worker that holds it', async () => {
    const local = {}
    const remote = { refine: vi.fn(async () => ({ runId: 'from-worker' })) }
    const { call } = setup({ local, remote })
    request.mockResolvedValueOnce({ runId: 'here' })
    await expect(call({ sessionId: 'local', focus: 'tests' })).resolves.toEqual({ runId: 'here' })
    expect(request).toHaveBeenCalledWith(local, 'tests', undefined, undefined)
    await expect(call({ sessionId: 'remote' })).resolves.toEqual({ runId: 'from-worker' })
    expect(remote.refine).toHaveBeenCalledWith(undefined, undefined, undefined)
  })

  it('/refine --workspace saves as the user, so only the owner on a local connection may ask for it', async () => {
    const local = {}
    const remote = { refine: vi.fn(async () => ({ runId: 'from-worker' })) }
    const { call } = setup({ local, remote })
    request.mockClear()
    for (const conn of [
      { authKind: 'token', credentialKind: 'local' },
      { authKind: 'local', credentialKind: 'token' },
    ])
      await expect(call({ sessionId: 'local', saveTo: 'workspace' }, conn)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
    expect(request).not.toHaveBeenCalled()
    // Without saveTo a remote owner may still ask for a review, as before.
    request.mockResolvedValueOnce({ runId: 'plain' })
    await expect(
      call({ sessionId: 'local' }, { authKind: 'token', credentialKind: 'local' }),
    ).resolves.toEqual({
      runId: 'plain',
    })
    request.mockResolvedValueOnce({ runId: 'saved' })
    await expect(call({ sessionId: 'local', focus: 'build', saveTo: 'workspace' })).resolves.toEqual({
      runId: 'saved',
    })
    expect(request).toHaveBeenLastCalledWith(local, 'build', 'workspace', undefined)
    await expect(call({ sessionId: 'remote', saveTo: 'workspace' })).resolves.toEqual({
      runId: 'from-worker',
    })
    expect(remote.refine).toHaveBeenLastCalledWith(undefined, 'workspace', undefined)
  })

  it('/refine --user saves as the user too, so it is the owner on a local connection only', async () => {
    const local = {}
    const remote = { refine: vi.fn(async () => ({ runId: 'from-worker' })) }
    const { call } = setup({ local, remote })
    request.mockClear()
    await expect(
      call({ sessionId: 'local', saveTo: 'user' }, { authKind: 'token', credentialKind: 'local' }),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce({ runId: 'saved' })
    await expect(call({ sessionId: 'local', focus: 'style', saveTo: 'user' })).resolves.toEqual({
      runId: 'saved',
    })
    expect(request).toHaveBeenLastCalledWith(local, 'style', 'user', undefined)
    await call({ sessionId: 'remote', saveTo: 'user' })
    expect(remote.refine).toHaveBeenLastCalledWith(undefined, 'user', undefined)
  })

  it('agreeing to an unknown price is taken only from the owner on a local connection', async () => {
    const local = {}
    const remote = { refine: vi.fn(async () => ({ runId: 'from-worker' })) }
    const { call } = setup({ local, remote })
    request.mockClear()
    await expect(
      call({ sessionId: 'local', allowUnpriced: true }, { authKind: 'token', credentialKind: 'local' }),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce({ runId: 'agreed' })
    await expect(call({ sessionId: 'local', focus: 'build', allowUnpriced: true })).resolves.toEqual({
      runId: 'agreed',
    })
    expect(request).toHaveBeenLastCalledWith(local, 'build', undefined, true)
    await call({ sessionId: 'remote', saveTo: 'workspace', allowUnpriced: true })
    expect(remote.refine).toHaveBeenLastCalledWith(undefined, 'workspace', true)
  })
})

describe('_agnes/v1/session.refine.save', () => {
  const method = '_agnes/v1/session.refine.save'
  const receipt = { receiptId: 'rc', outcome: 'saved' }
  it('is for the owner on a local connection only, and an unknown session is not found', async () => {
    const { call, owner } = setup({ foreign: {}, local: {} }, method)
    for (const conn of [
      { authKind: 'token', credentialKind: 'local' },
      { authKind: 'local', credentialKind: 'token' },
    ])
      await expect(call({ sessionId: 'local', kind: 'memory', id: 'm' }, conn)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
    await expect(call({ sessionId: 'foreign', kind: 'memory', id: 'm' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(call({ sessionId: 'gone', kind: 'memory', id: 'm' })).rejects.toMatchObject({
      data: { code: 'SESSION_NOT_FOUND' },
    })
    expect(owner).toHaveBeenCalledWith('session.refine.save', 'gone', expect.anything())
    expect(save).not.toHaveBeenCalled()
  })

  it('saves on the session this process holds, or asks the worker that holds it', async () => {
    const local = {}
    const remote = { refineSave: vi.fn(async () => ({ receipt })) }
    const { call } = setup({ local, remote }, method)
    save.mockResolvedValueOnce({ receipt })
    await expect(call({ sessionId: 'local', kind: 'memory', id: 'm' })).resolves.toEqual({ receipt })
    expect(save).toHaveBeenCalledWith(local, { kind: 'memory', id: 'm' }, undefined)
    await expect(call({ sessionId: 'remote', kind: 'prompt', id: 'p' })).resolves.toEqual({ receipt })
    expect(remote.refineSave).toHaveBeenCalledWith('prompt', 'p', undefined)
  })

  it('saves to user memory when asked with target user, here or on the worker', async () => {
    const local = {}
    const remote = { refineSave: vi.fn(async () => ({ receipt })) }
    const { call } = setup({ local, remote }, method)
    save.mockResolvedValueOnce({ receipt })
    await call({ sessionId: 'local', kind: 'memory', id: 'm', target: 'user' })
    expect(save).toHaveBeenLastCalledWith(local, { kind: 'memory', id: 'm' }, 'user')
    await call({ sessionId: 'remote', kind: 'prompt', id: 'p', target: 'user' })
    expect(remote.refineSave).toHaveBeenLastCalledWith('prompt', 'p', 'user')
    await expect(
      call(
        { sessionId: 'local', kind: 'memory', id: 'm', target: 'user' },
        { authKind: 'token', credentialKind: 'local' },
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  })
})

describe('_agnes/v1/session.refine.rollback', () => {
  const method = '_agnes/v1/session.refine.rollback'
  it('is for the owner on a local connection only, and an unknown session is not found', async () => {
    const { call, owner } = setup({ foreign: {}, local: {} }, method)
    for (const conn of [
      { authKind: 'token', credentialKind: 'local' },
      { authKind: 'local', credentialKind: 'token' },
    ])
      await expect(call({ sessionId: 'local', appliedSeq: 5 }, conn)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
    await expect(call({ sessionId: 'foreign', appliedSeq: 5 })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(call({ sessionId: 'gone', appliedSeq: 5 })).rejects.toMatchObject({
      data: { code: 'SESSION_NOT_FOUND' },
    })
    expect(owner).toHaveBeenCalledWith('session.refine.rollback', 'gone', expect.anything())
    expect(rollback).not.toHaveBeenCalled()
  })

  it('withdraws on the session this process holds, or asks the worker that holds it', async () => {
    const local = {}
    const remote = { refineRollback: vi.fn(async () => ({ seq: 70 })) }
    const { call } = setup({ local, remote }, method)
    rollback.mockResolvedValueOnce({ seq: 60 })
    await expect(call({ sessionId: 'local', appliedSeq: 5 })).resolves.toEqual({ seq: 60 })
    expect(rollback).toHaveBeenCalledWith(local, 5)
    await expect(call({ sessionId: 'remote', appliedSeq: 9 })).resolves.toEqual({ seq: 70 })
    expect(remote.refineRollback).toHaveBeenCalledWith(9)
  })
})
