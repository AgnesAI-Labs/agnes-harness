/** @vitest-environment happy-dom */

import type { ClientContext } from '@agnes/web-client'
import { workbenchNavigation } from '@agnes/web-client'
import { expect, it, vi } from 'vitest'
import { BrowserClient } from '../../package-manager/bundled-plugins/browser/src/browser-client.js'

vi.mock('@agnes/web-client', () => ({ workbenchNavigation: { open: vi.fn() } }))

function fixture() {
  const selected = { status: 'ready', sessionId: 'one', epoch: 1 }
  const sessionEffect = vi.fn(
    async (_service: string, _input: Record<string, unknown>, _options: { operationId: string }) => ({
      pageId: 'page-one',
    }),
  )
  const profileQuery = vi.fn(async () => ({ enabled: true, state: 'ready' }))
  const sessionQuery = vi.fn(async () => ({ pages: [] }))
  const streams = new Map<string, { frame(value: unknown): void; disconnect(): void }>()
  const open = vi.fn(async (name: string) => {
    const callbacks = { frame: (_value: unknown) => {}, disconnect: () => {} }
    streams.set(name, callbacks)
    return {
      close() {},
      onFrame(fn: (value: unknown) => void) {
        callbacks.frame = fn
      },
      onDisconnect(fn: () => void) {
        callbacks.disconnect = fn
      },
    }
  })
  const ctx = {
    session: {
      get sessionId() {
        return selected.sessionId
      },
      readiness: { getSnapshot: () => ({ ...selected }) },
    },
    agnes: { services: { effect: sessionEffect, call: sessionQuery } },
    profile: { services: { query: profileQuery }, streams: { open } },
    sessionStreams: { open },
  } as unknown as ClientContext
  return {
    client: new BrowserClient(ctx),
    selected,
    sessionEffect,
    profileQuery,
    sessionQuery,
    open,
    streams,
  }
}

it.each(['browser.open', 'browser.control'])(
  '%s reuses the original session request after transport failure and refuses another conversation',
  async (service) => {
    const { client, selected, sessionEffect } = fixture()
    sessionEffect.mockRejectedValueOnce(new Error('Connection lost'))
    const input =
      service === 'browser.open' ? { url: 'http://localhost:5173/' } : { pageId: 'page-one', mode: 'human' }
    await expect(client.effect(service, input)).rejects.toThrow('Connection lost')
    const pending = client.pendingEffect()!
    const other =
      service === 'browser.open' ? { url: 'http://localhost:5174/' } : { pageId: 'page-two', mode: 'human' }
    await expect(client.effect(service, other)).rejects.toThrow('uncertain')
    // A later permission refusal cannot prove an earlier lost request never ran.
    sessionEffect.mockRejectedValueOnce(
      Object.assign(new Error('Permission revoked'), {
        kind: 'json-rpc',
        data: { code: 'CAPABILITY_DENIED' },
      }),
    )
    await expect(client.effect(pending.service, pending.input)).rejects.toThrow('Permission revoked')
    expect(client.pendingEffect()?.operationId).toBe(pending.operationId)
    await expect(client.effect(pending.service, pending.input)).resolves.toMatchObject({
      operationId: pending.operationId,
    })
    expect(sessionEffect.mock.calls[0]).toEqual(sessionEffect.mock.calls[1])
    expect(sessionEffect.mock.calls[0]).toEqual(sessionEffect.mock.calls[2])
    expect(client.pendingEffect()).toBeUndefined()
    sessionEffect.mockImplementationOnce(async () => {
      selected.sessionId = 'two'
      selected.epoch++
      return { pageId: 'page-two' }
    })
    await expect(client.effect(service, input)).rejects.toThrow('previous conversation')
    client.close()
  },
)

