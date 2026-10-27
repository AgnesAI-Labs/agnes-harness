import { presetDefaults } from '@agnes/core-common/step/preset'
import { SeamRuntime } from '@agnes/core-effects/effects/wrap'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { domainDecisionSource } from '../src/step/domain-decision.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import {
  actor,
  immediateTimers,
  openSession,
  readTool,
  testWorkspaceInvocation,
} from './helpers/open-session.js'

const run = (h: Awaited<ReturnType<typeof openSession>>) =>
  h.session.run({ until: 'turn-end', signal: new AbortController().signal })

describe('automatic verifier recovery', () => {
  it.each(['pass', 'complete', 'unavailable'] as const)(
    'keeps Stop authoritative during after-core (%s)',
    async (mode) => {
      let enter: () => void = () => undefined
      let release: () => void = () => undefined
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const h = await openSession({
        provider: fakeProvider([textTurn('available answer')]),
        seams: fakeSeams({
          verifier: {
            verify: async () => {
              if (mode === 'unavailable') throw new Error('offline')
              return { verdict: mode === 'pass' ? 'pass' : 'fail', reasons: [] }
            },
          },
          repair: { decide: async () => 'complete' },
        }),
        operations: [
          {
            name: 'wait-at-completion',
            slot: 'after-core',
            replay: 'safe',
            applicable: async () => 'applied',
            run: async () => {
              enter()
              await held
              return {}
            },
          },
        ],
      })
      try {
        await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
        const running = run(h)
        await entered
        await h.session.abort()
        release()
        expect((await running).reason).toBe('aborted')
        expect((await h.session.projectUI()).turns[0]).toMatchObject({ reason: 'aborted' })
      } finally {
        release()
        await h.session.close()
      }
    },
  )
  it.each(['fail', 'needs_revision'] as const)(
    'repairs %s once without creating any approval',
    async (verdict) => {
      const ask = vi.fn()
      let checks = 0
      const provider = fakeProvider([textTurn('draft'), textTurn('corrected answer')])
      const approvalRequest = vi.fn()
      const h = await openSession({
        provider,
        seams: fakeSeams({
          verifier: {
            verify: async () =>
              ++checks === 1 ? { verdict, reasons: ['schema_invalid'] } : { verdict: 'pass', reasons: [] },
          },
          repair: { decide: async () => 'park' },
          approval: { ask },
        }),
      })
      h.session.hooks = { ...h.session.hooks, approvalRequest }
      try {
        await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
        expect((await run(h)).reason).toBe('completed')
        expect(ask).not.toHaveBeenCalled()
        expect(approvalRequest).not.toHaveBeenCalled()
        expect(await h.session.decisions.list()).toEqual([])
        expect((await h.session.projectUI()).nodes.some((n) => n.kind === 'approval')).toBe(false)
        expect(JSON.stringify(provider.requests[1]?.messages)).toContain('Check that failed:')
        const [audit] = await h.log.scan({ type: 'x/core/verifier-recovery', limit: 5 })
        expect(audit?.data).toMatchObject({
          verdict: { verdict, reasons: ['schema_invalid'] },
          proposed: 'park',
          handling: 'repair',
        })
        const [repair] = await h.log.scan({ type: 'repair/decision', limit: 1 })
        if (!repair) throw new Error('missing repair decision')
        const seq = (repair.data as { verdictSeq: number }).verdictSeq
        expect((await h.log.scan({ fromSeq: seq, toSeq: seq }))[0]).toMatchObject({
          type: 'verifier/signal',
          data: { verdict },
        })
      } finally {
        await h.session.close()
      }
    },
  )
  // The repair note names the check and its evidence; a vague one read as "the task failed" and
  // the model broke work it had already verified.
  it.each([
    ['repeated_write:3', ['repeated_write:3', 'read']],
    ['output_truncated', ['output_truncated', 'output limit']],
    ['plugin says no', ['plugin says no']],
  ])('states the failed check (%s) and asks to keep verified work', async (reason, expected) => {
    const registry = new ToolRegistry()
    registry.add(readTool(), { source: 'test', trust: 'builtin' })
    let checks = 0
    const provider = fakeProvider([toolTurn('read', {}), textTurn('draft'), textTurn('corrected answer')])
    const h = await openSession({
      provider,
      registry,
      seams: fakeSeams({
        verifier: {
          verify: async (scope) =>
            scope === 'turn' && ++checks === 1
              ? { verdict: 'fail', reasons: [reason] }
              : { verdict: 'pass', reasons: [] },
        },
        repair: { decide: async () => 'repair' },
      }),
    })
    try {
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
      expect((await run(h)).reason).toBe('completed')
      const note = JSON.stringify(provider.requests[2]?.messages.at(-1))
      for (const text of expected) expect(note).toContain(text)
      expect(note).toContain('Keep the work you have already verified')
      expect(note).not.toContain('could not verify completion')
    } finally {
      await h.session.close()
    }
  })
  it.each(['park', 'repair', 'escalate'] as const)(
    'bounds a persistent failure even when repair policy returns %s',
    async (decision) => {
      const ask = vi.fn()
      const provider = fakeProvider([textTurn('unverified draft')])
      const storage = new MemoryStorage()
      const seams = fakeSeams({
        // A plugin's reason text is content evidence, not a runtime outage marker.
        verifier: { verify: async () => ({ verdict: 'fail', reasons: ['verifier unavailable'] }) },
        repair: { decide: async () => decision },
        approval: { ask },
      })
      const h = await openSession({ provider, storage, seams })
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
      expect((await run(h)).reason).toBe('blocked')
      expect(provider.calls).toBe(2)
      expect(ask).not.toHaveBeenCalled()
      expect(await h.session.decisions.list()).toEqual([])
      const audits = await h.log.scan({ type: 'x/core/verifier-recovery', limit: 5 })
      expect(audits.map((e) => (e.data as { handling: string }).handling)).toEqual(['repair', 'blocked'])
      expect((await h.session.projectUI()).turns[0]).toMatchObject({ verification: 'blocked' })
      expect(
        (await h.log.scan({ type: 'assistant/message', limit: 5 })).map((e) => JSON.stringify(e.data)),
      ).toEqual([expect.stringContaining('unverified draft'), expect.stringContaining('unverified draft')])
      await h.session.close()
      const fresh = await openSession({ provider: fakeProvider([textTurn('must not run')]), storage, seams })
      try {
        const seq = fresh.log.lastSeq
        await run(fresh)
        expect(fresh.log.lastSeq).toBe(seq)
        expect(await fresh.session.decisions.list()).toEqual([])
      } finally {
        await fresh.session.close()
      }
    },
  )
  it.each([false, true])(
    'honors explicit completion after a repair=%s without claiming a pass',
    async (repairFirst) => {
      const provider = fakeProvider([textTurn('unverified answer')])
      const h = await openSession({
        provider,
        seams: fakeSeams({
          verifier: { verify: async () => ({ verdict: 'fail', reasons: ['content_incomplete'] }) },
          repair: { decide: async ({ round }) => (repairFirst && round === 1 ? 'repair' : 'complete') },
        }),
      })
      try {
        await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
        expect((await run(h)).reason).toBe('completed')
        expect(provider.requests).toHaveLength(repairFirst ? 2 : 1)
        const audits = await h.log.scan({ type: 'x/core/verifier-recovery', limit: 5 })
        expect(audits.at(-1)?.data).toMatchObject({
          verdict: { verdict: 'fail', reasons: ['content_incomplete'] },
          proposed: 'complete',
          handling: 'complete',
        })
        expect((await h.session.projectUI()).turns[0]).toMatchObject({ verification: 'unverified' })
      } finally {
        await h.session.close()
      }
    },
  )
  it.each(['verifier-timeout', 'verifier-throw', 'repair-throw'] as const)(
    'completes honestly without another model call or approval on %s',
    async (failure) => {
      const preset = presetDefaults()
      preset.verifier.timeoutMs = 5
      const provider = fakeProvider([textTurn('available answer')])
      const seams = fakeSeams({
        verifier: {
          verify: async () => {
            if (failure === 'verifier-timeout') return new Promise(() => {})
            if (failure === 'verifier-throw') throw new Error('private diagnostic')
            return { verdict: 'fail', reasons: ['content_incomplete'] }
          },
        },
        repair: {
          decide: async () => {
            throw new Error('private diagnostic')
          },
        },
      })
      const runtime = new SeamRuntime(seams, preset, {
        clock: () => 0,
        onFailure: () => undefined,
        timers: immediateTimers,
        workspaceInvocation: testWorkspaceInvocation(undefined, seams),
      })
      const h = await openSession({ provider, preset, seams, runtime })
      try {
        await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
        const running = run(h)
        expect((await running).reason).toBe('completed')
        expect(provider.requests).toHaveLength(1)
        expect(await h.session.decisions.list()).toEqual([])
        expect((await h.session.projectUI()).turns[0]).toMatchObject({ verification: 'unavailable' })
        const [audit] = await h.log.scan({ type: 'x/core/verifier-recovery', limit: 5 })
        expect(audit?.data).toMatchObject({
          handling: 'unavailable',
          unavailable: failure.startsWith('verifier') ? 'verifier' : 'repair',
        })
        const storage = h.storage
        await h.session.close()
        const reopened = await openSession({ provider, storage })
        try {
          expect((await reopened.session.projectUI()).turns[0]).toMatchObject({ verification: 'unavailable' })
          expect((await run(reopened)).reason).toBe('completed')
          expect(provider.requests).toHaveLength(1)
        } finally {
          await reopened.session.close()
        }
      } finally {
        await h.session.close()
      }
    },
  )
  it('does not carry repair exhaustion into a new user turn', async () => {
    let failing = true
    const ask = vi.fn()
    const h = await openSession({
      provider: fakeProvider([textTurn('answer')]),
      seams: fakeSeams({
        verifier: {
          verify: async () =>
            failing ? { verdict: 'fail', reasons: ['invalid_output'] } : { verdict: 'pass', reasons: [] },
        },
        repair: { decide: async () => 'park' },
        approval: { ask },
      }),
    })
    try {
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
      expect((await run(h)).reason).toBe('blocked')
      failing = false
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'again' }] })
      expect((await run(h)).reason).toBe('completed')
      expect(ask).not.toHaveBeenCalled()
    } finally {
      await h.session.close()
    }
  })
  it.each([false, true].flatMap((completes) => [false, true].map((answered) => ({ completes, answered }))))(
    'refuses retired verifier approvals without changing their history (%j)',
    async ({ completes, answered }) => {
      const h = await openSession({ provider: fakeProvider([textTurn('historic unverified answer')]) })
      try {
        await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
        for (let i = 0; i < 10; i++) {
          await h.session.step()
          if ((await h.log.scan({ type: 'assistant/message', limit: 1 })).length) break
        }
        const op = h.session.op()
        if (!op) throw new Error('missing active historic turn')
        const source = domainDecisionSource(h.session, 'gate', `${op.meta.turn}:${op.step}:1`)
        const handle = await h.session.decisions.port(source).request({
          key: 'historic',
          purpose: 'gate',
          prompt: 'verifier failed: schema_invalid',
          options: ['allowed-once', 'rejected'],
          responseSchema: { type: 'null' },
          subject: {
            turn: op.meta.turn,
            step: op.step,
            triggerSeq: op.meta.triggerSeq,
            round: 1,
            verdict: 'fail',
            reasons: ['schema_invalid'],
            ...(completes ? { completes: true } : {}),
          },
        })
        if (answered) {
          const snapshot = await h.session.decisions.get(handle)
          await h.session.decideApproval({
            command: {
              handle,
              revision: snapshot.revision,
              commandId: 'old-answer',
              response: { option: 'allowed-once', value: null },
            },
            context: { actor, category: 'human', authorize() {} },
          })
        }
        await h.session.transition(
          (seq) => [
            h.session.ev('verifier/signal', {
              scope: 'turn',
              tier: 0,
              verdict: 'fail',
              reasons: ['schema_invalid'],
            }),
            h.session.ev('repair/decision', { round: 1, decision: 'park', verdictSeq: seq }),
          ],
          (current) => current,
        )
        await h.session.endTurn('parked')
        const before = await h.storage.scan(h.session.key, { fromSeq: 1, limit: 500 })
        await expect(h.session.start()).rejects.toThrow(/Retired verifier.*clean home/)
        expect(await h.storage.scan(h.session.key, { fromSeq: 1, limit: 500 })).toEqual(before)
        expect(await h.session.decisions.get(handle)).toMatchObject({ handle })
      } finally {
        await h.session.close()
      }
    },
  )
})
