import { describe, expect, it, vi } from 'vitest'
import { WorkerRegistry } from '../src/supervisor/registry.js'
import { wireResourceSnapshotNotifications } from '../src/supervisor/supervisor.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'
import { workspaceBinding } from './workspace-authority.js'

/**
 * Task 5 (resource-live-reload plan) wiring, narrowed by Task 7: the daemon's one hook for "a
 * resource-control mutation durably committed" (resource-control-store's
 * `setSuccessfulSnapshotHandler`, called only after a successful effect's latest worker snapshot and
 * terminal operation commit) sends every still-live session worker the new lightweight `resource.stale`
 * command (@agnes/resource-control-runtime's `notifyLiveSessionWorkers`) so it picks up the change
 * in place at its next turn boundary. Task 5 originally paired this with the daemon's pre-existing
 * `registry.retireForResourceSnapshot()` (2026-09-14, predates this plan), which unconditionally kills
 * and respawns *every* session's worker regardless of whether its lightweight notification actually
 * delivered. Task 7's investigation (see task-7-report.md) found that heavyweight retirement provides
 * no coverage the lightweight path lacks for a session whose notification succeeded - it only matters
 * as a fallback for a session whose notification genuinely failed to deliver. So this handler no longer
 * calls `retireForResourceSnapshot()` at all; it calls the narrower `registry.retireSessions()` only
 * for the session keys `notifyLiveSessionWorkers()` reports as failed.
 */
