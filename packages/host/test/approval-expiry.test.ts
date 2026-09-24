import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApprovalRequest, Pending, Verdict } from '@agnes/core'
import { approvalDeadlineMs, initialState, type LedgerState } from '@agnes/core'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startApprovalExpiry } from '../src/approval-expiry.js'
import { createTestHost } from '../testkit/index.js'

type PendingApproval = LedgerState['pendingApprovals'] extends ReadonlyMap<string, infer V> ? V : never

const toolCall = (command: string): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    via: 'native',
    call: { toolUseId: '', name: 'shell', args: { command }, ordinal: 0 },
  },
  { type: 'done', reason: 'toolUse' },
]

describe('Host approval expiry lifecycle', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('expires a real parked tool approval once, projects expired, and never executes the tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-host-expiry-'))
    roots.push(root)
    const marker = join(root, 'must-not-run')
    const ticket = 'host-expiry-ticket'
    const { host } = await createTestHost({
      dataDir: root,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
      script: [toolCall(`touch ${marker}`)],
      seams: {
        approval: {
          ask: async (_request: ApprovalRequest): Promise<Verdict | Pending> => ({
            ticket,
            // Compute this after assembly so the parked state is observable before the scheduler's
            // bounded idle wake-up settles it.
            expiresAt: new Date(Date.now() + 150).toISOString(),
          }),
          resume: async () => null,
        },
      },
    })

    try {
      const session = await host.createSession({ cwd: root })
      await session.enqueue('next-turn', {
        actor: session.d.actor,
        content: [{ type: 'text', text: 'run the command' }],
      })
      await expect(
        session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).resolves.toMatchObject({ reason: 'parked' })
      expect(session.state.pendingApprovals.size).toBe(1)

      await vi.waitFor(
        async () => {
          const rows = await session.scan({ type: 'approval/decided', toSeq: session.lastSeq })
          expect(rows).toHaveLength(1)
          expect(rows[0]?.data).toMatchObject({ verdict: 'rejected', via: 'timeout', ticket })
        },
        { timeout: 2_000, interval: 20 },
      )
      const timeline = await session.projectUI(undefined, { surface: 'web' })
      expect(timeline.nodes).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'approval', state: 'expired' })]),
      )
      expect(timeline.opState).toBeNull()
      await expect(session.resumeApproval(ticket, 'allowed-once', session.d.actor)).rejects.toThrow(
        /ticket unavailable|ticket expired/,
      )
      expect(existsSync(marker)).toBe(false)

      const lastSeq = session.lastSeq
      await session.close()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(session.lastSeq).toBe(lastSeq)
    } finally {
      await host.close()
    }
  })

  it('serializes a slow storage retry and clears the scheduled wake-up on close', async () => {
    const now = Date.now()
    const queued: Array<{ fn: () => void; ms: number }> = []
    const cleared: unknown[] = []
    const timers = {
      setTimeout(fn: () => void, ms: number) {
        const handle = { fn, ms }
        queued.push(handle)
        return handle
      },
      clearTimeout(handle: unknown) {
        cleared.push(handle)
        const index = queued.indexOf(handle as (typeof queued)[number])
        if (index >= 0) queued.splice(index, 1)
      },
    }
    // A writable stand-in for the session's pending approvals, which the fold never changes in place.
    const pendingApprovals = new Map<string, PendingApproval>()
    const state = { ...initialState(), pendingApprovals }
    pendingApprovals.set('request', {
      requestId: 'request',
      kind: 'tool',
      summary: 'test',
      risk: 'always',
      bindingHash: '0'.repeat(64),
      pending: { ticket: 'ticket', expiresAt: new Date(now + 10).toISOString() },
      seq: 1,
      lane: 'main',
    })
    let calls = 0
    let active = 0
    let maximumActive = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let releaseClosing!: () => void
    const closingWrite = new Promise<void>((resolve) => {
      releaseClosing = resolve
    })
    const errors: unknown[] = []
    let asked: (() => void) | undefined
    const log = {
      observeCommitted(_types: readonly string[], notify: () => void) {
        asked = notify
        return () => {
          asked = undefined
        }
      },
    }
    const session = {
      key: 'agnes:test',
      lane: 'main',
      state,
      d: { clock: () => now, timers, log },
      async expireApprovals() {
        calls++
        active++
        maximumActive = Math.max(maximumActive, active)
        try {
          if (calls === 2) {
            await blocked
            throw new Error('storage unavailable')
          }
          if (calls === 3) {
            pendingApprovals.clear()
            return 1
          }
          if (calls === 4) await closingWrite
          return 0
        } finally {
          active--
        }
      },
    } as Parameters<typeof startApprovalExpiry>[0]
    const controller = await startApprovalExpiry(session, {
      onError: (error) => {
        errors.push(error)
        throw new Error('diagnostic sink unavailable')
      },
    })
    expect(calls).toBe(1)
    expect(queued).toHaveLength(1)

    const first = queued.shift()
    if (!first) throw new Error('missing first wake-up')
    first.fn()
    // A duplicate callback cannot overlap the first storage operation, even if a timer source fires
    // it twice. The operation is deliberately held until after this assertion.
    first.fn()
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(maximumActive).toBe(1)
    release()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(queued[0]?.ms).toBe(100)

    const retry = queued.shift()
    if (!retry) throw new Error('missing retry wake-up')
    retry.fn()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(calls).toBe(3)
    expect(maximumActive).toBe(1)
    // Nothing is pending any more, so nothing is scheduled until a new approval is asked.
    expect(queued).toHaveLength(0)
    pendingApprovals.set('again', {
      requestId: 'again',
      kind: 'tool',
      summary: 'test',
      risk: 'always',
      bindingHash: '0'.repeat(64),
      pending: { ticket: 'again', expiresAt: new Date(now + 10).toISOString() },
      seq: 2,
      lane: 'main',
    })
    asked?.()
    const next = queued.shift()
    if (!next) throw new Error('missing wake-up for the new approval')
    next.fn()
    await Promise.resolve()
    expect(calls).toBe(4)
    let closed = false
    const closing = controller.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    releaseClosing()
    await closing
    expect(queued).toHaveLength(0)

    pendingApprovals.clear()
    const idleController = await startApprovalExpiry({ ...session, expireApprovals: async () => 0 })
    expect(queued).toHaveLength(0)
    await idleController.close()
    expect(queued).toHaveLength(0)
    expect(asked).toBeUndefined()
  })

  it('releases the opened writer when initial expiry fails before returning a Host session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-host-expiry-failure-'))
    roots.push(root)
    const first = await createTestHost({ dataDir: root })
    const open = first.host.kernel.session.bind(first.host.kernel)
    let captured: Awaited<ReturnType<typeof open>> | undefined
    const hook = vi.spyOn(first.host.kernel, 'session').mockImplementation(async (...args) => {
      const session = await open(...args)
      captured = session
      session.expireApprovals = async () => {
        throw new Error('expiry storage unavailable')
      }
      return session
    })
    try {
      await expect(first.host.createSession({ cwd: root })).rejects.toThrow('expiry storage unavailable')
      expect(captured?.closingOrClosed).toBe(true)
      // The failed opener still exists, but another real Host can acquire the same writer lease.
      const second = await createTestHost({ dataDir: root })
      try {
        const recovered = await second.host.createSession({ cwd: root })
        expect(recovered.key).toBe(captured?.key)
      } finally {
        await second.host.close()
      }
    } finally {
      hook.mockRestore()
      await first.host.close()
    }
  })

  it('settles an already-expired persisted ticket before a reopened Host session is returned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-host-expiry-reopen-'))
    roots.push(root)
    const ticket = 'reopen-expiry-ticket'
    const first = await createTestHost({ dataDir: root })
    await first.host.createSession({ cwd: root }).then(async (session) => {
      await session.append([
        session.ev('approval/asked', {
          requestId: 'reopen-expiry-request',
          kind: 'tool',
          summary: 'expired persisted request',
          risk: 'destructive',
          bindingHash: '0'.repeat(64),
          pending: { ticket, expiresAt: new Date(Date.now() - 1).toISOString() },
        }),
      ])
      expect(await session.scan({ type: 'approval/decided', toSeq: session.lastSeq })).toHaveLength(0)
      await session.close()
    })
    await first.host.close()

    const second = await createTestHost({ dataDir: root })
    try {
      const session = await second.host.createSession({ cwd: root })
      expect(session.state.pendingApprovals.size).toBe(0)
      const rows = await session.scan({ type: 'approval/decided', toSeq: session.lastSeq })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.data).toMatchObject({ ticket, via: 'timeout', verdict: 'rejected' })
      await expect(
        session.resumeApproval(ticket, 'allowed-once', { ...session.d.actor, id: 'approver' }),
      ).rejects.toThrow(/ticket unavailable|ticket expired/)
      await session.close()
    } finally {
      await second.host.close()
    }
  })
})

