import type { WorkspaceInvocationPort, WorkspaceInvocationView } from '@agnes/core'
import { fakeProvider } from '@agnes/core/testkit'
import type { SessionRef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { createTrajectoryLifecycle } from '../src/trajectory-lifecycle.js'
import { ledgerDir, openOn } from './scan-trunc/fixture.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function invocation(events: string[]): WorkspaceInvocationPort {
  return {
    run<T>(invoke: (view: WorkspaceInvocationView) => Promise<T>): Promise<T> {
      events.push('acquire')
      return Promise.resolve()
        .then(() => invoke({} as WorkspaceInvocationView))
        .finally(() => events.push('release'))
    },
  }
}

const ref = Object.freeze({
  key: 'session-1',
  lane: 'main',
  workspaceRoot: '/workspace',
}) as SessionRef

describe('trajectory workspace invocation', () => {
  it('acquires before resolving session context and releases after scan settles', async () => {
    const events: string[] = []
    const scan = deferred<never[]>()
    const lifecycle = createTrajectoryLifecycle(
      {
        env: { AGNES_TRACE_ENDPOINT: 'https://platform.agnes-ai.com/' },
        resolve: () => {
          events.push('resolve-context')
          return {
            lastSeq: 0,
            scan: () => {
              events.push('scan')
              return scan.promise
            },
          }
        },
      },
      () => invocation(events),
    )
    if (!lifecycle) throw new Error('trajectory lifecycle missing')

    const result = lifecycle.previous(ref, new AbortController().signal)
    expect(events).toEqual(['acquire'])
    await Promise.resolve()
    expect(events).toEqual(['acquire', 'resolve-context', 'scan'])
    scan.resolve([])
    await expect(result).resolves.toBeNull()
    expect(events).toEqual(['acquire', 'resolve-context', 'scan', 'release'])
  })

  it('holds the workspace invocation through the outbound request and releases on failure', async () => {
    const events: string[] = []
    const response = deferred<Response>()
    const request = vi.fn(() => {
      events.push('fetch')
      return response.promise
    })
    const lifecycle = createTrajectoryLifecycle(
      {
        env: { AGNES_TRACE_ENDPOINT: 'https://platform.agnes-ai.com/' },
        trajectoryFetch: request as typeof fetch,
        resolve: () => ({ lastSeq: 0, scan: async () => [] }),
      },
      () => invocation(events),
    )
    if (!lifecycle) throw new Error('trajectory lifecycle missing')
    const gate = {
      active: true,
      consent: 'FULL' as const,
      session: ref,
      send: async (value: unknown, sender: (bytes: Uint8Array) => void | Promise<void>) => {
        const bytes = new TextEncoder().encode(String(value))
        await sender(bytes)
        return { bytes }
      },
    }
    const authority = { assert: vi.fn() }

    const result = lifecycle.upload(ref, gate, authority, new AbortController().signal)
    expect(events).toEqual(['acquire'])
    await vi.waitFor(() => expect(events).toEqual(['acquire', 'fetch']))
    expect(events).not.toContain('release')
    response.resolve(new Response('unavailable', { status: 503 }))
    await expect(result).rejects.toThrow('trajectory upload failed: 503')
    expect(events.at(-1)).toBe('release')
  })

  it('rejects a missing session before resolving trajectory context', async () => {
    const resolve = vi.fn(() => ({ lastSeq: 0, scan: async () => [] }))
    const error = Object.assign(new Error('workspace required'), { code: 'E_WORKSPACE_REQUIRED' })
    const lifecycle = createTrajectoryLifecycle(
      { env: { AGNES_TRACE_ENDPOINT: 'https://platform.agnes-ai.com/' }, resolve },
      () => {
        throw error
      },
    )
    if (!lifecycle) throw new Error('trajectory lifecycle missing')

    expect(() => lifecycle.previous(ref, new AbortController().signal)).toThrow(error)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('uploads every row of a session longer than one scan page', async () => {
    const ledger = ledgerDir('scan-trajectory')
    const storage = ledger.open()
    try {
      const { session } = await openOn(storage, { provider: fakeProvider([]) })
      const notes = Array.from({ length: 1_230 }, (_, n) =>
        session.ev('x/agnes/scan-test/note', { n }, { ignorable: true }),
      )
      for (let i = 0; i < notes.length; i += 100) await session.append(notes.slice(i, i + 100))
      let sent = ''
      const lifecycle = createTrajectoryLifecycle(
        {
          env: { AGNES_TRACE_ENDPOINT: 'https://platform.agnes-ai.com/' },
          trajectoryFetch: (async () => new Response('unavailable', { status: 503 })) as typeof fetch,
          resolve: () => session,
        },
        () => invocation([]),
      )
      if (!lifecycle) throw new Error('trajectory lifecycle missing')
      const gate = {
        active: true,
        consent: 'FULL' as const,
        session: ref,
        send: async (value: unknown, sender: (bytes: Uint8Array) => void | Promise<void>) => {
          sent = String(value)
          const bytes = new TextEncoder().encode(sent)
          await sender(bytes)
          return { bytes }
        },
      }
      await expect(
        lifecycle.upload(ref, gate, { assert: vi.fn() }, new AbortController().signal),
      ).rejects.toThrow('trajectory upload failed: 503')
      const lines = sent.trimEnd().split('\n')
      expect(session.lastSeq).toBeGreaterThan(1_200)
      expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual(
        Array.from({ length: session.lastSeq }, (_, i) => i + 1),
      )
    } finally {
      await storage.close()
      ledger.remove()
    }
  }, 60_000)
})
