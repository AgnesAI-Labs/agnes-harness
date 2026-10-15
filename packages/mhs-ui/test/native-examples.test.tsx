// @vitest-environment happy-dom
import type { ClientContext, UiExtensionContext } from '@agnes/web-client'
import { expect, it } from 'vitest'
import { nativeExamples } from '../src/native-examples.js'
import type { ExampleRuntime, ExampleSceneHost } from '../src/ports.js'

it('binds a profile scene runtime, gates both launches, retains uncertain submissions and stops on host revocation', async () => {
  sessionStorage.clear()
  const id = '@agnes-example/mars-rescue'
  const availability = new Set<() => void>(),
    changes = new Set<() => void>(),
    cleanups: (() => void)[] = []
  let active = true,
    host: ExampleSceneHost | undefined,
    uncertain = true
  let state: ReturnType<ExampleRuntime['getSnapshot']> = { state: 'stopped', connected: 0, total: 11 }
  const sessions = new Set<string>()
  const runtime: ExampleRuntime = {
    getSnapshot: () => state,
    subscribe: (fn) => {
      changes.add(fn)
      return () => {
        changes.delete(fn)
      }
    },
    async stop() {
      state = { ...state, state: 'stopped', connected: 0 }
      for (const fn of changes) fn()
    },
  }
  const ctx = {
    module: {
      rowId: 'web:mhs',
      binding: { lifetime: 'profile', profileId: 'synthetic', activationId: 'current' },
    },
    effect: (fn: () => () => void) => {
      cleanups.push(fn())
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
    locale: { t: (key: string) => key },
    profile: {
      examples: {
        stop: async () => {},
        list: async () => [
          {
            id,
            installation: 'enabled',
            runtime: { state: 'running' },
            metadata: {
              displayName: 'Mars',
              description: 'Simulation',
              pageEntry: 'mars-rescue',
              launches: [
                { id: 'rescue', title: 'Rescue' },
                { id: 'sample', title: 'Sample' },
              ],
            },
          },
        ],
      },
      launch: {
        async prepare(example: string, launch: string) {
          expect(example).toBe(id)
          return { launchTicket: `ticket-${launch}`, presentation: { launch } }
        },
        async start(ticket: string, operationId: string) {
          expect(ticket).toBe('ticket-sample')
          sessions.add(operationId)
          if (uncertain) {
            uncertain = false
            throw new Error('OUTCOME_UNKNOWN')
          }
          return { sessionId: 'sample-session' }
        },
      },
    },
    examplePages: {
      subscribe: () => () => {},
      render: (example: string, context: UiExtensionContext) => {
        if (example !== id) return null
        if (context.data) host = context.data as ExampleSceneHost
        return <p>Mars</p>
      },
    },
  } as unknown as ClientContext
  const port = nativeExamples(ctx)
  const lifetime = new AbortController()
  try {
    const first = (await port.list(lifetime.signal))[0]!
    expect(first).toMatchObject({
      state: 'installed',
      requiresRuntime: true,
      launches: [{ id: 'rescue' }, { id: 'sample' }],
    })
    await expect(port.prepare?.(id, 'rescue')).rejects.toThrow('example-runtime-unavailable')
    const Scene = first.Scene!
    let requested = ''
    // Invoke the local scene host; rendering its child is owned by the normal page registry.
    const scene = Scene as (props: { onClose(): void; onLaunch(id: string): void }) => unknown
    scene({
      onClose() {},
      onLaunch: (launch) => {
        requested = launch
      },
    })
    if (!host) throw new Error('missing-scene-host')
    expect(host.profileId).toBe('synthetic')
    const off = host.bindRuntime(runtime, lifetime.signal)
    expect(() => host?.bindRuntime(runtime, lifetime.signal)).toThrow('already-bound')
    state = { state: 'running', connected: 11, total: 11 }
    for (const fn of changes) fn()
    expect((await port.list(lifetime.signal))[0]).toMatchObject({
      state: 'running',
      connected: 11,
      total: 11,
      Scene,
    })
    host.launch('sample')
    expect(requested).toBe('sample')
    await expect(port.prepare?.(id, 'undeclared')).rejects.toThrow('example-launch-unavailable')
    const review = await port.prepare?.(id, 'sample')
    await expect(port.launch(id, review?.launchTicket)).rejects.toThrow('OUTCOME_UNKNOWN')
    // Recreate the parent adapter, as on a page reload, and reuse the durable client submission.
    const second = nativeExamples(ctx)
    const view = (await second.list(lifetime.signal))[0]!
    ;(view.Scene as typeof scene)({ onClose() {}, onLaunch() {} })
    host.bindRuntime(runtime, lifetime.signal)
    const retry = await second.prepare?.(id, 'sample')
    expect(retry?.launchTicket).toBe(review?.launchTicket)
    await expect(second.launch(id, retry?.launchTicket)).resolves.toEqual({ sessionId: 'sample-session' })
    expect(sessions.size).toBe(1)
    await port.stop(id)
    expect((await port.list(lifetime.signal))[0]).toMatchObject({ state: 'stopped', connected: 0 })
    state = { state: 'running', connected: 11, total: 11 }
    active = false
    for (const fn of availability) fn()
    expect(runtime.getSnapshot()).toMatchObject({ state: 'stopped', connected: 0 })
    await expect(port.stop(id)).rejects.toThrow('example-host-unavailable')
    expect(() => host?.launch('rescue')).toThrow('example-host-unavailable')
    off()
  } finally {
    lifetime.abort()
    for (const cleanup of cleanups.reverse()) cleanup()
    sessionStorage.clear()
  }
})
