import type { ShellSnapshot } from '@agnes/extension-api/client'
import { validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { createLegacyShellServices } from '../../src/runtime/services/legacy-shell-services.js'
import { createShellSnapshotStore } from '../../src/runtime/services/snapshot-store.js'

describe('shell snapshot store', () => {
  it('starts as a valid snapshot of an offline page with no session', () => {
    const store = createShellSnapshotStore()
    expect(validateRuntime('ShellSnapshot', store.current()).ok).toBe(true)
    expect(store.current()).toMatchObject({ sessionId: null, connection: 'offline', conversation: null })
  })

  it('reports the open session and the connection, each change once and as a new valid snapshot', () => {
    const store = createShellSnapshotStore()
    const heard: ShellSnapshot[] = []
    store.subscribe((snapshot) => heard.push(snapshot))

    store.set({ connection: 'connecting' })
    store.set({ connection: 'connected' })
    store.set({ sessionId: 'session-1' })
    store.set({ sessionId: 'session-1', connection: 'connected' })
    store.set({ connection: 'reconnecting' })
    store.set({ connection: 'closed' })
    store.set({ sessionId: null })

    expect(heard.map(({ sessionId, connection }) => [sessionId, connection])).toEqual([
      [null, 'connected'],
      ['session-1', 'connected'],
      ['session-1', 'reconnecting'],
      ['session-1', 'offline'],
      [null, 'offline'],
    ])
    for (const snapshot of heard) expect(validateRuntime('ShellSnapshot', snapshot).ok).toBe(true)
    expect(new Set(heard).size).toBe(heard.length)
  })

  it('keeps the same snapshot object while nothing in it changes', () => {
    const store = createShellSnapshotStore()
    store.set({ sessionId: 'session-1', connection: 'connected' })
    const kept = store.current()
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    store.set({ sessionId: 'session-1' })
    store.set({ connection: 'connected' })
    expect(store.current()).toBe(kept)
    expect(listener).not.toHaveBeenCalled()

    stop()
    store.set({ sessionId: 'session-2' })
    expect(listener).not.toHaveBeenCalled()
    expect(store.current().sessionId).toBe('session-2')
  })
})

describe('transitional shell services', () => {
  it('navigates by opening the session the way the page does', async () => {
    const open = vi.fn(async () => undefined)
    const services = createLegacyShellServices({ open })
    expect(await services.navigate({ sessionId: 'session-1' })).toEqual({ ok: true, value: undefined })
    expect(open).toHaveBeenCalledWith('session-1')
  })

  it('refuses a navigation it cannot carry out, and one the page refuses', async () => {
    const open = vi.fn(async (sessionId: string) => {
      if (sessionId === 'busy') throw new Error('another session is still opening')
    })
    const services = createLegacyShellServices({ open })
    expect(await services.navigate({ sessionId: 'session-1', viewId: 'view-1' })).toMatchObject({
      ok: false,
      error: { detailCode: 'web_shell_service_unwired' },
    })
    expect(await services.navigate({ sessionId: 'busy' })).toMatchObject({
      ok: false,
      error: { detailCode: 'web_navigate_failed', message: 'another session is still opening' },
    })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('refuses every service the page cannot answer, with a valid runtime error', async () => {
    const services = createLegacyShellServices({ open: async () => undefined })
    const refusals = [
      await services.conversation.open({ sessionId: 'session-1', limit: 10 }),
      await services.conversation.cancel({ sessionId: 'session-1', runId: 'run-1', requestId: 'request-1' }),
      await services.control.read('session-1'),
      await services.domains.query({} as never),
      services.presentation.legacySlot({ name: 'slot', props: null }),
    ]
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'web_shell_service_unwired' },
      })
      if (!refusal.ok) expect(validateRuntime('RuntimeError', refusal.error).ok).toBe(true)
    }
  })
})
