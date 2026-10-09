import type { Client, Session } from '@agnes/sdk/browser'
import { expect, it, vi } from 'vitest'
import { intelligentUiServer } from '../../src/intelligent-ui/server.js'

it('uses authenticated UI methods and preserves the conversation event cursor/filter', async () => {
  const listeners: Session['listeners'] = new Set()
  const handlers = new Map<string, (payload: unknown) => void>()
  const call = vi.fn(async () => ({})),
    attach = vi.fn(async () => {})
  const client = {
    call,
    on: (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler)
      return () => {
        handlers.delete(name)
      }
    },
  } as unknown as Client
  const session = {
    id: 'session-finance',
    listeners,
    attached: true,
    generation: 2,
    lastServerSeq: 10,
    filter: { preview: true, acpUpdates: false },
    attach,
  } as unknown as Session
  const server = intelligentUiServer(client, session),
    event = vi.fn(),
    gap = vi.fn()
  const stop = server.listen(event, gap)
  await server.read({ sessionId: session.id })
  expect(call).toHaveBeenCalledWith('_agnes/v1/ui.read', { sessionId: session.id })
  await server.attach(10)
  expect(attach).not.toHaveBeenCalled()
  for (const listener of listeners)
    listener(
      '_agnes/v1/session.event',
      { event: { seq: 11, type: 'x/agnes/intelligent-ui/action.received' } },
      undefined,
    )
  expect(event).toHaveBeenCalledWith({ seq: 11, type: 'x/agnes/intelligent-ui/action.received' })
  handlers.get('gap')?.({ sessionId: 'another' })
  expect(gap).not.toHaveBeenCalled()
  handlers.get('reconnected')?.({})
  expect(gap).toHaveBeenCalledOnce()
  stop()
  expect(listeners.size).toBe(0)
  expect(handlers.size).toBe(0)
})
