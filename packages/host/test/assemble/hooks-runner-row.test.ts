import { fileURLToPath } from 'node:url'
import type { HookEvent, HookReturnMap } from '@agnes/extension-api'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import { auditKinds, pluginRow, pluginSource, scratch, settle, targetOf } from './plugin-extension-fixture.js'

const packageDirs = {
  '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)),
  '@agnes/code': fileURLToPath(new URL('../../../code', import.meta.url)),
}
const say = (text: string): InferenceEvent[] => [{ type: 'text_delta', delta: text }]
const ID = 'agnes/hooks-runner'

/** Stands in for the sandboxed child: every start, hook call and close is recorded in one timeline. */
function fakeIsolation(events: HookEvent[] = ['shutdown', 'before_step']) {
  const timeline: string[] = []
  let started = 0
  const failures: Array<{ pid: number; listener: (error: Error) => void }> = []
  // Per-pid shutdown gates: absent by default (falls back to a fixed 30ms delay, as before). A test
  // that needs deterministic control over exactly when a generation's shutdown dispatch resolves —
  // to hold it open while a successor becomes live — arms one with `holdShutdown(pid)`.
  const shutdownGates = new Map<number, { promise: Promise<void>; resolve: () => void }>()
  return {
    timeline,
    started: () => started,
    /** Crashes the latest generation's listener, or a specific one by pid. */
    crash: (error: Error, pid?: number) => {
      const entry = pid === undefined ? failures.at(-1) : failures.find((f) => f.pid === pid)
      entry?.listener(error)
    },
    holdShutdown: (pid: number) => {
      let resolve!: () => void
      const promise = new Promise<void>((r) => {
        resolve = r
      })
      shutdownGates.set(pid, { promise, resolve })
    },
    releaseShutdown: (pid: number) => shutdownGates.get(pid)?.resolve(),
    services: {
      prepareRuntime: () => ({
        backend: 'seatbelt' as const,
        runtime: {
          source: 'bundled' as const,
          executable: '/release/node',
          runner: '/release/hooks-runner.mjs',
          readPaths: ['/release'],
          runnerSha256: '0'.repeat(64),
        },
      }),
      startRunner: async () => {
        const pid = 4000 + ++started
        timeline.push(`start:${pid}`)
        return {
          pid,
          events,
          onFailure(listener: (error: Error) => void) {
            failures.push({ pid, listener })
            return () => {}
          },
          invoke: async <E extends HookEvent>(event: E) => {
            // A child takes time to answer; recorded on completion so an early close shows up.
            if (event === 'shutdown') {
              const gate = shutdownGates.get(pid)
              if (gate) await gate.promise
              else await new Promise((resolve) => setTimeout(resolve, 30))
            }
            timeline.push(`invoke:${event}:${pid}`)
            return { block: false } as HookReturnMap[E]
          },
          close: async () => {
            timeline.push(`close:${pid}`)
          },
        }
      },
    },
  }
}

const status = (h: { host: { extensions(): { id: string }[] } }) =>
  h.host.extensions().find((e) => e.id === ID) as
    | { loaded: boolean; isolation?: Record<string, unknown>; error?: { code: string } }
    | undefined

