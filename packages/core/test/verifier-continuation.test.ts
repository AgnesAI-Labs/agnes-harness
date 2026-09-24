import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

async function setup(initialVerdict: 'fail' | 'needs_revision' = 'fail') {
  let now = 1_757_203_200_000,
    checks = 0
  const clock = () => now,
    storage = new MemoryStorage({ clock })
  let receipt: { requestId: string; bindingHash: string; expiresAt: string } | null = null
  const seams = fakeSeams({
    verifier: {
      verify: async () =>
        ++checks === 1
          ? { verdict: initialVerdict, reasons: ['needs review'] }
          : { verdict: 'pass', reasons: [] },
    },
    repair: { decide: async () => 'park' },
    approval: {
      ask: async (req) => {
        receipt = {
          requestId: req.requestId,
          bindingHash: req.bindingHash,
          expiresAt: new Date(now + 1000).toISOString(),
        }
        return { ticket: 'review', expiresAt: receipt.expiresAt }
      },
      resume: async () => receipt,
    },
  })
  const provider = fakeProvider([textTurn('first draft'), textTurn('reviewed answer')])
  const h = await openSession({ clock, storage, seams, provider })
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  expect((await run(h)).reason).toBe('parked')
  expect(provider.calls).toBe(1)
  return {
    ...h,
    clock,
    storage,
    seams,
    provider,
    expire: () => {
      now += 1000
    },
  }
}
const run = (h: Awaited<ReturnType<typeof openSession>>) =>
  h.session.run({
    until: 'turn-end',
    signal: new AbortController().signal,
  })
const approver = { ...actor, id: 'reviewer' }

describe('verifier pause continuation', () => {
  it('continues a needs_revision verifier decision through the same approval path', async () => {
    const h = await setup('needs_revision')
    try {
      await h.session.resumeApproval('review', 'allowed-once', approver)
      expect((await run(h)).reason).toBe('completed')
      expect(h.provider.calls).toBe(2)
      expect(h.session.state.resumedRequests.size).toBe(1)
    } finally {
      await h.session.close()
    }
  })
  it.each(['allowed-once', 'allowed-session'] as const)(
    'continues %s to the real provider',
    async (verdict) => {
      const h = await setup()
      try {
        await h.session.resumeApproval('review', verdict, approver)
        expect(await h.session.step()).toEqual({ phase: 'checkpoint' })
        expect((await run(h)).reason).toBe('completed')
        expect(h.provider.calls).toBe(2)
        expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('first draft')
        expect(h.session.state.resumedRequests.size).toBe(1)
        const seq = h.log.lastSeq
        await run(h)
        expect(h.log.lastSeq).toBe(seq)
      } finally {
        await h.session.close()
      }
    },
  )
  it.each(['rejected', 'expired'] as const)(
    'ends %s as blocked without a model request',
    async (decision) => {
      const h = await setup()
      try {
        if (decision === 'expired') {
          h.expire()
          expect(await h.session.expireApprovals()).toBe(1)
        } else await h.session.resumeApproval('review', 'rejected', approver)
        expect((await run(h)).reason).toBe('blocked')
        expect(h.provider.calls).toBe(1)
        expect(h.session.op()).toBeNull()
        expect(h.session.state.resumedRequests.size).toBe(1)
        const seq = h.log.lastSeq
        await run(h)
        expect(h.log.lastSeq).toBe(seq)
      } finally {
        await h.session.close()
      }
    },
  )
  it.each(['allowed-once', 'rejected'] as const)(
    'reopens after the %s continuation edge without losing or reversing the decision',
    async (verdict) => {
      const h = await setup()
      await h.session.resumeApproval('review', verdict, approver)
      expect(await h.session.step()).toEqual(
        verdict === 'rejected' ? { phase: 'terminal', reason: 'blocked' } : { phase: 'checkpoint' },
      )
      await h.session.close()
      const provider = fakeProvider([textTurn('reviewed')])
      const fresh = await openSession({ clock: h.clock, storage: h.storage, seams: h.seams, provider })
      try {
        const seq = fresh.log.lastSeq
        await run(fresh)
        expect(provider.calls).toBe(verdict === 'rejected' ? 0 : 1)
        expect(fresh.session.state.resumedRequests.size).toBe(1)
        if (verdict === 'rejected') expect(fresh.log.lastSeq).toBe(seq)
      } finally {
        await fresh.session.close()
      }
    },
  )

  it('reopens a callback and resumes from the persisted verifier evidence', async () => {
    const h = await setup()
    await h.session.resumeApproval('review', 'allowed-once', approver)
    await h.session.close()
    const provider = fakeProvider([textTurn('reviewed')])
    const fresh = await openSession({ clock: h.clock, storage: h.storage, seams: h.seams, provider })
    try {
      expect((await run(fresh)).reason).toBe('completed')
      expect(provider.calls).toBe(1)
      expect(JSON.stringify(provider.requests[0]?.messages)).toContain('first draft')
      expect(fresh.session.state.resumedRequests.size).toBe(1)
    } finally {
      await fresh.session.close()
    }
  })

  // stopGate's park path (an unknown-outcome approval with no tool behind it) fires the same
  // approval_request hook as tools.ts's own tool-approval path — the design's ruling that the hook
  // describes "any request for human approval", not "only a tool approval".
  it('also fires approval_request from the verifier-repair park path, not just a tool approval', async () => {
    const clock = () => 1_757_203_200_000
    let seenRequest: unknown
    const seams = fakeSeams({
      verifier: { verify: async () => ({ verdict: 'fail', reasons: ['needs review'] }) },
      repair: { decide: async () => 'park' },
      approval: {
        ask: async (req) => {
          seenRequest = req
          return { ticket: 'review', expiresAt: new Date(clock() + 1000).toISOString() }
        },
        resume: async () => null,
      },
    })
    const provider = fakeProvider([textTurn('first draft')])
    const { session, log } = await openSession({ clock, seams, provider })
    session.hooks = {
      ...session.hooks,
      approvalRequest: async (p) => {
        expect(p.request).toEqual({
          tool: 'unknown-outcome',
          argv: null,
          risk: 'always',
          actor: expect.objectContaining({ id: 'u' }),
          summary: expect.stringContaining('verifier failed'),
        })
        return { request: { risk: 'budget', summary: 'escalated by extension' } }
      },
    }
    try {
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
      const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(outcome.reason).toBe('parked')
      expect(seenRequest).toMatchObject({ risk: 'budget' })
      expect((await log.scan({ type: 'approval/asked', limit: 5 }))[0]?.data).toMatchObject({
        risk: 'budget',
        summary: 'escalated by extension',
      })
    } finally {
      await session.close()
    }
  })
})
