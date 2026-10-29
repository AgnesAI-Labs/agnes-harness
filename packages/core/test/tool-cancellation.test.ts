import { getEventListeners } from 'node:events'
import type { ToolDef } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

const parameters = Type.Object({})
function tool(execute: ToolDef<typeof parameters>['execute']): ToolDef<typeof parameters> {
  return {
    name: 'bounded',
    description: 'bounded call',
    parameters,
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: undefined,
    },
    execute,
  }
}
async function ready(def: ToolDef, seams = fakeSeams()) {
  const registry = new ToolRegistry()
  registry.add(def, { source: 'test', trust: 'builtin' })
  const opened = await openSession({
    provider: fakeProvider([toolTurn('bounded', {}), toolTurn('bounded', {}), textTurn('recovered')]),
    registry,
    seams,
  })
  await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  await opened.session.acceptInput()
  await opened.session.runInference()
  return opened
}

describe('tool cancellation lifetime', () => {
  it.each(['approval', 'tool'] as const)(
    'drains a stop during %s and accepts another turn',
    async (stage) => {
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let toolSignal: AbortSignal | undefined
      let releaseTool = () => {}
      let waiting = true
      const def = tool(async (_args, ctx) => {
        toolSignal = ctx.signal
        if (stage === 'tool' && waiting) {
          entered()
          await new Promise<void>((resolve) => {
            releaseTool = resolve
          })
        }
        return { content: [{ type: 'text', text: 'finished' }] }
      })
      // A computer-use-style side effect cannot be replayed or reported as never having happened.
      def.meta.isReadOnly = false
      def.meta.replay = 'never'
      def.meta.requiresApproval = 'always'
      const seams = fakeSeams({
        approval: {
          ask: async () => {
            if (stage === 'approval' && waiting) {
              entered()
              return new Promise(() => {})
            }
            return { verdict: 'allowed-once', answeredBy: actor }
          },
        },
      })
      const { session, log } = await ready(def, seams)
      try {
        const running = session.run({ until: 'turn-end', signal: new AbortController().signal })
        await started
        await session.controls.apply('cancel', actor, 'stop')
        expect((await running).reason).toBe('aborted')
        expect(session.op()).toBeNull()
        if (stage === 'tool') expect(toolSignal?.aborted).toBe(true)
        expect(
          [...session.state.registers.decisionStates.values()].every(
            ({ value }) => value.consumption || value.invalidation || value.result,
          ),
        ).toBe(true)
        expect((await log.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
          reason: 'aborted',
        })
        waiting = false
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'continue' }], actor })
        expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
      } finally {
        releaseTool()
        await session.close()
      }
    },
  )

  it('does not start execute when authorization finishes after cancellation', async () => {
    let cancel = () => {}
    let executions = 0
    const seams = fakeSeams({
      principals: {
        authorize: async () => {
          cancel()
          return { decisionId: 'cancel-race', effect: 'allow', reason: 'allowed' }
        },
      },
    })
    const { session, log } = await ready(
      tool(async () => {
        executions++
        return { content: [{ type: 'text', text: 'must not run' }] }
      }),
      seams,
    )
    cancel = () => session.ac.abort()
    expect(await session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'aborted' })
    expect(executions).toBe(0)
    expect((await log.scan({ type: 'tool/result', toSeq: log.lastSeq }))[0]?.data).toMatchObject({
      isError: true,
      code: 'CANCELLED',
    })
    expect(session.pendingEffects()).toEqual([])
    cancel = () => {}
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'retry' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(executions).toBe(1)
    expect((await log.scan({ type: 'tool/result', toSeq: log.lastSeq })).at(-1)?.data).toMatchObject({
      isError: false,
    })
    expect(session.pendingEffects()).toEqual([])
  })

  it.each(['success', 'throw', 'timeout'] as const)(
    'releases parent listener and closes tool signal after $0',
    async (mode) => {
      const signals: AbortSignal[] = []
      const { session, log } = await ready(
        tool(async (_args, ctx) => {
          signals.push(ctx.signal)
          expect(ctx.signal.aborted).toBe(false)
          if (mode === 'throw') throw new Error('tool failure')
          if (mode === 'timeout') return new Promise(() => {})
          return { content: [{ type: 'text', text: 'ok' }] }
        }),
      )
      if (mode === 'timeout') session.preset.tools.timeoutMs = 5
      const parent = session.ac.signal
      const before = getEventListeners(parent, 'abort').length
      await session.runToolsPhase()
      expect(signals).toHaveLength(1)
      expect(signals[0]?.aborted).toBe(true)
      expect(parent.aborted).toBe(false)
      expect(getEventListeners(parent, 'abort')).toHaveLength(before)
      const settlements = await log.scan({ type: 'effect/settled', toSeq: log.lastSeq })
      expect(settlements.at(-1)?.data).toMatchObject({
        outcome: mode === 'success' ? 'ok' : mode === 'throw' ? 'error' : 'aborted',
      })
      expect(session.pendingEffects()).toEqual([])
    },
  )
})
