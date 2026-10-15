// @vitest-environment happy-dom

import { conversationCards, type HomeEntry, workbenchPanels } from '@agnes/web-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, createMhsModule } from '../src/module.js'
import type { MhsModuleContext } from '../src/ports.js'
import { fake } from './fixtures.js'

function context(f: ReturnType<typeof fake>) {
  const availability = new Set<() => void>(),
    registrations = new Map<string, HomeEntry>(),
    effects: (() => unknown)[] = [],
    slots = new Set<string>()
  let active = true
  const ctx = {
    effect: (fn: () => unknown) => {
      effects.push(fn)
    },
    availability: {
      getSnapshot: () => ({ availability: active ? 'active' : 'disabled' }),
      subscribe: (fn: () => void) => {
        availability.add(fn)
        return () => {
          availability.delete(fn)
        }
      },
    },
    homeEntries: {
      register: (entry: HomeEntry) => {
        registrations.set(entry.id, entry)
        return () => {
          registrations.delete(entry.id)
        }
      },
    },
    locale: { register: () => () => {}, subscribe: () => () => {}, getSnapshot: () => 'en' },
    session: f.ports.session,
    slots: {
      register: ({ key }: { key: string }) => {
        slots.add(key)
        return () => {
          slots.delete(key)
        }
      },
    },
  } as unknown as MhsModuleContext
  return {
    ctx,
    registrations,
    slots,
    disable() {
      active = false
      for (const fn of availability) fn()
    },
    effects,
  }
}
afterEach(() => vi.useRealTimers())
describe('profile contribution lifecycle', () => {
  it('keeps a primary home entry independent of session, scopes dock counts, and synchronously removes all registrations on disable', async () => {
    vi.useFakeTimers()
    const f = fake(),
      c = context(f),
      dispose = createMhsModule(f.ports).apply(c.ctx)
    await vi.advanceTimersByTimeAsync(0)
    expect(c.registrations.get('mhs')?.badge?.getSnapshot()).toBe(1)
    expect(c.registrations.get('mhs')).toMatchObject({ placement: 'primary', order: 40 })
    expect(c.slots.size).toBe(7)
    f.setNodes([
      {
        kind: 'tool',
        name: 'call_device',
        argsPreview: '{"device":"rover-01"}',
        toolUseId: 'go',
        seq: 5,
        status: 'running',
      },
    ])
    const panel = workbenchPanels.get('mhs.devices')
    const session = { sessionId: 'session-a' } as MhsModuleContext['session']
    await vi.advanceTimersByTimeAsync(0)
    expect(panel?.count?.read({ t: (key) => key, session })).toBe(1)
    expect(
      panel?.count?.read({
        t: (key) => key,
        session: { sessionId: 'session-b' } as MhsModuleContext['session'],
      }),
    ).toBe(0)
    expect(
      conversationCards
        .get('mhs.tools')
        ?.matches({ kind: 'tool', data: { kind: 'tool', name: 'stop_device', argsPreview: '{}', seq: 3 } }),
    ).toBe(true)
    c.disable()
    expect(c.registrations.size).toBe(0)
    expect(c.slots.size).toBe(0)
    expect(workbenchPanels.get('mhs.devices')).toBeUndefined()
    expect(conversationCards.get('mhs.tools')).toBeUndefined()
    expect(f.stream.closed).toBe(true)
    expect(f.sessionListeners.size).toBe(0)
    dispose()
  })
  it('fails closed when profile facades are absent and rolls back partial registration failures', async () => {
    const f = fake(),
      c = context(f)
    expect(() => apply(c.ctx)).toThrow('requires profile services')
    c.ctx.homeEntries.register = () => {
      throw new Error('undeclared')
    }
    expect(() => createMhsModule(f.ports).apply(c.ctx)).toThrow('undeclared')
    await Promise.resolve()
    expect(f.sessionListeners.size).toBe(0)
    expect(workbenchPanels.get('mhs.devices')).toBeUndefined()
  })
})
