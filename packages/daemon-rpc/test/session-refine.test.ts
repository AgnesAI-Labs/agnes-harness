import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@agnes/host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/host')>()),
  requestRefinement: request,
}))
const { registerSessionRefine } = await import('../src/local/methods/refinement.js')

function setup(sessions: Record<string, object>) {
  let handler!: (params: unknown, c: CallContext) => Promise<unknown>
  const ep = { register: (_name: string, fn: typeof handler) => (handler = fn) }
  const owner = vi.fn((_m: string, id: string) => {
    if (id === 'foreign') throw rpcError('CAPABILITY_DENIED', {})
  })
  registerSessionRefine(
    ep as never,
    { registry: { get: (id) => (sessions[id] ? ({ session: sessions[id] } as never) : undefined) } },
    owner,
  )
  const call = (params: unknown) => handler(params, { signal: new AbortController().signal } as CallContext)
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
    expect(request).toHaveBeenCalledWith(local, 'tests')
    await expect(call({ sessionId: 'remote' })).resolves.toEqual({ runId: 'from-worker' })
    expect(remote.refine).toHaveBeenCalledWith(undefined)
  })
})
