import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { DecisionSnapshot, ToolMeta } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { approveMemoryFile } from '../src/execution/turn/memory-approval.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, shellTool } from './helpers/open-session.js'

async function parked(profileHash: string | null = null) {
  let now = 1_757_203_200_000
  let executions = 0
  const seen: DecisionSnapshot[] = []
  const registry = new ToolRegistry()
  registry.add(
    shellTool(async () => {
      executions++
      return { content: [] }
    }),
    { source: 'test', trust: 'builtin' },
  )
  const storage = new MemoryStorage({ clock: () => now })
  const seams = fakeSeams({
    approval: {
      ask: async (request) => {
        const snapshot = await h.session.decisions.get(request.decision!.handle)
        expect(snapshot.result).toBeNull()
        expect(snapshot.handle.id).toBe(request.requestId)
        seen.push(snapshot)
        return { verdict: 'unavailable', reason: 'no-handler' }
      },
    },
  })
  const h = await openSession({
    storage,
    registry,
    seams,
    clock: () => now,
    resolvedProfileHash: profileHash,
    policyDigest: profileHash,
    provider: fakeProvider([toolTurn('shell', { command: 'synthetic' }), textTurn('done')]),
  })
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'run' }] })
  expect(await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
    reason: 'parked',
  })
  return {
    ...h,
    storage,
    registry,
    seams,
    clock: () => now,
    advance(ms: number) {
      now += ms
    },
    seen,
    executions: () => executions,
    snapshot: () => h.session.decisions.get(seen[0]!.handle),
  }
}
const answer = (
  h: Awaited<ReturnType<typeof parked>>,
  option = 'allowed-once',
  commandId = 'answer',
  authorize: () => void | Promise<void> = () => undefined,
) =>
  h.session.decisions.answer(
    {
      handle: h.seen[0]!.handle,
      revision: 1,
      commandId,
      response: { option, value: null },
    },
    { actor, category: 'human', authorize },
  )