describe('hooks-runner as a row, isolated', () => {
  it('starts the child, lists its isolation, and on close sends it shutdown before closing it', async () => {
    const fake = fakeIsolation()
    const dataDir = scratch()
    const h = await createTestHost({
      dataDir,
      packageDirs,
      script: [say('hi')],
      extensionIsolation: { extensions: { [ID]: 'required' } },
      extensionIsolationServices: fake.services,
    })
    expect(status(h)).toMatchObject({
      loaded: true,
      isolation: { mode: 'required', backend: 'seatbelt', fallback: false, pid: 4001, protocol: 1 },
    })
    await h.host.createSession({ cwd: dataDir })
    await h.host.close()
    const own = fake.timeline.filter((entry) => entry !== 'invoke:before_step:4001')
    expect(own.indexOf('invoke:shutdown:4001')).toBeGreaterThan(-1)
    expect(own.indexOf('invoke:shutdown:4001')).toBeLessThan(own.indexOf('close:4001'))
    expect(own.filter((entry) => entry === 'close:4001')).toHaveLength(1)
    expect(
      auditKinds(h as never, 'extension.revoked').filter((event) => event.detail?.id === ID),
    ).toHaveLength(1)
    expect(auditKinds(h as never, 'extension.revoke_failed')).toEqual([])
    expect(h.host.kernel.registrations(ID)).toEqual([])
  })

  it('reports a child crash as a failed listing and releases the child once', async () => {
    const fake = fakeIsolation()
    const h = await createTestHost({
      dataDir: scratch(),
      packageDirs,
      extensionIsolation: { extensions: { [ID]: 'required' } },
      extensionIsolationServices: fake.services,
    })
    fake.crash(new Error('child crashed'))
    await settle()
    expect(status(h)).toMatchObject({ loaded: false, error: { code: 'E_EXT_LOAD' } })
    expect(h.host.kernel.registrations(ID)).toEqual([])
    expect(fake.timeline.filter((entry) => entry === 'close:4001')).toHaveLength(1)
    expect(
      auditKinds(h as never, 'extension.failed').filter((event) => event.detail?.id === ID),
    ).toHaveLength(1)
    await h.host.close()
    // The listing was already a failure: closing must not report it as a revocation.
    expect(
      auditKinds(h as never, 'extension.revoked').filter((event) => event.detail?.id === ID),
    ).toHaveLength(0)
    expect(fake.timeline.filter((entry) => entry === 'close:4001')).toHaveLength(1)
  })

  it('replaces the child when the tree is rebuilt: an open session is told first, then the old one closes', async () => {
    const fake = fakeIsolation()
    const dataDir = scratch()
    const source = pluginSource(`agnes.registerTool(tool('unrelated_tool'))`, 'plugin', 'ext:acme/x')
    const h = await createTestHost({
      dataDir,
      packageDirs,
      script: [say('hi')],
      runtimePluginCatalogue: [source],
      extensionLoader: {
        import: async (file) => (await import(`file://${file}`)) as Record<string, unknown>,
      },
      extensionIsolation: { extensions: { [ID]: 'required' } },
      extensionIsolationServices: fake.services,
    })
    expect(fake.started()).toBe(1)
    const session = await h.host.createSession({ cwd: dataDir })
    // A delivery only moves the rows that changed, so the child is replaced by giving this row a
    // new identity; an unrelated row no longer restarts it.
    await h.host.extensionRows.apply([
      h.host.extensionRows.prepare({ extensionId: ID, entryRevision: 'hooks-runner-row-r2' }),
    ])
    await settle()
    expect(fake.started()).toBe(2)
    expect(status(h)).toMatchObject({ loaded: true, isolation: { pid: 4002 } })
    const closed = fake.timeline.filter((entry) => entry.startsWith('close:'))
    expect(closed).toEqual(['close:4001'])
    const told = fake.timeline.indexOf('invoke:shutdown:4001')
    expect(told).toBeGreaterThan(-1)
    expect(told).toBeLessThan(fake.timeline.indexOf('close:4001'))
    expect(
      h.host.kernel.hooks
        .snapshot()
        .entries('before_step')
        .filter((entry) => entry.meta.source === ID),
    ).toHaveLength(1)
    await session.close()
    await h.host.close()
    expect(fake.timeline.filter((entry) => entry.startsWith('close:')).sort()).toEqual([
      'close:4001',
      'close:4002',
    ])
    expect(auditKinds(h as never, 'extension.revoke_failed')).toEqual([])
  })

  // Two runner generations plus a held shutdown: over a second on macOS, past 5 s on the Windows runner.
  it('ignores a crash reported by an already-evicted generation and keeps the live successor', async () => {
    // Regression: eviction does not wait for the incumbent's shutdown dispatch to finish (it just
    // starts winding down in the background), so a stale generation's own crash listener stays armed
    // after a successor is already live. Held here deterministically instead of racing a fixed delay.
    const fake = fakeIsolation()
    fake.holdShutdown(4001)
    const dataDir = scratch()
    const source = pluginSource(`agnes.registerTool(tool('unrelated_tool'))`, 'plugin', 'ext:acme/x')
    const h = await createTestHost({
      dataDir,
      packageDirs,
      script: [say('hi')],
      runtimePluginCatalogue: [source],
      extensionLoader: {
        import: async (file) => (await import(`file://${file}`)) as Record<string, unknown>,
      },
      extensionIsolation: { extensions: { [ID]: 'required' } },
      extensionIsolationServices: fake.services,
    })
    expect(fake.started()).toBe(1)
    const session = await h.host.createSession({ cwd: dataDir })
    await h.host.extensionRows.apply([
      h.host.extensionRows.prepare({ extensionId: ID, entryRevision: 'hooks-runner-row-r2' }),
    ])
    await settle()
    // Generation 2 (pid 4002) is live. Generation 1 (pid 4001) is evicted but stuck inside its own
    // shutdown dispatch (held above), so its failure listener has not been torn down yet.
    expect(fake.started()).toBe(2)
    expect(status(h)).toMatchObject({ loaded: true, isolation: { pid: 4002 } })
    fake.crash(new Error('stale child crashed'), 4001)
    await settle()
    expect(status(h)).toMatchObject({ loaded: true, isolation: { pid: 4002 } })
    expect(
      h.host.kernel.hooks
        .snapshot()
        .entries('before_step')
        .filter((entry) => entry.meta.source === ID),
    ).toHaveLength(1)
    expect(
      auditKinds(h as never, 'extension.failed').filter((event) => event.detail?.id === ID),
    ).toHaveLength(0)
    fake.releaseShutdown(4001)
    await session.close()
    await h.host.close()
    expect(fake.timeline.filter((entry) => entry.startsWith('close:')).sort()).toEqual([
      'close:4001',
      'close:4002',
    ])
  }, 30_000)
})

describe('hooks-runner as a row, isolation unavailable', () => {
  // Two Hosts assembled from the packages on disk: 3 to 5 s on the Windows runner.
  it('leaves required unloaded with an isolation note and Host up; preferred falls back in-process', async () => {
    const required = await createTestHost({
      dataDir: scratch(),
      packageDirs,
      extensionIsolation: { extensions: { [ID]: 'required' } },
      extensionIsolationServices: {
        prepareRuntime: () => {
          throw new Error('backend absent')
        },
      },
    })
    expect(status(required)).toMatchObject({
      loaded: false,
      isolation: { mode: 'required', backend: 'unavailable', fallback: false },
      error: { code: 'E_EXT_ISOLATION_UNAVAILABLE' },
    })
    expect(required.host.kernel.registrations(ID)).toEqual([])
    await required.host.close()

    const preferred = await createTestHost({
      dataDir: scratch(),
      packageDirs,
      extensionIsolation: { extensions: { [ID]: 'preferred' } },
      extensionIsolationServices: {
        prepareRuntime: () => {
          throw new Error('backend absent')
        },
      },
    })
    expect(status(preferred)).toMatchObject({
      loaded: true,
      isolation: { mode: 'preferred', backend: 'in-process', fallback: true },
    })
    expect(preferred.host.kernel.registrations(ID).length).toBeGreaterThan(0)
    await preferred.host.close()
  }, 30_000)
})