describe('approval expiry wakes only for a pending deadline', () => {
  function fakeSession(now: number) {
    const queued: Array<{ fn: () => void; ms: number }> = []
    const timers = {
      setTimeout(fn: () => void, ms: number) {
        const handle = { fn, ms }
        queued.push(handle)
        return handle
      },
      clearTimeout(handle: unknown) {
        const index = queued.indexOf(handle as (typeof queued)[number])
        if (index >= 0) queued.splice(index, 1)
      },
    }
    const observers = new Set<{ types: readonly string[]; notify: () => void }>()
    // A writable stand-in for the session's pending approvals, which the fold never changes in place.
    const pendingApprovals = new Map<string, PendingApproval>()
    const state = { ...initialState(), pendingApprovals }
    let calls = 0
    const session = {
      key: 'agnes:test',
      lane: 'main',
      state,
      d: {
        clock: () => now,
        timers,
        log: {
          observeCommitted(types: readonly string[], notify: () => void) {
            const observer = { types, notify }
            observers.add(observer)
            return () => void observers.delete(observer)
          },
        },
      },
      async expireApprovals() {
        calls++
        return 0
      },
    } as unknown as Parameters<typeof startApprovalExpiry>[0]
    const ask = (expiresAt: string, lane = 'main') => {
      pendingApprovals.set(`request:${expiresAt}`, {
        requestId: `request:${expiresAt}`,
        kind: 'tool',
        summary: 'test',
        risk: 'always',
        bindingHash: '0'.repeat(64),
        pending: { ticket: `ticket:${expiresAt}`, expiresAt },
        seq: 1,
        lane,
      })
      for (const o of observers) if (o.types.includes('approval/asked')) o.notify()
    }
    return { session, queued, observers, ask, calls: () => calls }
  }

  it('sets no timer while nothing is pending', async () => {
    const f = fakeSession(Date.now())
    const controller = await startApprovalExpiry(f.session)
    expect(f.calls()).toBe(1)
    expect(f.queued).toEqual([])
    await controller.close()
  })

  it('wakes at the deadline of an approval asked after start, capped at 30 s', async () => {
    const now = Date.now()
    const f = fakeSession(now)
    const controller = await startApprovalExpiry(f.session)
    f.ask(new Date(now + 5_000).toISOString())
    expect(f.queued.map((q) => q.ms)).toEqual([5_000])
    f.ask(new Date(now + 1_000).toISOString())
    expect(f.queued.map((q) => q.ms)).toEqual([1_000])
    await controller.close()
    const far = fakeSession(now)
    const second = await startApprovalExpiry(far.session)
    far.ask(new Date(now + 600_000).toISOString())
    expect(far.queued.map((q) => q.ms)).toEqual([30_000])
    await second.close()
  })

  it('treats a deadline core cannot read as already due, exactly where core does', async () => {
    const now = Date.now()
    for (const value of [
      'not a date',
      // Future dates that Date.parse reads but core does not: a bare parse would wait 30 s here.
      '2099-01-01',
      'Thu, 01 Jan 2099 00:00:00 GMT',
      new Date(now + 2_000).toISOString().replace('Z', '+00:00'),
    ]) {
      const f = fakeSession(now)
      const controller = await startApprovalExpiry(f.session)
      f.ask(value)
      const deadline = approvalDeadlineMs(value)
      const expected = Number.isNaN(deadline) ? 10 : Math.max(10, Math.min(30_000, deadline - now))
      expect({ value, ms: f.queued.map((q) => q.ms) }).toEqual({ value, ms: [expected] })
      await controller.close()
    }
  })

  it('stops observing new approvals on close', async () => {
    const f = fakeSession(Date.now())
    const controller = await startApprovalExpiry(f.session)
    expect(f.observers.size).toBe(1)
    await controller.close()
    expect(f.observers.size).toBe(0)
  })
})
