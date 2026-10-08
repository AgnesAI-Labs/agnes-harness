import type { WorkspaceInvocationPort, WorkspaceInvocationView } from '@agnes/core'
import { describe, expect, it, vi } from 'vitest'
import { applyHotPolicySnapshot, createHotPolicyFacade } from '../src/profile-policy.js'
import { PublicationDispatch } from '../src/publication-dispatch.js'
import { PublicationGate } from '../src/publication-gate.js'

describe('PublicationDispatch', () => {
  it('queues ordinary resolution while closed and invokes only after releasing its ticket', async () => {
    const gate = new PublicationGate()
    const dispatch = new PublicationDispatch(gate)
    let openWriter = () => {}
    const writerHold = new Promise<void>((resolve) => {
      openWriter = resolve
    })
    const writer = gate.withClosed(() => writerHold)
    const events: string[] = []
    const call = dispatch.ordinary(() => {
      events.push('resolve')
      return () => {
        events.push('invoke')
        return 'ok'
      }
    })
    await Promise.resolve()
    expect(events).toEqual([])
    openWriter()
    await writer
    await expect(call).resolves.toBe('ok')
    expect(events).toEqual(['resolve', 'invoke'])
  })

  it('releases the ticket when ordinary resolution throws', async () => {
    const gate = new PublicationGate()
    const dispatch = new PublicationDispatch(gate)
    const failure = new Error('resolve failed')
    await expect(
      dispatch.ordinary(() => {
        throw failure
      }),
    ).rejects.toBe(failure)
    const writer = vi.fn()
    await gate.withClosed(writer)
    expect(writer).toHaveBeenCalledOnce()
  })

  it('enters the resolved workspace port synchronously before releasing the publication ticket', async () => {
    const gate = new PublicationGate()
    const dispatch = new PublicationDispatch(gate)
    const events: string[] = []
    let releaseCallback = () => {}
    const callbackHold = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    const view = {} as WorkspaceInvocationView
    const port = {
      run<T>(callback: (workspace: WorkspaceInvocationView) => T | Promise<T>): Promise<T> {
        events.push('workspace:acquired')
        const result = Promise.resolve().then(async () => {
          events.push('callback:start')
          await callbackHold
          return callback(view)
        })
        return result
      },
    } as WorkspaceInvocationPort

    const call = dispatch.workspace(() => ({
      port,
      handler: () => {
        events.push('callback:handler')
        return 'ok'
      },
    }))
    const writer = gate.withClosed(() => {
      events.push('writer')
    })

    await vi.waitFor(() => expect(events).toContain('workspace:acquired'))
    await writer
    expect(events).toEqual(['workspace:acquired', 'callback:start', 'writer'])
    releaseCallback()
    await expect(call).resolves.toBe('ok')
    expect(events).toEqual(['workspace:acquired', 'callback:start', 'writer', 'callback:handler'])
  })

  it('does not double-acquire or release a workspace invocation', async () => {
    const gate = new PublicationGate()
    const dispatch = new PublicationDispatch(gate)
    const run = vi.fn(async (callback: (view: WorkspaceInvocationView) => Promise<string> | string) =>
      callback({} as WorkspaceInvocationView),
    )
    const port = { run } as unknown as WorkspaceInvocationPort
    await expect(dispatch.workspace(() => ({ port, handler: () => 'ok' }))).resolves.toBe('ok')
    expect(run).toHaveBeenCalledOnce()
  })

  it('acquires a resource lease under the ticket and releases it after the handler settles', async () => {
    const gate = new PublicationGate()
    const dispatch = new PublicationDispatch(gate)
    const events: string[] = []
    let finish = () => {}
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    const call = dispatch.resource(
      () => ({
        acquire: () => ({
          value: 'resource',
          release: () => events.push('release'),
        }),
      }),
      async (value) => {
        events.push(`handler:${value}`)
        await held
        return 'ok'
      },
    )
    await vi.waitFor(() => expect(events).toEqual(['handler:resource']))
    await gate.withClosed(() => events.push('writer'))
    expect(events).toEqual(['handler:resource', 'writer'])
    finish()
    await expect(call).resolves.toBe('ok')
    expect(events).toEqual(['handler:resource', 'writer', 'release'])
  })

  it('releases an acquired resource lease when the handler rejects', async () => {
    const dispatch = new PublicationDispatch(new PublicationGate())
    const release = vi.fn()
    const failure = new Error('resource handler failed')
    await expect(
      dispatch.resource(
        () => ({ acquire: () => ({ value: 'resource', release }) }),
        async () => {
          throw failure
        },
      ),
    ).rejects.toBe(failure)
    expect(release).toHaveBeenCalledOnce()
  })

  it('refuses new capability admission until in-flight ordinary calls drain', async () => {
    const facade = createHotPolicyFacade()
    applyHotPolicySnapshot(facade, 'policy:capabilities', { revision: 'c1', value: ['tools'] })
    const dispatch = new PublicationDispatch(new PublicationGate(), facade)
    let releaseHeld = () => {}
    const hold = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    const held = dispatch.ordinary(() => async () => {
      await hold
      return 'held'
    })
    await Promise.resolve()
    await Promise.resolve()
    applyHotPolicySnapshot(facade, 'policy:capabilities', { revision: 'c2', value: [] })
    await expect(dispatch.ordinary(() => () => 'denied')).rejects.toThrow(/E_POLICY_DRAIN/)
    expect(facade.current.get('policy:capabilities')?.revision).toBe('c1')
    releaseHeld()
    await expect(held).resolves.toBe('held')
    expect(facade.current.get('policy:capabilities')?.revision).toBe('c2')
  })
})