describe('durable tool decisions', () => {
  it('withdraws a memory candidate when its delivery signal is cancelled', async () => {
    const controller = new AbortController()
    const h = await openSession({
      provider: fakeProvider([]),
      seams: fakeSeams({
        approval: {
          ask: async (request) => {
            controller.abort('stopped')
            return { ticket: 'detached-memory', expiresAt: request.deadline }
          },
        },
      }),
    })
    try {
      const tool: { name: string; meta: ToolMeta } = shellTool()
      expect(
        await approveMemoryFile(
          h.session,
          {
            path: 'MEMORY.md',
            baseHash: 'a'.repeat(64),
            newHash: 'b'.repeat(64),
            diff: 'synthetic change',
            source: { sessionKey: h.session.key, turn: 1, toolUseId: 'write-memory' },
          },
          { name: tool.name, meta: tool.meta },
          0,
          controller.signal,
        ),
      ).toEqual({ status: 'unanswered', reason: 'stopped' })
      const [decision] = await h.session.decisions.list()
      expect(decision?.result).toMatchObject({ reason: 'stopped', code: 'stopped' })
      expect(decision?.consumption).toBeNull()
      if (!decision) throw new Error('missing memory decision')
      await expect(
        h.session.decideApproval({
          command: {
            handle: decision.handle,
            revision: decision.revision,
            commandId: 'late-memory',
            response: { option: 'allowed-once', value: null },
          },
          context: { actor, category: 'human', authorize() {} },
        }),
      ).rejects.toThrow('NOT_PENDING')
    } finally {
      await h.session.close()
    }
  })
  it('persists before delivery, re-offers the original ID/deadline, and never makes no-handler an answer', async () => {
    const h = await parked()
    try {
      expect((await h.snapshot()).result).toBeNull()
      expect(await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
        reason: 'parked',
      })
      expect(h.seen).toHaveLength(2)
      expect(h.seen[1]).toEqual(h.seen[0])
      expect(h.executions()).toBe(0)
      expect(await h.log.scan({ type: 'approval/asked', toSeq: h.log.lastSeq })).toEqual([])
      expect(await h.log.scan({ type: 'approval/decided', toSeq: h.log.lastSeq })).toEqual([])
    } finally {
      await h.session.close()
    }
  })
  it('allows the owner to review their agent; consumes with original intent and opState in one batch', async () => {
    const h = await parked()
    const commits = vi.spyOn(h.storage, 'commit')
    try {
      const receipt = await answer(h)
      await expect(answer(h)).resolves.toEqual(receipt)
      await expect(answer(h, 'rejected')).rejects.toThrow('COMMAND_CONFLICT')
      await expect(answer(h, 'allowed-once', 'another')).rejects.toThrow('NOT_PENDING')
      const outcome = await h.session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(outcome.error).toBeUndefined()
      expect(outcome.reason).toBe('completed')
      expect(h.executions()).toBe(1)
      const snapshot = await h.snapshot()
      expect(snapshot.result).toMatchObject({ reason: 'answered', answeredBy: actor })
      expect(snapshot.consumption?.effectId).toEqual(expect.any(String))
      const tx = commits.mock.calls
        .map((call) => call[1])
        .find((tx) =>
          tx.events.some(
            (row) =>
              row.type === 'effect/intent' && row.data && (row.data as { kind?: string }).kind === 'tool',
          ),
        )!
      expect(tx.opState).toBeDefined()
      expect(tx.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'effect/intent' }),
          expect.objectContaining({
            type: 'decision/state',
            data: expect.objectContaining({ consumption: snapshot.consumption }),
          }),
        ]),
      )
      expect(tx.events.find((row) => row.type === 'effect/intent')?.data).toMatchObject({
        effectId: snapshot.consumption!.effectId,
      })
      const again = await h.session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(again.error).toBeUndefined()
      expect(again.reason).toBe('completed')
      expect(h.executions()).toBe(1)
    } finally {
      await h.session.close()
    }
  })
  it('cold reopens the same call and approval without replaying a new model call', async () => {
    const h = await parked()
    await answer(h)
    await h.session.close()
    const reopened = await openSession({
      storage: h.storage,
      registry: h.registry,
      seams: h.seams,
      clock: h.clock,
      provider: fakeProvider([textTurn('done')]),
      writerRunId: 'new-writer',
    })
    try {
      expect((await reopened.session.decisions.get(h.seen[0]!.handle)).handle).toEqual(h.seen[0]!.handle)
      await reopened.session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(h.executions()).toBe(1)
      expect(await reopened.log.scan({ type: 'tool/call', toSeq: reopened.log.lastSeq })).toHaveLength(1)
    } finally {
      await reopened.session.close()
    }
  })
  it('rejects unoffered answers, non-null tool inputs, malformed identities and stale revisions without spending', async () => {
    const h = await parked()
    try {
      await expect(answer(h, 'allowed-permanent')).rejects.toThrow('UNOFFERED_ANSWER')
      const command = {
        handle: h.seen[0]!.handle,
        revision: 1,
        commandId: 'x',
        response: { option: 'allowed-once', value: { changed: true } },
      }
      await expect(
        h.session.decisions.answer(command, { actor, category: 'human', authorize() {} }),
      ).rejects.toThrow('RESPONSE_SCHEMA')
      await expect(
        h.session.decisions.answer(
          { ...command, response: { option: 'rejected', value: 'x'.repeat(4001) } },
          { actor, category: 'human', authorize() {} },
        ),
      ).rejects.toThrow('RESPONSE_SCHEMA')
      await expect(
        h.session.decisions.answer(
          { ...command, response: { option: 'allowed-once', value: null }, revision: 2 },
          { actor, category: 'human', authorize() {} },
        ),
      ).rejects.toThrow('revision')
      await expect(
        h.session.decisions.answer(
          { ...command, response: { option: 'allowed-once', value: null } },
          { actor: {} as typeof actor, category: 'human', authorize() {} },
        ),
      ).rejects.toThrow('HUMAN_REQUIRED')
      await expect(
        h.session.decisions.answer(
          { ...command, response: { option: 'allowed-once', value: null } },
          { actor: { ...actor, role: 'agent' }, category: 'human', authorize() {} },
        ),
      ).rejects.toThrow('HUMAN_REQUIRED')
      expect((await h.snapshot()).result).toBeNull()
    } finally {
      await h.session.close()
    }
  })
  it.each(['expired', 'stopped', 'revoked'] as const)(
    'rechecks %s after authority await inside the writer',
    async (mode) => {
      const h = await parked()
      try {
        if (mode === 'stopped') await h.session.decisions.stop()
        await expect(
          answer(h, 'allowed-once', 'late', async () => {
            if (mode === 'expired') h.advance(h.session.preset.approval.pendingTtlMs)
            if (mode === 'revoked') throw new Error('authority revoked')
          }),
        ).rejects.toThrow()
        expect((await h.snapshot()).result?.reason).toBe(
          mode === 'expired' ? 'expired' : mode === 'stopped' ? 'stopped' : undefined,
        )
        expect(h.executions()).toBe(0)
      } finally {
        await h.session.close()
      }
    },
  )
  it('retains answered facts when stopped and makes late consumption impossible', async () => {
    const h = await parked()
    try {
      await answer(h)
      await h.session.decisions.stop()
      expect(await h.snapshot()).toMatchObject({
        result: { reason: 'answered' },
        invalidation: { code: 'stopped' },
        consumption: null,
      })
      const card = (await h.session.projectUI()).nodes.find((node) => node.kind === 'approval')
      expect(card).toMatchObject({
        state: 'expired',
        decision: { verdict: 'allowed-once', reason: 'stopped', byLabel: actor.id },
      })
      await h.session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(h.executions()).toBe(0)
    } finally {
      await h.session.close()
    }
  })
})
