import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookState } from '../../src/runtime/hooks.js'
import { SessionRegistry } from '../../src/runtime/sessions.js'
import { tempStore, ticket } from './helpers.js'
import { hookHarness } from './hook-harness.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

/** The owner's own sessions, including ones whose key looks like Superagent's but which the store never registered. */
const OWNER_SESSIONS = [
  '01HXOWNER',
  'superagent:orchestrator',
  'superagent:worker:t1',
  'superagent:worker:t1/01HXCHILD',
]
const notPromise = (value: unknown) =>
  expect(value instanceof Promise || typeof (value as { then?: unknown })?.then === 'function').toBe(false)

describe('hooks on sessions that are not Superagent sessions', () => {
  for (const state of ['not started', 'starting', 'stopped'] as const)
    it(`allow every tool and add no section while the service is ${state}, without waiting for it`, () => {
      const hooks = hookHarness()
      const registry = new SessionRegistry(temp.store)
      // Superagent's own sessions in this store have other ids than the owner's.
      registry.record({ kind: 'worker', ticketId: 't2' }, 'superagent:worker:t2')
      temp.store.tickets.save(ticket('t1', { state: 'ended' }))
      const deps = {
        registry,
        store: temp.store,
        unavailable: vi.fn(() => 'Superagent is starting'),
        prompt: { request: vi.fn(() => 'never') },
        liveNote: vi.fn(() => undefined),
      }
      if (state !== 'not started') hooks.cell.set(createHookState(deps))
      if (state === 'stopped') hooks.cell.clear()
      for (const key of OWNER_SESSIONS) {
        for (const tool of ['shell', 'read', 'orchestrator_report']) {
          const decision = hooks.toolCall(key, tool, { command: 'sleep 60', timeoutMs: 600_000 })
          notPromise(decision)
          expect(decision, `${key} ${tool}`).toEqual({ allow: true })
        }
        const context = hooks.context(key)
        notPromise(context)
        expect(context).toEqual({})
      }
      expect(deps.prompt.request).not.toHaveBeenCalled()
      expect(deps.liveNote).not.toHaveBeenCalled()
      if (state === 'starting') {
        // Superagent's own session is refused with the reason while the service is not ready, still synchronously.
        const refused = hooks.toolCall('superagent:worker:t2', 'shell', { command: 'ls' })
        notPromise(refused)
        expect(refused).toEqual({ allow: false, reason: 'Superagent is starting' })
        expect(hooks.context('superagent:worker:t2')).toEqual({})
      }
    })
})