it('preserves errors and session boundaries without opening the browser dock', async () => {
  const { client, profileQuery, sessionQuery, selected } = fixture()
  const open = vi.mocked(workbenchNavigation.open)
  open.mockReset()
  let release!: (state: { enabled: boolean; state: string }) => void
  profileQuery.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = client.refresh()
  // Slow status reads and updates must never change the user's dock selection.
  await client.refresh()
  release({ enabled: true, state: 'ready' })
  await pending
  expect(client.getSnapshot()).toMatchObject({ enabled: true, pages: [] })
  expect(open).not.toHaveBeenCalled()
  await client.refresh()
  const opened = open.mock.calls.length
  await client.refresh()
  expect(open.mock.calls).toHaveLength(opened)
  const pages = [
    { pageId: 'live-page', url: 'http://localhost/', pageEpoch: 1, controlEpoch: 1, mode: 'human' as const },
  ]
  client.update({ enabled: true, state: 'ready', sessionId: 'one', pages })
  profileQuery.mockRejectedValueOnce(new Error('Disconnected'))
  await client.refresh()
  expect(client.getSnapshot()).toMatchObject({
    enabled: true,
    state: 'failed',
    pages,
    error: 'Error: Disconnected',
  })
  sessionQuery.mockRejectedValueOnce(new Error('Pages temporarily unavailable'))
  await client.refresh()
  expect(client.getSnapshot()).toMatchObject({ sessionId: 'one', pages, pagesUnavailable: true })
  selected.sessionId = 'two'
  selected.epoch++
  profileQuery.mockRejectedValueOnce(new Error('Profile read failed after selection changed'))
  await client.refresh()
  expect(client.getSnapshot()).toMatchObject({ sessionId: 'two', pages: [] })
  sessionQuery.mockRejectedValueOnce(new Error('Other session is unavailable'))
  await client.refresh()
  expect(client.getSnapshot()).toMatchObject({ sessionId: 'two', pages: [], pagesUnavailable: true })
  expect(client.getSnapshot().error).toBeUndefined()
  await client.refresh()
  expect(client.getSnapshot()).toMatchObject({ sessionId: 'two', pages: [], pagesUnavailable: false })
  // A status read started in the previous attachment cannot query the new session.
  profileQuery.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const stale = client.refresh()
  selected.epoch++
  client.clearSession()
  sessionQuery.mockClear()
  release({ enabled: true, state: 'ready' })
  await stale
  expect(sessionQuery).not.toHaveBeenCalled()
  expect(client.getSnapshot()).toMatchObject({ sessionId: 'two', state: 'preparing', pages: [] })
  client.close()
})

it.each(['browser.control', 'browser.open'])(
  'returns admitted %s without waiting for a status refresh',
  async (service) => {
    const { client, profileQuery } = fixture()
    let release: ((state: { enabled: boolean; state: string }) => void) | undefined
    profileQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    let admitted = false
    const request = client.effect(service, { pageId: 'page-one', mode: 'human' })
    void request.then(() => {
      admitted = true
    })
    try {
      await vi.waitFor(() => expect(admitted).toBe(true))
    } finally {
      release?.({ enabled: true, state: 'ready' })
      await request
      client.close()
    }
  },
)

it('uses admitted pushes without idle queries, falls back after disconnect, and rejects late previous-session events', async () => {
  vi.useFakeTimers()
  const { client, streams, selected, profileQuery, sessionQuery, open } = fixture()
  const page = { pageId: 'one-page', url: 'http://localhost/', pageEpoch: 0, controlEpoch: 0, mode: 'agent' }
  try {
    const stop = client.start() as (() => void) | undefined
    await vi.advanceTimersByTimeAsync(0)
    const oldPages = streams.get('browser.pages')!
    oldPages.frame({ enabled: true, state: 'ready', pages: [page] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.getSnapshot()).toMatchObject({ state: 'ready', sessionId: 'one', pages: [page] })
    expect(profileQuery).not.toHaveBeenCalled()
    expect(sessionQuery).not.toHaveBeenCalled()
    expect(workbenchNavigation.open).not.toHaveBeenCalled()
    oldPages.disconnect()
    await vi.advanceTimersByTimeAsync(3000)
    expect(sessionQuery).toHaveBeenCalledWith('browser.pages', {})
    expect(profileQuery).toHaveBeenCalledWith('browser.status', {})
    selected.sessionId = 'two'
    selected.epoch++
    client.clearSession()
    await vi.advanceTimersByTimeAsync(0)
    oldPages.frame({ pages: [page] })
    oldPages.disconnect()
    expect(client.getSnapshot()).toMatchObject({ sessionId: 'two', pages: [] })
    streams.get('browser.pages')!.frame({ enabled: true, state: 'ready', pages: [] })
    sessionQuery.mockClear()
    await vi.advanceTimersByTimeAsync(6000)
    expect(sessionQuery).not.toHaveBeenCalled()
    stop?.()
    const reads = open.mock.calls.length
    streams.get('browser.pages')!.disconnect()
    selected.epoch++
    client.clearSession()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(open.mock.calls).toHaveLength(reads)
    expect(sessionQuery).not.toHaveBeenCalled()
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(open.mock.calls).toHaveLength(reads + 1)
    streams.get('browser.pages')!.frame({ enabled: true, state: 'ready', pages: [] })
    client.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sessionQuery).not.toHaveBeenCalled()
  } finally {
    client.close()
    vi.useRealTimers()
  }
})

