import { checkRelations } from '@agnes/core-ledger/log/relations'
import { initialState } from '@agnes/core-ledger/reduce/state'
import { expect, it } from 'vitest'
import * as scoped from '../src/loop/scoped-side-call.js'
import { actor } from './helpers/open-session.js'
import { gated, options, signal, withSession } from './helpers/side-call-session.js'

it('keeps completed-source work independent of the next turn and bills its original turn', async () => {
  const gate = gated()
  await withSession({ script: gate.script }, async ({ session, billing, rows }) => {
    const source = {
      turn: session.op()!.meta.turn,
      startSeq: session.state.openTurn.get(session.lane)!.startSeq,
      budgetCap: null,
      treeBudgetCap: null,
      hard: false,
      endSeq: 0,
      lastAssistantSeq: 0,
    }
    const answer = await session.append([
      session.ev(
        'assistant/message',
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
        { origin: 'model' },
      ),
    ])
    source.lastAssistantSeq = answer.firstSeq
    await session.endTurn('completed', { lastAssistantSeq: source.lastAssistantSeq })
    source.endSeq = (await session.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]!.seq
    expect(session.state.completedTurns.get(source.endSeq)).toMatchObject({
      startSeq: source.startSeq,
      lastAssistantSeq: source.lastAssistantSeq,
    })
    const work = scoped.createSessionWorkSideCall(session, { caller: 'ext:test/title', source })
    const prepared = await work.prepare(options())
    const pending = work.invoke(prepared, signal())
    await Promise.race([
      gate.reached,
      pending.then((result) => {
        throw new Error(JSON.stringify(result))
      }),
    ])
    expect(session.loopScope.waiting).toBe(false)
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'next task' }] })
    expect(await session.acceptInput()).toBe(true)
    expect(session.op()!.meta.turn).toBe(source.turn + 1)
    expect(session.loopScope.waiting).toBe(false)
    gate.open()
    expect(await pending).toMatchObject({ status: 'ok' })
    expect(billing.filter((row) => row.purpose === 'side-call')).toEqual([
      expect.objectContaining({ turn: source.turn }),
    ])
    const awaitedRows = await rows()
    expect(() => checkRelations(awaitedRows, initialState())).not.toThrow()
    await work.close()
    await expect(work.prepare(options())).rejects.toMatchObject({ code: 'E_CLOSED' })
  })
})

it('refuses hard-bounded sources before any provider dispatch', async () => {
  await withSession({}, async ({ session, provider }) => {
    const work = scoped.createSessionWorkSideCall(session, {
      caller: 'ext:test/title',
      source: {
        turn: 1,
        startSeq: 1,
        endSeq: 1,
        lastAssistantSeq: 1,
        budgetCap: 10,
        treeBudgetCap: 10,
        hard: true,
      },
    })
    const result = await work.invoke(await work.prepare(options()), signal())
    expect(result).toMatchObject({ status: 'refused', reason: 'budget' })
    expect(provider.calls).toHaveLength(0)
    await work.close()
  })
})

it('rejects a fabricated completed boundary and a prepared call from another background scope', async () => {
  await withSession({}, async ({ session }) => {
    const startSeq = session.state.openTurn.get(session.lane)!.startSeq
    const turn = session.op()!.meta.turn
    const answer = await session.append([
      session.ev(
        'assistant/message',
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
        { origin: 'model' },
      ),
    ])
    await session.endTurn('completed', { lastAssistantSeq: answer.firstSeq })
    const endSeq = (await session.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]!.seq
    const source = {
      turn,
      startSeq,
      endSeq,
      lastAssistantSeq: answer.firstSeq,
      budgetCap: null,
      treeBudgetCap: null,
      hard: false,
    }
    const invalid = scoped.createSessionWorkSideCall(session, {
      caller: 'ext:test/title',
      source: { ...source, startSeq: startSeq + 1 },
    })
    await expect(invalid.prepare(options())).rejects.toMatchObject({ code: 'E_RELATION' })
    await invalid.close()
    const first = scoped.createSessionWorkSideCall(session, { caller: 'ext:test/title', source })
    const second = scoped.createSessionWorkSideCall(session, { caller: 'ext:test/title', source })
    await expect(second.invoke(await first.prepare(options()), signal())).rejects.toMatchObject({
      code: 'E_REQUEST_FROZEN',
    })
    await first.close()
    await second.close()
    await expect(
      session.append([
        session.ev('effect/intent', { effectId: 'side:unclaimed', kind: 'side-call', replay: 'never' }),
        session.ev(
          'x/core/side-call-intent',
          {
            binding: { effectId: 'side:unclaimed' },
            audit: {
              caller: 'ext:test/title',
              source: { turn, startSeq, endSeq, lastAssistantSeq: answer.firstSeq },
            },
          },
          { ignorable: true },
        ),
      ]),
    ).rejects.toMatchObject({ code: 'E_RELATION' })
    await expect(
      session.append([
        session.ev('effect/intent', { effectId: 'side:forged', kind: 'side-call', replay: 'never' }),
        session.ev(
          'x/core/side-call-intent',
          {
            binding: { effectId: 'side:forged' },
            audit: { caller: 'ext:test/title', source: { ...source, endSeq: endSeq + 1 } },
          },
          { ignorable: true },
        ),
      ]),
    ).rejects.toMatchObject({ code: 'E_RELATION' })
  })
})

