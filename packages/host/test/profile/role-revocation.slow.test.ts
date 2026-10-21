import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest } from '@agnes/core'
import { expect, it, vi } from 'vitest'
import { roleHuman, setupRoleEscalation } from './role-escalation-fixture.js'

it.each(['answer', 'effect'] as const)(
  'revokes role authority at the final %s commit boundary',
  async (boundary) => {
    let childKey = ''
    let reached = false
    let stopping: Promise<unknown> | undefined
    const fixture = await setupRoleEscalation(async (request) => {
      childKey = request.decision!.handle.sessionId!
      const child = fixture.host.kernel.get(childKey)!
      const append = child.d.log.append.bind(child.d.log)
      vi.spyOn(child.d.log, 'append').mockImplementation((events, options) =>
        append(events, {
          ...options,
          beforeCommit: async () => {
            await options?.beforeCommit?.()
            const target = events.some((row) =>
              boundary === 'effect'
                ? row.type === 'effect/intent'
                : row.type === 'decision/state' &&
                  (row.data as { result?: { reason: string } }).result?.reason === 'answered',
            )
            if (target && !reached) {
              reached = true
              stopping = fixture.parent.abort(roleHuman)
              await stopping
            }
          },
        }),
      )
      return { verdict: 'allowed-once', answeredBy: roleHuman }
    })
    try {
      await fixture.parent.enqueue('next-turn', {
        actor: fixture.parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      await stopping
      expect(reached).toBe(true)
      expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
      const rows = await fixture.parent.d.log.storage.scan(childKey, { type: 'decision/state', limit: 100 })
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => (row.data as { consumption: unknown }).consumption === null)).toBe(true)
      const intents = await fixture.parent.d.log.storage.scan(childKey, { type: 'effect/intent', limit: 100 })
      expect(intents.filter((row) => (row.data as { kind: string }).kind === 'tool')).toEqual([])
      const current = rows.at(-1)!.data as { result: { reason: string }; invalidation: unknown }
      expect(current.result.reason === 'stopped' || current.invalidation != null).toBe(true)
    } finally {
      vi.restoreAllMocks()
      await stopping
      await fixture.host.close()
    }
  },
  30000,
)

it('an intermediate ancestor stop withdraws the grandchild delivery synchronously', async () => {
  let offered!: ApprovalRequest
  let delivery!: AbortSignal
  const fixture = await setupRoleEscalation(
    async (request, signal) => {
      offered = request
      delivery = signal
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ verdict: 'cancelled', reason: 'stopped' }), {
          once: true,
        })
      })
    },
    {
      nested: true,
      calls: (key, step) =>
        step
          ? []
          : key.split('/').length < 3
            ? [
                {
                  name: 'subagent_spawn',
                  args: { role: '@fixture/escalation#role0', task: 'Delegate', wait: true },
                },
              ]
            : [{ name: 'write', args: { path: 'grandchild.md', content: 'Must not write' } }],
    },
  )
  let running: Promise<unknown> | undefined
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate' }],
    })
    running = fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    await vi.waitFor(() => expect(offered).toBeDefined())
    const ancestor = fixture.host.kernel.get(offered.delegation!.parentSessionKey)!
    const stopped = ancestor.abort(roleHuman)
    expect(delivery.aborted).toBe(true)
    await stopped
    await running
    expect(existsSync(join(fixture.dataDir, 'grandchild.md'))).toBe(false)
  } finally {
    await running
    await fixture.host.close()
  }
}, 30000)

it('a new root run cannot renew a previously admitted role handle', async () => {
  const questions: ApprovalRequest[] = []
  const fixture = await setupRoleEscalation(
    async (request) => {
      questions.push(request)
      return { verdict: 'allowed-once', answeredBy: roleHuman }
    },
    {
      calls: (key, step) =>
        key === 'parent' || step
          ? []
          : [{ name: 'write', args: { path: 'fresh.md', content: 'Fresh admission' } }],
    },
  )
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate' }],
    })
    await fixture.parent.acceptInput()
    const open = (input: string) =>
      fixture.parent.d.children.createWithKind!('spawn', {
        parent: 'parent',
        cwd: fixture.dataDir,
        role: fixture.refs[0],
        input,
        resident: true,
      })
    const old = await open('Write')
    await fixture.parent.abort(roleHuman)
    await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    await fixture.parent.run({ until: 'idle', signal: AbortSignal.timeout(15000) })
    await expect(old.run('Write')).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect(questions).toHaveLength(0)
    expect(existsSync(join(fixture.dataDir, 'fresh.md'))).toBe(false)
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'A fresh delegation from untrusted evidence' }],
    })
    await fixture.parent.acceptInput()
    const fresh = await open('Fresh write')
    expect(fresh.key).not.toBe(old.key)
    await fresh.run('Fresh write')
    expect(questions).toHaveLength(1)
    expect(existsSync(join(fixture.dataDir, 'fresh.md'))).toBe(true)
  } finally {
    await fixture.host.close()
  }
}, 30000)
