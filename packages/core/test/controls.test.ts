import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { defaultLoopFactory } from '@agnes/loop-default'
import { describe, expect, it } from 'vitest'
import type { Provider } from '@agnes/protocol'
import { Kernel } from '../src/kernel.js'
import { createLoopContext } from '../src/loop/ports.js'
import { model, setupWith, spawnChild } from './helpers/child-traces.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, sentFor, textTurn, toolTurn } from './helpers/fake-provider.js'
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
    const port = await createLoopContext(session)
    expect(await port.input.claim('next-step')).toBeNull()
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
    await expect(
      session.controls.edit(first.itemId, content('too late'), actor, 'late-edit'),
    ).rejects.toMatchObject({ code: 'E_RELATION' })
    await expect(session.removeQueuedInput(first.itemId, actor, 'late-withdraw')).rejects.toMatchObject({
      code: 'E_RELATION',
    })
    expect(await facts(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'refused', operation: 'edit', reason: 'QUEUED_INPUT_GONE' }),
        expect.objectContaining({ outcome: 'refused', operation: 'withdraw', reason: 'QUEUED_INPUT_GONE' }),
      ]),
    )
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

  it('pages all control facts so reload recovery cannot lose old returned steers', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('unused')]) })
    const rows = [
      session.controls.fact('cancel', 'requested', actor, { returned: [{ content: content('old draft') }] }),
      ...Array.from({ length: 205 }, () => session.controls.fact('steer', 'withdrawn', actor)),
    ]
    await log.append(rows)
    const first = await session.controls.state(0)
    expect(first.factsMore).toBe(true)
    expect(first.facts[0]?.details).toMatchObject({ returned: [{ content: content('old draft') }] })
    const second = await session.controls.state(first.factsThrough)
    expect(second.factsMore).toBe(false)
    expect([...first.facts, ...second.facts]).toHaveLength(206)
    expect(new Set([...first.facts, ...second.facts].map((fact) => fact.seq)).size).toBe(206)
    await session.close()
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

  it('pauses while a model reply drains and resumes the same turn after its boundary', async () => {
    const entered = gate(),
      done = gate()
    const base = fakeProvider([textTurn('answer')])
    const provider: Provider = {
      ...base,
      async *infer(request) {
        entered.release()
        await done.wait
        yield* base.infer(request, { signal: new AbortController().signal })
      },
    }
    const { session, log } = await openSession({ provider })
    await session.enqueue('next-turn', { content: content('go'), actor })
    const running = run(session)
    await entered.wait
    const turn = session.op()!.meta.turn
    await session.controls.apply('pause', actor, 'pause-model')
    done.release()
    expect((await running).reason).toBe('parked')
    expect(session.op()!.meta.turn).toBe(turn)
    expect(await log.scan({ type: 'turn/end', limit: 1 })).toEqual([])
    await session.controls.apply('resume', actor, 'resume-model')
    expect((await run(session)).reason).toBe('completed')
    expect(base.requests).toHaveLength(1)
    await session.close()
  })

  it('stops a workflow child without completing its parent wait, and continues with a recorded message', async () => {
    const entered = gate()
    let calls = 0
    const base = fakeProvider([textTurn('continued child')])
    const provider: Provider = {
      ...base,
      models: () => [model()],
      async *infer(request, options) {
        if (calls++ === 0) {
          yield sentFor(request)
          entered.release()
          await new Promise<void>((resolve) =>
            options.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          throw new Error('cooperative model stop')
        }
        yield* base.infer(request, options)
      },
    }
    const { k, parent } = await setupWith(provider, Kernel.create)
    const handle = await spawnChild(parent, 'task')
    let completed = false
    const waiting = handle.run('task').then((result) => {
      completed = true
      return result
    })
    await entered.wait
    await parent.controls.apply('child-stop', actor, 'stop-child', undefined, { id: handle.key })
    expect(completed).toBe(false)
    expect((await parent.controls.state()).children.find((child) => child.id === handle.key)).toMatchObject({
      status: 'interrupted',
      controls: { continue: true },
    })
    await expect(
      parent.controls.apply('child-stop', actor, 'foreign', undefined, { id: 'unowned' }),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await parent.controls.apply('child-continue', actor, 'continue-child', undefined, {
      id: handle.key,
      text: 'new task',
    })
    expect((await waiting).text).toBe('continued child')
    const rows = await parent.scan({ type: 'x/core/control', limit: 20 })
    expect(
      rows.filter((row) => (row.data as { outcome?: string }).outcome === 'applied').map((row) => row.actor),
    ).toEqual([actor, actor])
    await k.close()
  })

  it.each(['steer', 'pause', 'interrupt'] as const)(
    'refuses unsupported %s on the pinned factory',
    async (action) => {
      const { session, log } = await openSession({
        provider: fakeProvider([textTurn('answer')]),
        loopFactory: { ...defaultLoopFactory, controls: {} },
      })
      await session.enqueue('next-turn', { content: content('go'), actor })
      await session.step()
      const operation =
        action === 'steer'
          ? session.enqueue('next-step', { content: content('change'), actor })
          : session.controls.apply(action, actor, 'unsupported', 'missing')
      await expect(operation).rejects.toMatchObject({
        code: 'E_UNSUPPORTED',
        detail: { reason: 'LOOP_CONTROL_UNSUPPORTED', control: action },
      })
      expect(await facts(log)).toContainEqual(expect.objectContaining({ action, outcome: 'refused' }))
      await session.close()
    },
  )
})
