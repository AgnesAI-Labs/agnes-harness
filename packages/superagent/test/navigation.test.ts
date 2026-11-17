// Adapted from dsh-superagent (MIT)
import { expect, it, vi } from 'vitest'
import { openKnownSession, type SessionCatalog, type SessionId } from '../src/navigation.js'

const id: SessionId = 'orchestrator-test'
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(ready = false) {
  const pending = deferred()
  const state = {
    phase: ready ? 'ready' : 'pending',
    byId: ready ? { [id]: {} } : ({} as Record<string, object>),
  }
  const refresh = vi.fn(async () => {
    await pending.promise
  })
  // Navigation reads only catalog readiness and membership, not summary fields.
  const sessions = { list: { getSnapshot: () => state }, refresh } as unknown as SessionCatalog
  return { sessions, pending, state, refresh }
}
it('waits for initial catalog hydration before opening the linked master', async () => {
  const { sessions, pending, state } = fixture()
  const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  expect(open).not.toHaveBeenCalled()
  state.phase = 'ready'
  state.byId[id] = {}
  pending.resolve()
  await expect(navigation).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id)
})
it('opens known Sessions without another network refresh', async () => {
  const { sessions, refresh } = fixture(true)
  const open = vi.fn()
  await expect(openKnownSession(sessions, id, open, new AbortController().signal)).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id)
  expect(refresh).not.toHaveBeenCalled()
})
it('reports unavailable targets without calling the throwing Session selector', async () => {
  const { sessions, pending, state } = fixture()
  const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  state.phase = 'ready'
  pending.resolve()
  await expect(navigation).rejects.toMatchObject({ code: 'not-listed' })
  expect(open).not.toHaveBeenCalled()
})
it('does not navigate after the panel unmounts or a newer request supersedes it', async () => {
  const { sessions, pending, state } = fixture()
  const open = vi.fn()
  const controller = new AbortController()
  const navigation = openKnownSession(sessions, id, open, controller.signal)
  controller.abort()
  state.phase = 'ready'
  state.byId[id] = {}
  pending.resolve()
  await expect(navigation).resolves.toBe(false)
  expect(open).not.toHaveBeenCalled()
})
