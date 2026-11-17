import { hasChildControl } from '@agnes/core'
import { withSideCallSession as withSession } from '@agnes/core/testkit'
import { SESSION_TITLE_EVENT } from '@agnes/protocol'
import { expect, it } from 'vitest'
import type { HostSession } from '../src/runtime/lifecycle/host.js'
import {
  recoverTitleCosts,
  TITLE_COST_EVENT,
  type TitleCostProof,
  titleEffectId,
} from '../src/runtime/sessions/title-accounting.js'

it.each([
  'valid',
  'untrusted',
  'wrong-effect',
  'wrong-source',
  'wrong-revision',
  'wrong-reservation',
] as const)('recovers only a proven original title cost and reservation: %s', async (mode) =>
  withSession({}, async ({ session, provider, billing }) => {
    const hostSession = session as unknown as HostSession
    const turn = session.op()?.meta.turn
    const startSeq = session.state.openTurn.get(session.lane)?.startSeq
    if (!turn || !startSeq) throw new Error('missing source')
    const answer = await session.append([
      session.ev(
        'assistant/message',
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
        { origin: 'model' },
      ),
    ])
    await session.endTurn('completed', { lastAssistantSeq: answer.firstSeq })
    const end = (await session.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]
    if (!end) throw new Error('missing source end')
    const title = await session.append([
      session.ev(
        SESSION_TITLE_EVENT,
        {
          status: 'generated',
          title: 'Accepted',
          turn,
          startSeq,
          route: 'gw',
          model: 'm',
          prompt: 'topic',
          budgetCap: null,
          treeBudgetCap: null,
        },
        { ignorable: true },
      ),
    ])
    const refresh = {
      endSeq: end.seq,
      expectedRevision: mode === 'wrong-revision' ? startSeq : title.firstSeq,
    }
    const effectId = titleEffectId(hostSession, startSeq, refresh)
    const storage = session.d.log.storage
    if (!hasChildControl(storage) || !storage.peekReservation) throw new Error('missing durable budgets')
    const rootTaskId = `${session.key}:${session.lane}:${startSeq}`
    const scope = await storage.ensureRootScope(rootTaskId, 10000000n)
    const requestHash = 'a'.repeat(64)
    const reserved = await storage.reserve({
      rootTaskId,
      scopeIds: [scope.scopeId],
      qMicro: 1000000n,
      effectId: mode === 'wrong-reservation' ? 'another-effect' : effectId,
      requestHash,
      writerGeneration: 1,
    })
    if (!reserved.ok) throw new Error('missing reservation')
    const proof: TitleCostProof = {
      version: 1,
      effectId: mode === 'wrong-effect' ? 'title-refresh:invalid' : effectId,
      sourceTurn: mode === 'wrong-source' ? turn + 1 : turn,
      startSeq,
      model: 'm',
      refresh,
      reservation: { permitId: reserved.permitId, rootTaskId, requestHash, writerGeneration: 1 },
    }
    const cost = await session.append([
      session.ev('cost/ledger', {
        purpose: 'title',
        effectId,
        sourceTurn: turn,
        model: 'm',
        creditSource: 'estimated',
        interrupted: true,
        tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      session.ev(TITLE_COST_EVENT, proof, {
        ignorable: true,
        ...(mode === 'untrusted' ? { origin: 'ext:forged', trust: 'untrusted' } : {}),
      }),
    ])
    const errors: unknown[] = []
    await recoverTitleCosts(
      hostSession,
      1,
      () => true,
      (error) => errors.push(error),
    )
    const actual = await storage.peekReservation(reserved.permitId)
    expect(provider.calls).toHaveLength(0)
    if (mode === 'valid') {
      expect(actual).toMatchObject({ status: 'unknown' })
      expect(billing).toEqual([expect.objectContaining({ effectId, turn, interrupted: true })])
      expect(billing[0]).not.toHaveProperty('credits')
      await recoverTitleCosts(
        hostSession,
        1,
        () => true,
        (error) => errors.push(error),
      )
      expect(await storage.peekReservation(reserved.permitId)).toEqual(actual)
      expect(billing.every((row) => row.effectId === effectId)).toBe(true)
      expect(errors).toEqual([])
      expect(cost.firstSeq).toBeGreaterThan(end.seq)
    } else {
      expect(actual).toMatchObject({ status: 'held' })
      if (mode === 'wrong-reservation') expect(errors).toHaveLength(1)
      else expect(billing).toHaveLength(0)
    }
  }),
)

it('recovers a historical initial title cost without a new accounting proof', async () => {
  await withSession({}, async ({ session, provider, billing }) => {
    const hostSession = session as unknown as HostSession
    const turn = session.op()?.meta.turn
    const startSeq = session.state.openTurn.get(session.lane)?.startSeq
    if (!turn || !startSeq) throw new Error('missing source')
    const effectId = titleEffectId(hostSession, startSeq)
    const title = {
      status: 'generated',
      title: 'Original',
      turn,
      startSeq,
      route: 'gw',
      model: 'original-model',
      prompt: 'topic',
      budgetCap: null,
      treeBudgetCap: null,
    }
    await session.append([
      session.ev('cost/ledger', {
        purpose: 'title',
        effectId,
        sourceTurn: turn,
        model: title.model,
        creditSource: 'gateway',
        credits: 0.2,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
      session.ev(SESSION_TITLE_EVENT, title, { ignorable: true }),
      session.ev(
        SESSION_TITLE_EVENT,
        { ...title, title: 'Later accepted', model: 'later-model' },
        { ignorable: true },
      ),
    ])
    const errors: unknown[] = []
    await recoverTitleCosts(
      hostSession,
      1,
      () => true,
      (error) => errors.push(error),
    )
    expect(billing).toEqual([
      expect.objectContaining({ effectId, turn, model: 'original-model', credits: 0.2 }),
    ])
    expect(errors).toEqual([])
    expect(provider.calls).toHaveLength(0)
  })
})