it('explicit abort cancels a fresh background scope without accepting late output', async () => {
  const gate = gated()
  await withSession({ script: gate.script }, async ({ session }) => {
    const turn = session.op()!.meta.turn
    const startSeq = session.state.openTurn.get(session.lane)!.startSeq
    const answer = await session.append([
      session.ev(
        'assistant/message',
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
        { origin: 'model' },
      ),
    ])
    await session.endTurn('completed', { lastAssistantSeq: answer.firstSeq })
    const endSeq = (await session.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]!.seq
    const work = scoped.createSessionWorkSideCall(session, {
      caller: 'ext:test/title',
      source: {
        turn,
        startSeq,
        endSeq,
        lastAssistantSeq: answer.firstSeq,
        budgetCap: null,
        treeBudgetCap: null,
        hard: false,
      },
    })
    const pending = work.invoke(await work.prepare(options()), signal())
    await gate.reached
    let finished = false
    void pending.then(() => {
      finished = true
    })
    await session.abort()
    await work.close()
    expect(finished).toBe(false)
    gate.open()
    expect(await pending).toMatchObject({ status: 'failed', reason: 'cancelled' })
    await expect(work.prepare(options({ invocationId: 'later' }))).rejects.toMatchObject({ code: 'E_CLOSED' })
    await work.close()
  })
})

it('latches a failed background billing write before another request can spend', async () => {
  await withSession({}, async ({ session, provider }) => {
    const turn = session.op()!.meta.turn
    const startSeq = session.state.openTurn.get(session.lane)!.startSeq
    const answer = await session.append([
      session.ev(
        'assistant/message',
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
        { origin: 'model' },
      ),
    ])
    await session.endTurn('completed', { lastAssistantSeq: answer.firstSeq })
    const endSeq = (await session.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]!.seq
    session.d.runtime.billingRecord = async () => false
    const work = scoped.createSessionWorkSideCall(session, {
      caller: 'ext:test/title',
      source: {
        turn,
        startSeq,
        endSeq,
        lastAssistantSeq: answer.firstSeq,
        budgetCap: null,
        treeBudgetCap: null,
        hard: false,
      },
    })
    expect(await work.invoke(await work.prepare(options()), signal())).toMatchObject({ status: 'ok' })
    expect(work.spendAllowed()).toBe(false)
    expect(
      await work.invoke(await work.prepare(options({ invocationId: 'second' })), signal()),
    ).toMatchObject({ status: 'refused', reason: 'usage-unrecorded' })
    expect(provider.calls).toHaveLength(1)
    await work.close()
    const later = scoped.createSessionWorkSideCall(session, {
      caller: 'ext:test/title',
      source: {
        turn,
        startSeq,
        endSeq,
        lastAssistantSeq: answer.firstSeq,
        budgetCap: null,
        treeBudgetCap: null,
        hard: false,
      },
    })
    expect(
      await later.invoke(await later.prepare(options({ invocationId: 'third' })), signal()),
    ).toMatchObject({ status: 'refused', reason: 'usage-unrecorded' })
    expect(provider.calls).toHaveLength(1)
    await later.close()
  })
})
