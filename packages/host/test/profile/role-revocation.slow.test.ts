import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { ApprovalRequest } from '@agnes/core'
import { expect, it, vi } from 'vitest'
import { createTestHost } from '../../testkit/index.js'
import { packageDirs } from '../assemble/plugin-extension-fixture.js'
import { roleHuman, setupRoleEscalation } from './role-escalation-fixture.js'

it.each(
  (['answer', 'effect'] as const).flatMap((boundary) =>
    (['abort', 'close'] as const).map((action) => ({ boundary, action })),
  ),
)(
  'revokes role authority at the final $boundary commit boundary during parent $action',
  async ({ boundary, action }) => {
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
              stopping = action === 'abort' ? fixture.parent.abort(roleHuman) : fixture.parent.close()
              if (action === 'abort') await stopping
              else await vi.waitFor(() => expect(fixture.parent.closingOrClosed).toBe(true))
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
      if (boundary === 'effect')
        expect(
          rows.some((row) => (row.data as { result?: { reason: string } }).result?.reason === 'answered'),
        ).toBe(true)
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

it.each(['abort', 'close'] as const)(
  'an intermediate ancestor %s withdraws the grandchild delivery synchronously',
  async (action) => {
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
      const stopped = action === 'abort' ? ancestor.abort(roleHuman) : ancestor.close()
      if (action === 'abort') expect(delivery.aborted).toBe(true)
      await stopped
      expect(delivery.aborted).toBe(true)
      await running
      expect(existsSync(join(fixture.dataDir, 'grandchild.md'))).toBe(false)
    } finally {
      await running
      await fixture.host.close()
    }
  },
  30000,
)

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

it.each(
  (['close', 'abort'] as const).flatMap((action) =>
    (['answer-first', 'stop-first'] as const).map((order) => ({ action, order })),
  ),
)(
  'review-f1: same-tick human answer and parent $action ($order) withdraw the request',
  async ({ action, order }) => {
    let request!: ApprovalRequest
    let delivery!: AbortSignal
    let release!: () => void
    const fixture = await setupRoleEscalation(async (offered, signal) => {
      request = offered
      delivery = signal
      // Intentionally return a late human answer even if the adapter ignores cancellation.
      return new Promise((resolve) => {
        release = () => resolve({ verdict: 'allowed-once', answeredBy: roleHuman })
      })
    })
    let running: Promise<unknown> | undefined
    let stopping: Promise<unknown> | undefined
    try {
      await fixture.parent.enqueue('next-turn', {
        actor: fixture.parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      running = fixture.parent
        .run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        .catch(() => undefined)
      await vi.waitFor(() => expect(request).toBeDefined())
      if (order === 'answer-first') release()
      stopping = action === 'close' ? fixture.parent.close() : fixture.parent.abort(roleHuman)
      if (order === 'stop-first') release()
      await stopping
      await running
      expect(delivery.aborted).toBe(true)
      expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
      const rows = await fixture.parent.d.log.storage.scan(request.decision!.handle.sessionId!, {
        type: 'decision/state',
        order: 'desc',
        limit: 1,
      })
      const latest = rows[0]!.data as {
        consumption: unknown
        result: { reason: string }
        invalidation: unknown
      }
      expect(latest.consumption).toBeNull()
      expect(latest.result.reason === 'stopped' || latest.invalidation != null).toBe(true)
    } finally {
      release?.()
      await stopping
      await running
      await fixture.host.close()
    }
  },
  30000,
)

it.each(['close', 'abort'] as const)(
  'review-f1: parent %s after effect intent but before runtime dispatch prevents the write',
  async (action) => {
    let reached = false
    let stopping: Promise<unknown> | undefined
    let heldChild: ReturnType<Awaited<ReturnType<typeof setupRoleEscalation>>['host']['kernel']['get']>
    const fixture = await setupRoleEscalation(async (request) => {
      const child = fixture.host.kernel.get(request.decision!.handle.sessionId!)!
      heldChild = child
      const runtime = child.toolRuntime.bind(child)
      vi.spyOn(child, 'toolRuntime').mockImplementation(async () => {
        const result = await runtime()
        if (!reached) {
          reached = true
          stopping = action === 'close' ? fixture.parent.close() : fixture.parent.abort(roleHuman)
          if (action === 'abort') await stopping
          else await vi.waitFor(() => expect(fixture.parent.closingOrClosed).toBe(true))
        }
        return result
      })
      return { verdict: 'allowed-once', answeredBy: roleHuman }
    })
    try {
      await fixture.parent.enqueue('next-turn', {
        actor: fixture.parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      await fixture.parent
        .run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        .catch(() => undefined)
      await stopping
      expect(reached).toBe(true)
      const child = heldChild!
      const rows = await fixture.parent.d.log.storage.scan(child.key, { type: 'decision/state', limit: 100 })
      const decision = rows.at(-1)!.data as { result: { reason: string }; consumption?: { effectId: string } }
      expect(decision.result).toMatchObject({ reason: 'answered', answeredBy: roleHuman })
      expect(decision.consumption?.effectId).toBeTruthy()
      const intents = await fixture.parent.d.log.storage.scan(child.key, {
        type: 'effect/intent',
        limit: 100,
      })
      expect(intents.some((row) => (row.data as { kind: string }).kind === 'tool')).toBe(true)
      expect(child.ac.signal.aborted).toBe(true)
      expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
    } finally {
      vi.restoreAllMocks()
      await stopping
      await fixture.host.close()
    }
  },
  30000,
)

it.each(['pending', 'admitted'] as const)(
  'review-f1: a closed root cannot resurrect an old %s child after cold Host restore',
  async (stage) => {
    let question: ApprovalRequest | undefined
    let delivery: AbortSignal | undefined
    let release: (() => void) | undefined
    const fixture = await setupRoleEscalation(
      async (request, signal) => {
        question = request
        delivery = signal
        return new Promise((resolve) => {
          release = () => resolve({ verdict: 'allowed-once', answeredBy: roleHuman })
          signal.addEventListener('abort', () => resolve({ verdict: 'cancelled', reason: 'stopped' }), {
            once: true,
          })
        })
      },
      {
        calls: (key, step) =>
          key === 'parent' || step
            ? []
            : [{ name: 'write', args: { path: 'closed-epoch.md', content: 'STALE_EPOCH_WRITE' } }],
      },
    )
    let running: Promise<unknown> | undefined
    let restarted: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
    const restoredQuestions: ApprovalRequest[] = []
    try {
      await fixture.parent.enqueue('next-turn', {
        actor: fixture.parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      await fixture.parent.acceptInput()
      const old = await fixture.parent.d.children.createWithKind!('spawn', {
        parent: fixture.parent.key,
        cwd: fixture.dataDir,
        role: fixture.refs[0],
        input: 'Write',
        resident: true,
      })
      if (stage === 'pending') {
        running = old.run('Write').catch(() => undefined)
        await vi.waitFor(() => expect(question).toBeDefined())
      }
      await fixture.parent.close()
      release?.()
      await running
      if (stage === 'pending') expect(delivery?.aborted).toBe(true)
      await expect(old.run('Write')).rejects.toMatchObject({ code: 'E_CLOSED' })
      await fixture.host.close()
      restarted = (
        await createTestHost({
          dataDir: fixture.dataDir,
          packageDirs,
          runtimePluginCatalogue: [fixture.source],
          extensionLoader: { import: async (file) => import(pathToFileURL(file).href) },
          treeBudgetCredits: 100,
          disableSessionTitle: true,
          seams: {
            approval: {
              ask: async (request) => {
                restoredQuestions.push(request)
                return { verdict: 'allowed-once', answeredBy: roleHuman }
              },
            },
          },
          provider: (profile) =>
            new ScriptedProvider({
              models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
              scripts: [
                (request) =>
                  request.sessionKey === 'parent' || request.messages.at(-1)?.role !== 'user'
                    ? [{ type: 'done', reason: 'stop' }]
                    : [
                        {
                          type: 'toolcall_end',
                          via: 'native',
                          call: {
                            toolUseId: '',
                            ordinal: 0,
                            name: 'write',
                            args: { path: 'closed-epoch.md', content: 'STALE_EPOCH_WRITE' },
                          },
                        },
                        { type: 'done', reason: 'toolUse' },
                      ],
              ],
            }),
        })
      ).host
      await restarted.applyRuntimeTarget(fixture.target)
      const root = await restarted.createSession({ key: 'parent', cwd: fixture.dataDir })
      expect(root).not.toBe(fixture.parent)
      const resumed = await root.d.children.resume!(old.key).catch(() => undefined)
      if (resumed)
        await vi.waitFor(
          async () => {
            const status = await resumed.status()
            expect(status.state !== 'running' || status.idle === true).toBe(true)
          },
          { timeout: 10000 },
        )
      expect({
        cards: restoredQuestions.length,
        wrote: existsSync(join(fixture.dataDir, 'closed-epoch.md')),
      }).toEqual({ cards: 0, wrote: false })
      await expect(old.run('Write')).rejects.toMatchObject({ code: 'E_CLOSED' })
    } finally {
      release?.()
      await running
      await restarted?.close()
      await fixture.host.close()
    }
  },
  30000,
)

it('review-f1: a grandchild admitted before middle close cannot start beneath the closed ancestor', async () => {
  const questions: ApprovalRequest[] = []
  const fixture = await setupRoleEscalation(
    async (request) => {
      questions.push(request)
      return { verdict: 'allowed-once', answeredBy: roleHuman }
    },
    {
      nested: true,
      calls: (_key, step) =>
        step ? [] : [{ name: 'write', args: { path: 'closed-middle.md', content: 'Must not write' } }],
    },
  )
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate' }],
    })
    await fixture.parent.acceptInput()
    const first = await fixture.parent.d.children.createWithKind!('spawn', {
      parent: fixture.parent.key,
      cwd: fixture.dataDir,
      role: fixture.refs[0],
      input: 'Middle',
      resident: true,
    })
    const middle = fixture.host.kernel.get(first.key)!
    const second = await middle.d.children.createWithKind!('spawn', {
      parent: middle.key,
      cwd: fixture.dataDir,
      role: fixture.refs[1]!,
      input: 'Grandchild',
      resident: true,
    })
    await middle.close()
    expect(fixture.parent.closingOrClosed).toBe(false)
    await expect(second.run('Grandchild')).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect(questions).toEqual([])
    expect(existsSync(join(fixture.dataDir, 'closed-middle.md'))).toBe(false)
  } finally {
    await fixture.host.close()
  }
}, 30000)
