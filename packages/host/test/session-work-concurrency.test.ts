import { createSessionWorkSideCall } from '@agnes/core'
import {
  gatedSideCall as gated,
  sideCallOptions as options,
  withSideCallSession as withSession,
} from '@agnes/core/testkit'
import { createJudgmentScheduler } from '@agnes/judgment'
import { expect, it } from 'vitest'

it('retains all 16 actual judgment slots after abort until non-cooperative providers settle', async () => {
  const gate = gated()
  let reached!: () => void
  const sixteen = new Promise<void>((resolve) => {
    reached = resolve
  })
  let dispatches = 0
  await withSession(
    {
      script: async function* (request, context) {
        dispatches++
        if (dispatches === 16) reached()
        yield* gate.script(request, context)
      },
    },
    async ({ session, billing }) => {
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
      const source = {
        turn,
        startSeq,
        endSeq,
        lastAssistantSeq: answer.firstSeq,
        budgetCap: null,
        treeBudgetCap: null,
        hard: false,
      }
      const scheduler = createJudgmentScheduler(16)
      const controllers = Array.from({ length: 17 }, () => new AbortController())
      const ports = controllers.map((controller, index) =>
        createSessionWorkSideCall(session, {
          caller: `ext:test/title-${index}`,
          source,
          signal: controller.signal,
        }),
      )
      const prepared = await Promise.all(ports.map((port) => port.prepare(options())))
      const jobs = ports.map((port, index) =>
        scheduler.run(controllers[index]!.signal, () =>
          port.invoke(prepared[index]!, controllers[index]!.signal),
        ),
      )
      try {
        await sixteen
        for (const controller of controllers.slice(0, 16)) controller.abort()
        await Promise.all(ports.slice(0, 16).map((port) => port.close()))
        for (let index = 0; index < 10; index++) await Promise.resolve()
        expect(dispatches).toBe(16)
        const recorded = billing.filter((row) => row.purpose === 'side-call')
        expect(recorded).toHaveLength(16)
        expect(
          recorded.every((row) => row.turn === turn && row.interrupted === true && Number(row.credits) > 0),
        ).toBe(true)
        gate.open()
        const results = await Promise.all(jobs)
        expect(results.slice(0, 16).every((result) => result.status === 'failed')).toBe(true)
        expect(results[16]).toMatchObject({ status: 'ok' })
        expect(dispatches).toBe(17)
        expect(billing.filter((row) => row.purpose === 'side-call')).toHaveLength(17)
      } finally {
        gate.open()
        scheduler.dispose()
        await Promise.allSettled(jobs)
        await Promise.all(ports.map((port) => port.close()))
      }
    },
  )
})