describe('wireResourceSnapshotNotifications', () => {
  it('does not retire any session when every lightweight notification is delivered successfully', async () => {
    let registeredHandler: ((profile: string) => void) | undefined
    const localResourceStore = {
      setSuccessfulSnapshotHandler(handler: (profile: string) => void) {
        registeredHandler = handler
      },
    }
    const retiredKeys: string[] = []
    let commits = 0
    const registry = {
      retireForResourceSnapshot: () => {
        throw new Error('retireForResourceSnapshot must not be called by this wiring anymore')
      },
      noteResourceSnapshotCommitted: () => {
        commits++
      },
      retireSessions: (keys: readonly string[]) => retiredKeys.push(...keys),
    }
    const notified: string[] = []
    const pool = {
      activationLinks: () => [
        {
          sessionKey: 's1',
          generation: 1,
          link: {
            command: async (method: string) => {
              notified.push(method)
              return {}
            },
          },
        },
      ],
    }
    wireResourceSnapshotNotifications({ localResourceStore, registry, pool })
    expect(registeredHandler).toBeDefined()
    registeredHandler?.('local-dev')
    // The notification (and the retire-on-failure follow-up) is fire-and-forget (async, not awaited
    // by the synchronous handler) - give its microtasks a turn before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notified).toEqual(['resource.stale'])
    expect(retiredKeys).toEqual([])
    // Retiring nobody is not the same as ignoring the commit: the epoch fence still has to advance.
    expect(commits).toBe(1)
  })

  // Deliberately built on the REAL WorkerRegistry, not a fake: the two tests that already covered the
  // halves of this (registry.test.ts's "retireSessions still bumps the resource epoch", which calls
  // retireSessions directly and so bypasses this wiring entirely, and the all-delivered case above,
  // whose fake registry has no epoch at all) were both green while the composed behavior was broken.
  // Task 7 narrowed retirement to failed keys only, which also moved the epoch bump behind
  // `failedKeys.length > 0` - so on the common path where every notification is delivered, the fence
  // that discards a worker caught mid-`acquire()` by a snapshot commit stopped advancing.
  it('advances the resource epoch on a fully delivered notification round, fencing out a worker that was mid-acquire', async () => {
    let registeredHandler: ((profile: string) => void) | undefined
    const localResourceStore = {
      setSuccessfulSnapshotHandler(handler: (profile: string) => void) {
        registeredHandler = handler
      },
    }
    const link = (token: string) => ({
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token,
        sessionKey: 'opening-session',
        writerRunId: token,
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: vi.fn(),
    })
    let releaseFirstAcquire: ((link: unknown) => void) | undefined
    const heldAcquire = new Promise<unknown>((resolve) => {
      releaseFirstAcquire = resolve
    })
    const initial = link('old-generation')
    const replacement = link('new-generation')
    let acquireCalls = 0
    const retire = vi.fn()
    const notified: string[] = []
    const pool = {
      acquire: vi.fn(async () => (++acquireCalls === 1 ? heldAcquire : replacement)),
      retire,
      // Every live worker answers the notice, so `failedKeys` is empty - the exact shape that used to
      // skip the epoch bump entirely.
      activationLinks: () => [
        {
          sessionKey: 'already-live-session',
          generation: 1,
          link: {
            command: async (method: string) => {
              notified.push(method)
              return {}
            },
          },
        },
      ],
    }
    const registry = new WorkerRegistry(pool as unknown as WorkerPool)
    wireResourceSnapshotNotifications({
      localResourceStore,
      registry,
      pool,
    })

    // A worker that is already opening when the snapshot commits: spawned, snapshot file read, no
    // hello yet, so it appears in no activation link list and can be in neither the delivered nor the
    // failed set.
    const binding = await workspaceBinding('opening-session')
    const opening = registry.open({
      key: 'opening-session',
      cwd: '/workspace',
      binding,
      resume: true,
    })
    await Promise.resolve()

    registeredHandler?.('local-dev')
    // The notice (and anything chained onto it) is fire-and-forget; let its microtasks run first so
    // this asserts the committed end state, not a mid-flight one.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notified).toEqual(['resource.stale'])

    releaseFirstAcquire?.(initial)
    const opened = await opening

    // The old-snapshot generation was never published; the caller got a replacement acquired after
    // the commit. Without the epoch bump this resolves to 'old-generation' with a single acquire.
    expect(opened.session.writerRunId).toBe('new-generation')
    expect(pool.acquire).toHaveBeenCalledTimes(2)
    expect(retire).toHaveBeenCalledWith(['opening-session'], 'resource-snapshot-reload')
    // And the narrowing Task 7 introduced still holds: no live session was retired for notify failure.
    expect(retire.mock.calls.map((call) => call[1])).toEqual(['resource-snapshot-reload'])
  })

  it('only retires sessions whose lightweight notification actually failed to deliver', async () => {
    let registeredHandler: ((profile: string) => void) | undefined
    const localResourceStore = {
      setSuccessfulSnapshotHandler(handler: (profile: string) => void) {
        registeredHandler = handler
      },
    }
    const retiredKeys: string[] = []
    const retiredReasons: string[] = []
    const registry = {
      retireForResourceSnapshot: () => {
        throw new Error('retireForResourceSnapshot must not be called by this wiring anymore')
      },
      noteResourceSnapshotCommitted: () => undefined,
      retireSessions: (keys: readonly string[], reason: string) => {
        retiredKeys.push(...keys)
        retiredReasons.push(reason)
      },
    }
    const pool = {
      activationLinks: () => [
        { sessionKey: 'ok-session', generation: 1, link: { command: async () => ({}) } },
        {
          sessionKey: 'dead-session',
          generation: 1,
          link: { command: async () => Promise.reject(new Error('timeout')) },
        },
      ],
    }
    wireResourceSnapshotNotifications({ localResourceStore, registry, pool, log: { warn: () => undefined } })
    registeredHandler?.('local-dev')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(retiredKeys).toEqual(['dead-session'])
    expect(retiredReasons).toEqual(['resource-notify-failed'])
  })

  it('does not let a failed per-worker notification stop the rest of the notice or throw out of the handler', async () => {
    let registeredHandler: ((profile: string) => void) | undefined
    const localResourceStore = {
      setSuccessfulSnapshotHandler(handler: (profile: string) => void) {
        registeredHandler = handler
      },
    }
    const retiredKeys: string[] = []
    const registry = {
      noteResourceSnapshotCommitted: () => undefined,
      retireSessions: (keys: readonly string[]) => retiredKeys.push(...keys),
    }
    const notified: string[] = []
    const pool = {
      activationLinks: () => [
        {
          sessionKey: 'bad',
          generation: 1,
          link: { command: async () => Promise.reject(new Error('boom')) },
        },
        {
          sessionKey: 'good',
          generation: 1,
          link: {
            command: async (method: string) => {
              notified.push(method)
              return {}
            },
          },
        },
      ],
    }
    const warnings: unknown[] = []
    wireResourceSnapshotNotifications({
      localResourceStore,
      registry,
      pool,
      log: { warn: (...a) => warnings.push(a) },
    })
    expect(() => registeredHandler?.('local-dev')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notified).toEqual(['resource.stale'])
    expect(warnings).toHaveLength(1)
    expect(retiredKeys).toEqual(['bad'])
  })
})