it('accepts a new action after a known browser refusal without retaining an uncertain request', async () => {
  const { client, sessionEffect } = fixture()
  try {
    let finish!: (result: unknown) => void
    sessionEffect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }) as never,
    )
    const running = client.effect('browser.open', { url: 'http://localhost:5173/' })
    expect(client.pendingEffect()).toBeUndefined()
    finish({ status: 'ok' })
    await running
    expect(client.pendingEffect()).toBeUndefined()
    sessionEffect.mockClear()
    sessionEffect.mockResolvedValueOnce({ status: 'refused', code: 'PROTECTED_TARGET' } as never)
    await expect(client.effect('browser.open', { url: 'http://localhost:4180/' })).rejects.toMatchObject({
      code: 'PROTECTED_TARGET',
    })
    expect(client.pendingEffect()).toBeUndefined()
    await expect(client.effect('browser.open', { url: 'http://localhost:5173/' })).resolves.toBeDefined()
    expect(sessionEffect.mock.calls[0]![2]).not.toEqual(sessionEffect.mock.calls[1]![2])
  } finally {
    client.close()
  }
})

it.each(['CAPABILITY_DENIED', 'OVERLOADED', 'OUTCOME_UNKNOWN', 'INTERNAL_ERROR'])(
  'uses the authenticated %s outcome when deciding whether another operation is safe',
  async (code) => {
    const { client, sessionEffect } = fixture()
    try {
      sessionEffect.mockRejectedValueOnce(
        Object.assign(new Error(code), { kind: 'json-rpc', data: { code } }),
      )
      await expect(client.effect('browser.control', { pageId: 'one', mode: 'human' })).rejects.toThrow(code)
      if (code === 'CAPABILITY_DENIED' || code === 'OVERLOADED') {
        expect(client.pendingEffect()).toBeUndefined()
        await expect(
          client.effect('browser.control', { pageId: 'two', mode: 'human' }),
        ).resolves.toBeDefined()
      } else {
        expect(client.pendingEffect()).toBeDefined()
        await expect(client.effect('browser.control', { pageId: 'two', mode: 'human' })).rejects.toThrow(
          'uncertain',
        )
      }
    } finally {
      client.close()
    }
  },
)

it('keeps the newest pushed pages when an older recovery query finishes', async () => {
  const { client, streams, sessionQuery } = fixture()
  let release!: (value: { pages: never[] }) => void
  sessionQuery.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  try {
    client.start()
    await vi.waitFor(() => expect(streams.has('browser.pages')).toBe(true))
    const pending = client.refresh()
    await vi.waitFor(() => expect(release).toBeDefined())
    const pages = [
      { pageId: 'new-page', url: 'http://localhost/', pageEpoch: 3, controlEpoch: 0, mode: 'agent' },
    ]
    streams.get('browser.pages')!.frame({ pages })
    release({ pages: [] })
    await pending
    expect(client.getSnapshot().pages).toEqual(pages)
  } finally {
    client.close()
  }
})
