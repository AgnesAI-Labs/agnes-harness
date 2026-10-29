import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'

const ask = vi.hoisted(() => vi.fn())
vi.mock('@agnes/host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/host')>()),
  askSideQuestion: ask,
}))
const { registerSessionBtw } = await import('../src/local/methods/session-btw.js')

function setup(sessions: string[]) {
  let handler!: (params: unknown, c: CallContext) => Promise<unknown>
  const ep = { register: (_name: string, fn: typeof handler) => (handler = fn) }
  const owner = vi.fn((_m: string, id: string) => {
    if (id === 'foreign') throw rpcError('CAPABILITY_DENIED', {})
  })
  registerSessionBtw(
    ep as never,
    { registry: { get: (id) => (sessions.includes(id) ? ({ session: {} } as never) : undefined) } },
    owner,
  )
  const call = (sessionId: string) =>
    handler({ sessionId, question: 'q' }, { signal: new AbortController().signal } as CallContext)
  return { call, owner }
}

describe('_agnes/v1/session.btw', () => {
  it('refuses a non-owner and an unknown session before asking the model', async () => {
    const { call } = setup(['mine', 'foreign'])
    await expect(call('foreign')).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    await expect(call('gone')).rejects.toMatchObject({ data: { code: 'SESSION_NOT_FOUND' } })
    expect(ask).not.toHaveBeenCalled()
  })

  it('allows one side question per session at a time and frees the slot afterwards', async () => {
    const { call } = setup(['mine'])
    let release!: () => void
    ask.mockImplementationOnce(() => new Promise((r) => (release = () => r({ text: 'a', model: 'm' }))))
    const first = call('mine')
    await expect(call('mine')).rejects.toMatchObject({ data: { code: 'SESSION_BUSY' } })
    release()
    await expect(first).resolves.toMatchObject({ text: 'a' })
    ask.mockResolvedValueOnce({ text: 'b', model: 'm' })
    await expect(call('mine')).resolves.toMatchObject({ text: 'b' })
  })
})
