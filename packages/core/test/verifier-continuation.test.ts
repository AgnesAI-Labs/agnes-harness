import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { describe, expect, it, vi } from 'vitest'
import { domainDecisionSource } from '../src/step/domain-decision.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

const run = (h: Awaited<ReturnType<typeof openSession>>) =>
  h.session.run({ until: 'turn-end', signal: new AbortController().signal })

describe('automatic verifier recovery', () => {
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
        expect(JSON.stringify(provider.requests[1]?.messages)).toContain('Repair the answer once')
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
  it.each(['park', 'repair', 'escalate', 'complete'] as const)(
    'bounds a persistent failure even when repair policy returns %s',
    async (decision) => {
      const ask = vi.fn()
      const provider = fakeProvider([textTurn('unverified draft')])
      const storage = new MemoryStorage()
      const seams = fakeSeams({
        verifier: { verify: async () => ({ verdict: 'fail', reasons: ['schema_invalid'] }) },
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
    'retires legacy verifier approvals automatically (%j)',
    async ({ completes, answered }) => {
      let h = await openSession({ provider: fakeProvider([textTurn('historic unverified answer')]) })
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
        const storage = h.storage
        await h.session.close()
        h = await openSession({
          storage,
          agnesVersion: '99.0.0',
          provider: fakeProvider([textTurn('must not infer')]),
        })
        expect((await h.session.projectUI()).nodes.some((n) => n.kind === 'approval')).toBe(false)
        expect((await run(h)).reason).toBe('blocked')
        const retired = await h.session.decisions.get(handle)
        expect(
          retired.result?.reason === 'unavailable' || retired.invalidation?.code === 'verifier-system-error',
        ).toBe(true)
        expect(
          (await h.session.projectUI()).nodes.some((n) => n.kind === 'approval' && n.state === 'pending'),
        ).toBe(false)
        expect((await h.log.scan({ type: 'x/core/verifier-recovery', limit: 5 }))[0]?.data).toMatchObject({
          handling: 'blocked',
          legacyDecisionId: handle.id,
        })
      } finally {
        await h.session.close()
      }
    },
  )
})
