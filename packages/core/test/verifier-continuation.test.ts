import { presetDefaults } from '@agnes/core-common/step/preset'
import { ToolPolicyRegistry } from '@agnes/core-effects/effects/tool-providers'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { describe, expect, it, vi } from 'vitest'
import type { SessionImpl } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

async function setup(initialVerdict: 'fail' | 'needs_revision' = 'fail') {
  let now = 1_757_203_200_000,
    checks = 0
  const clock = () => now,
    storage = new MemoryStorage({ clock })
  let opCells: Awaited<ReturnType<MemoryStorage['registers']>> = []
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
        opCells = (await storage.registers('k')).filter((row) => row.register === 'op.state')
        receipt = {
          requestId: req.requestId,
          bindingHash: req.bindingHash,
          expiresAt: new Date(now + 1000).toISOString(),
        }
        return { ticket: 'review', expiresAt: receipt.expiresAt }
      },
    },
  })
  const provider = fakeProvider([textTurn('first draft'), textTurn('reviewed answer')])
  const defaults = presetDefaults()
  const h = await openSession({
    clock,
    storage,
    seams,
    provider,
    preset: { ...defaults, approval: { ...defaults.approval, pendingTtlMs: 1000 } },
  })
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  expect((await run(h)).reason).toBe('parked')
  expect(provider.calls).toBe(1)
  return {
    ...h,
    opCells,
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
async function answerGate(session: SessionImpl, verdict: string) {
  const value = (await session.decisions.list()).find((value) => value.request.spec.purpose === 'gate')
  if (!value) throw new Error('missing gate decision')
  return session.decideApproval({
    command: {
      handle: value.handle,
      revision: value.revision,
      commandId: `answer:${value.handle.id}`,
      response: { option: verdict, value: null },
    },
    context: { actor: approver, category: 'human', authorize() {} },
  })
}

describe('verifier pause continuation', () => {
  it('continues a needs_revision verifier decision through the same approval path', async () => {
    const h = await setup('needs_revision')
    try {
      const asked = (await h.session.decisions.list())[0]!
      const command = {
        handle: asked.handle,
        revision: asked.revision,
        commandId: 'domain-review',
        response: { option: 'allowed-once', value: null },
      }
      const context = { actor, category: 'human' as const, authorize() {} }
      expect((await h.session.projectUI()).nodes).toContainEqual(
        expect.objectContaining({
          kind: 'approval',
          decisionRef: { ...command.handle, revision: asked.revision },
        }),
      )
      const receipt = await h.session.decideApproval({ command, context })
      expect(await h.session.decideApproval({ command, context })).toEqual(receipt)
      await expect(
        h.session.decideApproval({ command: { ...command, commandId: 'another' }, context }),
      ).rejects.toThrow('NOT_PENDING')
      expect((await run(h)).reason).toBe('completed')
      expect(h.provider.calls).toBe(2)
      expect(h.session.state.resumedRequests.size).toBe(1)
      expect(await h.session.decideApproval({ command, context })).toEqual(receipt)
      expect((await h.session.decisions.list())[0]?.consumption).not.toBeNull()
    } finally {
      await h.session.close()
    }
  })
  it.each(['allowed-once', 'allowed-session'] as const)(
    'continues %s to the real provider',
    async (verdict) => {
      const h = await setup()
      try {
        await answerGate(h.session, verdict)
        expect(await h.session.step()).toEqual({ outcome: 'running', phase: 'checkpoint' })
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
        } else await answerGate(h.session, 'rejected')
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
      await answerGate(h.session, verdict)
      expect(await h.session.step()).toEqual(
        verdict === 'rejected'
          ? { outcome: 'turn-ended', phase: 'terminal', reason: 'blocked' }
          : { outcome: 'running', phase: 'checkpoint' },
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

  it('reopens a persisted gate before parking without rerunning verification or bypassing human review', async () => {
    const h = await setup()
    // Reconstruct the real crash cut immediately after the durable request, before turn closure.
    const rows = await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq, limit: 100 })
    const request = rows.find((row) => row.type === 'decision/state')
    if (!request) throw new Error('missing request')
    const cut = rows.filter((row) => row.seq <= request.seq)
    await h.session.close()
    const provider = fakeProvider([textTurn('must not infer')])
    const fresh = await openSession({
      storage: MemoryStorage.fromEvents('k', cut, { opCells: h.opCells }),
      clock: h.clock,
      seams: h.seams,
      provider,
    })
    try {
      await fresh.session.resume()
      expect((await run(fresh)).reason).toBe('parked')
      expect(provider.calls).toBe(0)
      expect(
        (await fresh.session.decisions.list()).filter((value) => value.request.spec.purpose === 'gate'),
      ).toHaveLength(1)
      await answerGate(fresh.session, 'rejected')
      expect((await run(fresh)).reason).toBe('blocked')
      expect(provider.calls).toBe(0)
    } finally {
      await fresh.session.close()
    }
  })

  it('reopens a callback and resumes from the persisted verifier evidence', async () => {
    const h = await setup()
    await answerGate(h.session, 'allowed-once')
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
      // The hook's text reaches the person beside the platform's own; its lower risk does not.
      expect(seenRequest).toMatchObject({ risk: 'unknown', summary: 'escalated by extension' })
      expect((await log.scan({ type: 'decision/state', limit: 5 }))[0]?.data).toMatchObject({
        request: {
          spec: {
            subject: {
              risk: 'unknown',
              rewrite: { by: [], summary: expect.stringContaining('verifier failed') },
            },
            prompt: 'escalated by extension',
          },
        },
      })
    } finally {
      await session.close()
    }
  })
})

// An approval can wait while the user adds work, and after-core can append ledger rows.
it.each(['allowed-once', 'allowed-session'] as const)(
  'preserves steering and verifier evidence when completing synchronous %s',
  async (verdict) => {
    let asks = 0
    const provider = fakeProvider([textTurn('first answer'), textTurn('additional answer')])
    const content = [{ type: 'text' as const, text: 'also check this' }]
    const h = await openSession({
      provider,
      operations: [
        {
          name: 'completion-note',
          slot: 'after-core',
          replay: 'safe',
          applicable: async () => 'applied',
          run: async () => ({
            effects: [{ type: 'x/test/completed', origin: 'system', trust: 'trusted', actor, data: {} }],
          }),
        },
      ],
      seams: fakeSeams({
        verifier: { verify: async () => ({ verdict: 'needs_revision', reasons: ['needs review'] }) },
        repair: { decide: async () => 'park' },
        approval: {
          ask: async () => {
            if (++asks > 1) return { verdict: 'rejected', answeredBy: approver }
            await h.session.enqueue('next-step', { actor: approver, content, trust: 'untrusted' })
            return { verdict, answeredBy: approver }
          },
        },
      }),
    })
    try {
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
      expect((await run(h)).reason).toBe('completed')
      expect(h.session.latest('inbox')).toMatchObject({
        items: [{ target: 'next-turn', actor: approver, content, trust: 'untrusted', kind: 'steer' }],
      })
      const [repair] = await h.log.scan({ type: 'repair/decision', limit: 1 })
      if (!repair) throw new Error('missing repair decision')
      const seq = (repair.data as { verdictSeq: number }).verdictSeq
      const [evidence] = await h.log.scan({ fromSeq: seq, toSeq: seq, limit: 1 })
      expect(evidence).toMatchObject({ type: 'verifier/signal', data: { verdict: 'needs_revision' } })
      // The pending work starts its own turn and still goes through verification.
      expect((await run(h)).reason).toBe('blocked')
      expect(h.session.latest('inbox')).toEqual({ items: [] })
      expect(
        (await h.session.decisions.list()).filter((value) => value.request.spec.purpose === 'gate'),
      ).toHaveLength(2)
      const messages = await h.log.scan({ type: 'user/message', limit: 10 })
      expect(
        messages.some(
          (row) =>
            row.actor.id === approver.id &&
            row.trust === 'untrusted' &&
            JSON.stringify(row.data).includes('also check this'),
        ),
      ).toBe(true)
    } finally {
      await h.session.close()
    }
  },
)

it.each(['full-access', 'workspace-write'])(
  'runs the interactive verifier gate with the effective %s permission preset',
  async (policy) => {
    const ask = vi.fn(async (req: { deadline: string }) => ({ ticket: 'review', expiresAt: req.deadline }))
    const preset = presetDefaults()
    preset.name = policy
    preset.approval.policy = policy
    const policies = new ToolPolicyRegistry()
    policies.register('fixture', {
      id: policy,
      version: '1.0.0',
      decide: () => ({ effect: 'allow', reason: 'fixture' }),
    })
    const h = await openSession({
      preset,
      toolPolicies: policies,
      provider: fakeProvider([textTurn('answer')]),
      seams: fakeSeams({
        verifier: { verify: async () => ({ verdict: 'fail', reasons: ['review'] }) },
        repair: { decide: async () => 'park' },
        approval: { ask },
      }),
    })
    try {
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
      expect((await run(h)).reason).toBe(policy === 'full-access' ? 'completed' : 'parked')
      expect(ask).toHaveBeenCalledTimes(policy === 'full-access' ? 0 : 1)
      const decision = (await h.session.decisions.list()).find(
        (value) => value.request.spec.purpose === 'gate',
      )
      if (policy === 'full-access')
        expect(decision).toMatchObject({
          result: { code: 'full-access', answeredBy: { role: 'system' } },
          consumption: expect.any(Object),
        })
      else expect(decision?.result).toBeNull()
    } finally {
      await h.session.close()
    }
  },
)
