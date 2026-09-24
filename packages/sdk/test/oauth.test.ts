import { expect, it, vi } from 'vitest'
import { loginCodex, type OAuthClient } from '../src/oauth.js'

it('rejects an already-cancelled caller without creating an operation or an unhandled rejection', async () => {
  const controller = new AbortController()
  controller.abort()
  const client = { oauth: vi.fn() }
  await expect(
    loginCodex(
      client,
      { action: 'start' },
      { signal: controller.signal, notice: () => {}, prompt: async () => '' },
    ),
  ).rejects.toBeDefined()
  expect(client.oauth).not.toHaveBeenCalled()
})

it('ignores a stale manual answer when the browser callback has already consumed that prompt', async () => {
  const client = {
    oauth: vi.fn<OAuthClient['oauth']>(async (input) => {
      if (input.action === 'answer') throw new Error('CONFIG_INVALID_INPUT')
      return { operationId: 'op', state: 'running' as const }
    }),
  }
  client.oauth.mockResolvedValueOnce({
    operationId: 'op',
    state: 'running',
    prompt: { id: 'p', type: 'manual_code', message: 'Code' },
  })
  let polls = 0
  client.oauth.mockImplementation(async (input) => {
    if (input.action === 'answer') throw new Error('CONFIG_INVALID_INPUT')
    return { operationId: 'op', state: ++polls === 1 ? 'running' : 'ready' }
  })
  const result = await loginCodex(
    client,
    { action: 'start' },
    { signal: new AbortController().signal, notice: () => {}, prompt: async () => 'manual-code' },
  )
  expect(result.state).toBe('ready')
})

it('finishes browser login without waiting for manual input and cancels its stale prompt', async () => {
  const ac = new AbortController()
  let promptSignal: AbortSignal | undefined
  const client = {
    oauth: vi
      .fn()
      .mockResolvedValueOnce({
        operationId: 'a',
        state: 'running',
        prompt: { id: 'p', type: 'manual_code', message: 'Code' },
      })
      .mockResolvedValue({ operationId: 'a', state: 'ready', models: [{ id: 'm', name: 'M' }] }),
  }
  const result = await loginCodex(
    client,
    { action: 'start' },
    {
      signal: ac.signal,
      notice: () => {},
      prompt: (_value, signal) => {
        promptSignal = signal
        return new Promise(() => {})
      },
    },
  )
  expect(result.state).toBe('ready')
  expect(promptSignal?.aborted).toBe(true)
  expect(client.oauth).toHaveBeenLastCalledWith({ action: 'poll', operationId: 'a' })
})

it('cleans up a server operation when cancellation races the start reply', async () => {
  const ac = new AbortController()
  let reply!: (v: { operationId: string; state: 'running' }) => void
  const client = {
    oauth: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            reply = resolve
          }),
      )
      .mockResolvedValue({ operationId: 'a', state: 'cancelled' }),
  }
  const work = loginCodex(
    client,
    { action: 'start' },
    { signal: ac.signal, notice: () => {}, prompt: async () => '' },
  )
  ac.abort()
  await expect(work).rejects.toThrow('CONFIG_AUTH_CANCELLED')
  reply({ operationId: 'a', state: 'running' })
  await vi.waitFor(() =>
    expect(client.oauth).toHaveBeenLastCalledWith({ action: 'cancel', operationId: 'a' }),
  )
})
