import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { defaultLoopFactory } from '@agnes/loop-default'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const content = (text: string) => [{ type: 'text' as const, text }]
const run = (session: Awaited<ReturnType<typeof openSession>>['session']) =>
  session.run({ until: 'turn-end', signal: new AbortController().signal })
const facts = async (log: Awaited<ReturnType<typeof openSession>>['log']) =>
  (await log.scan({ type: 'x/core/control', limit: 100 })).map((row) => row.data)

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

describe('human Loop controls', () => {
  it('queues, edits and withdraws steers while a tool runs, delivers after its receipt', async () => {
    const entered = gate(),
      done = gate()
    const registry = new ToolRegistry()
    registry.add(
      readTool(async () => {
        entered.release()
        await done.wait
        return { content: content('committed result') }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const { session, log } = await openSession({
      registry,
      provider: fakeProvider([toolTurn('read', {}), textTurn('answer')]),
    })
    await session.enqueue('next-turn', { content: content('go'), actor })
    const running = run(session)
    await entered.wait
    await session.enqueue('next-step', { content: content('change direction'), actor })
    await session.enqueue('next-step', { content: content('withdraw me'), actor })
    const state = await session.controls.state()
    const first = state.pending[0]!,
      second = state.pending[1]!
    await session.controls.edit(first.itemId, content('edited direction'), actor, 'edit')
    await session.removeQueuedInput(second.itemId, actor, 'withdraw')
    expect(await log.scan({ type: 'user/message', limit: 10 })).toHaveLength(1)
    done.release()
    expect((await running).reason).toBe('completed')
    const rows = await log.scan({ fromSeq: 1, limit: 200 })
    const delivered = rows.find(
      (row) => row.type === 'x/core/control' && (row.data as { outcome?: string }).outcome === 'delivered',
    )!
    expect(delivered.seq).toBeGreaterThan(rows.find((row) => row.type === 'tool/result')!.seq)
    expect(await facts(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'edited' }),
        expect.objectContaining({ outcome: 'withdrawn' }),
        expect.objectContaining({ outcome: 'delivered', itemId: first.itemId }),
      ]),
    )
    expect((await session.controls.state()).pending).toEqual([])
    expect(
      session.surface().some((node) => JSON.stringify(node.event.data).includes('edited direction')),
    ).toBe(true)
    await session.close()
  })

  it('interrupt cooperatively drains a running tool and retains its committed result', async () => {
    const entered = gate()
    const registry = new ToolRegistry()
    registry.add(
      readTool(async (_args, ctx) => {
        entered.release()
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        return { content: content('effect already committed') }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const { session, log } = await openSession({
      registry,
      provider: fakeProvider([toolTurn('read', {}), textTurn('next answer')]),
    })
    await session.enqueue('next-turn', { content: content('go'), actor })
    const running = run(session)
    await entered.wait
    await session.enqueue('next-step', { content: content('new direction'), actor })
    const item = (await session.controls.state()).pending[0]!
    await session.controls.apply('interrupt', actor, 'interrupt', item.itemId)
    expect((await running).reason).toBe('interrupted')
    expect(JSON.stringify(await log.scan({ type: 'tool/result', limit: 10 }))).toContain(
      'effect already committed',
    )
    expect((await run(session)).reason).toBe('completed')
    expect(await facts(log)).toContainEqual(
      expect.objectContaining({ action: 'interrupt', outcome: 'applied' }),
    )
    await session.close()
  })

  it('pauses at a boundary and stays paused through projection reload and cold reopen', async () => {
    const storage = new MemoryStorage()
    const a = await openSession({ storage, provider: fakeProvider([textTurn('answer')]) })
    await a.session.enqueue('next-turn', { content: content('go'), actor })
    await a.session.step()
    const turn = a.session.op()!.meta.turn
    await a.session.controls.apply('pause', actor, 'pause')
    expect(await a.session.step()).toMatchObject({ phase: 'paused', outcome: 'parked' })
    expect((await a.session.projectUI()).opState).not.toBeNull()
    await a.log.close()
    const provider = fakeProvider([textTurn('answer')])
    const b = await openSession({ storage, writerRunId: 'r2', provider })
    await b.session.resume()
    expect(await b.session.step()).toMatchObject({ phase: 'paused' })
    expect(b.session.op()!.meta.turn).toBe(turn)
    expect(provider.requests).toEqual([])
    await b.session.controls.apply('resume', actor, 'resume')
    expect((await run(b.session)).reason).toBe('completed')
    expect(await facts(b.log)).toContainEqual(
      expect.objectContaining({ action: 'pause', outcome: 'applied' }),
    )
    await b.session.close()
  })

  it('cancel returns pending steers as durable content and ends the turn', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('answer')]) })
    await session.enqueue('next-turn', { content: content('go'), actor })
    await session.step()
    await session.enqueue('next-step', { content: content('return this'), actor })
    await session.controls.apply('cancel', actor, 'cancel')
    expect(session.op()).toBeNull()
    expect((await log.scan({ type: 'turn/end', limit: 1 }))[0]?.data).toMatchObject({ reason: 'aborted' })
    expect((await session.controls.state()).pending).toEqual([])
    expect(await facts(log)).toContainEqual(
      expect.objectContaining({
        action: 'cancel',
        returned: [expect.objectContaining({ content: content('return this') })],
      }),
    )
    await session.close()
  })

  it.each(['steer', 'pause', 'interrupt'] as const)(
    'refuses unsupported %s on the pinned factory',
    async (action) => {
      const { session, log } = await openSession({
        provider: fakeProvider([textTurn('answer')]),
        loopFactory: { ...defaultLoopFactory, controls: {} },
      })
      await expect(session.controls.require(action, actor)).rejects.toMatchObject({
        code: 'E_UNSUPPORTED',
        detail: { reason: 'LOOP_CONTROL_UNSUPPORTED', control: action },
      })
      expect(await facts(log)).toContainEqual(expect.objectContaining({ action, outcome: 'refused' }))
      await session.close()
    },
  )
})
