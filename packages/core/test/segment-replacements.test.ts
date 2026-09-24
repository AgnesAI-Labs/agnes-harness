import type { ToolResult } from '@agnes/extension-api'
import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { replacementFor, validateReplacements } from '../src/step/reentry.js'
import type { Operation, ReplacementOperation, SessionDeps } from '../src/step/session.js'
import type { CoreError } from '../src/types.js'
import { fakeProvider, sentFor, textTurn, toolTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, shellTool } from './helpers/open-session.js'

const applicable = async () => 'applied' as const
const compatibilityRun = async () => ({})
const stream = async function* (events: InferenceEvent[]): AsyncIterable<InferenceEvent> {
  yield* events
}
const segments = (operations: Operation[]): NonNullable<SessionDeps['segments']> =>
  Object.fromEntries(
    operations.flatMap((operation) =>
      typeof operation.slot === 'object'
        ? [[operation.slot.replace, replacementFor(operations, operation.slot.replace)]]
        : [],
    ),
  ) as NonNullable<SessionDeps['segments']>

describe('typed core segment replacements', () => {
  it.each([
    { verdict: 'allowed-permanent', reason: 'completed' },
    { verdict: 'invented-verdict', reason: 'error' },
  ] as const)('validates Approval replacement verdict $verdict', async ({ verdict, reason }) => {
    const approval: ReplacementOperation<'Approval'> = {
      name: `approval-${verdict}`,
      slot: { replace: 'Approval' },
      replay: 'never',
      applicable,
      run: compatibilityRun,
      replace: async () => verdict as never,
    }
    const operations: Operation[] = [approval]
    const registry = new ToolRegistry()
    registry.add(shellTool(), { source: 'test', trust: 'builtin' })
    const opened = await openSession({
      provider: fakeProvider([toolTurn('shell', { command: 'x' }), textTurn('done')]),
      registry,
      operations,
      segments: segments(operations),
      resolvedProfileHash: `sha256-${'a'.repeat(64)}`,
    })
    await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    const outcome = await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(outcome.reason).toBe(reason)
    if (verdict === 'allowed-permanent') {
      expect((await opened.log.scan({ type: 'approval/decided', limit: 5 }))[0]?.data).toMatchObject({
        verdict: 'allowed-permanent',
      })
    } else {
      expect(await opened.log.scan({ type: 'x/core/operation-failed', limit: 5 })).toHaveLength(1)
    }
  })

  it('executes all six replacements while core retains transitions and effect settlement', async () => {
    const seen: string[] = []
    let inference = 0
    let executedBuiltin = false
    const inbox: ReplacementOperation<'Inbox'> = {
      name: 'replace-inbox',
      slot: { replace: 'Inbox' },
      replay: 'safe',
      applicable,
      run: compatibilityRun,
      replace: async ({ input }) => {
        seen.push('Inbox')
        const item = input.inbox?.items.find((candidate) => candidate.target === input.target)
        return item ? { action: 'claim', itemId: item.itemId } : { action: 'none' }
      },
    }
    const budget: ReplacementOperation<'Budget'> = {
      name: 'replace-budget',
      slot: { replace: 'Budget' },
      replay: 'safe',
      applicable,
      run: compatibilityRun,
      replace: async ({ input }) => {
        seen.push(`Budget:${input.nextStep}`)
        return { action: 'allow' }
      },
    }
    const infer: ReplacementOperation<'Inference'> = {
      name: 'replace-inference',
      slot: { replace: 'Inference' },
      replay: 'never',
      applicable,
      run: compatibilityRun,
      replace: async ({ input }) => {
        seen.push(`Inference:${input.options.toolNames.join(',')}`)
        inference++
        return stream(
          inference === 1
            ? [
                sentFor(input.request),
                {
                  type: 'toolcall_end',
                  call: { toolUseId: '', name: 'shell', args: { command: 'safe' }, ordinal: 0 },
                  via: 'native',
                },
                usage(),
                { type: 'done', reason: 'toolUse' },
              ]
            : [
                sentFor(input.request),
                { type: 'text_delta', delta: 'replacement answer' },
                usage(),
                { type: 'done', reason: 'stop' },
              ],
        )
      },
    }
    const approval: ReplacementOperation<'Approval'> = {
      name: 'replace-approval',
      slot: { replace: 'Approval' },
      replay: 'never',
      applicable,
      run: compatibilityRun,
      replace: async ({ input }) => {
        seen.push(`Approval:${input.request.kind}`)
        return 'allowed-once'
      },
    }
    const toolExecution: ReplacementOperation<'ToolExecution'> = {
      name: 'replace-tool',
      slot: { replace: 'ToolExecution' },
      replay: 'never',
      applicable,
      run: compatibilityRun,
      replace: async ({ input }) => {
        seen.push(`ToolExecution:${input.name}`)
        return { content: [{ type: 'text', text: 'replacement tool result' }] } satisfies ToolResult
      },
    }
    const stopGate: ReplacementOperation<'StopGate'> = {
      name: 'replace-stop',
      slot: { replace: 'StopGate' },
      replay: 'safe',
      applicable,
      run: compatibilityRun,
      replace: async ({ input }) => {
        seen.push(`StopGate:${input.turn}/${input.step}`)
        return {
          action: 'end',
          reason: 'completed',
          effects: [
            {
              type: 'x/test/replaced-stop',
              origin: 'system',
              trust: 'trusted',
              actor,
              data: {},
              ignorable: true,
            },
          ],
        }
      },
    }
    const operations: Operation[] = [inbox, budget, infer, approval, toolExecution, stopGate]
    const registry = new ToolRegistry()
    const tool = shellTool(async () => {
      executedBuiltin = true
      throw new Error('built-in tool must not execute')
    })
    registry.add(tool, { source: 'test', trust: 'builtin' })
    const provider = fakeProvider([toolTurn('shell', {}), textTurn('built-in')])
    const opened = await openSession({
      provider,
      registry,
      operations,
      segments: segments(operations),
      seams: fakeSeams({ approval: { ask: async () => 'rejected', resume: async () => null } }),
    })
    await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'start' }] })
    await opened.session.acceptInput()
    await opened.session.enqueue('next-step', { actor, content: [{ type: 'text', text: 'steer' }] })

    expect(
      (await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
    ).toBe('completed')
    expect(seen).toContain('Inbox')
    expect(seen.filter((value) => value.startsWith('Budget:'))).toHaveLength(2)
    expect(seen.filter((value) => value.startsWith('Inference:'))).toHaveLength(2)
    expect(seen).toContain('Approval:tool')
    expect(seen).toContain('ToolExecution:shell')
    expect(seen.some((value) => value.startsWith('StopGate:'))).toBe(true)
    expect(provider.calls).toBe(0)
    expect(executedBuiltin).toBe(false)
    expect(opened.session.pendingEffects()).toEqual([])
    expect(await opened.log.scan({ type: 'x/test/replaced-stop', limit: 5 })).toHaveLength(1)
    const result = (await opened.log.scan({ type: 'tool/result', limit: 5 }))[0]?.data as {
      content: Array<{ text?: string }>
    }
    expect(result.content[0]?.text).toBe('replacement tool result')
  })

  it('delegates to the built-in exactly once and rejects contradictory post-delegation results', async () => {
    const infer: ReplacementOperation<'Inference'> = {
      name: 'around-inference',
      slot: { replace: 'Inference' },
      replay: 'never',
      applicable,
      run: compatibilityRun,
      replace: async ({ next }) => next(),
    }
    const operations: Operation[] = [infer]
    const provider = fakeProvider([textTurn('built-in answer')])
    const opened = await openSession({ provider, operations, segments: segments(operations) })
    await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    expect(
      (await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
    ).toBe('completed')
    expect(provider.calls).toBe(1)

    const bad: ReplacementOperation<'Budget'> = {
      name: 'bad-around-budget',
      slot: { replace: 'Budget' },
      replay: 'safe',
      applicable,
      run: compatibilityRun,
      replace: async ({ next }) => {
        await next()
        return { action: 'end', reason: 'blocked' }
      },
    }
    const badOps: Operation[] = [bad]
    const failed = await openSession({
      provider: fakeProvider([textTurn('unused')]),
      operations: badOps,
      segments: segments(badOps),
    })
    await failed.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    const outcome = await failed.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(outcome).toMatchObject({ reason: 'error', error: { code: 'E_STEP_FAILED' } })
    expect(failed.session.pendingEffects()).toEqual([])
    expect(await failed.log.scan({ type: 'x/core/operation-failed', limit: 5 })).toHaveLength(1)
  })

  it('rejects duplicate or untyped replacers at assembly validation', () => {
    const op = (name: string): ReplacementOperation<'Inbox'> => ({
      name,
      slot: { replace: 'Inbox' },
      replay: 'safe',
      applicable,
      run: compatibilityRun,
      replace: async () => ({ action: 'none' }),
    })
    expect(() => validateReplacements([op('a'), op('b')])).toThrowError(
      expect.objectContaining<Partial<CoreError>>({ code: 'E_REGISTRY_DUPLICATE' }),
    )
    expect(() => validateReplacements([{ ...op('missing'), replace: undefined } as never])).toThrow(
      'has no typed replace handler',
    )
  })

  it('rejects control/effect rows from a replacement decision before they can become pending', async () => {
    const stop: ReplacementOperation<'StopGate'> = {
      name: 'unsafe-stop',
      slot: { replace: 'StopGate' },
      replay: 'safe',
      applicable,
      run: compatibilityRun,
      replace: async () =>
        ({
          action: 'end',
          reason: 'completed',
          effects: [
            {
              type: 'effect/intent',
              origin: 'system',
              trust: 'trusted',
              actor,
              data: { effectId: 'rogue', kind: 'tool', replay: 'never', argsSeq: 1 },
            },
          ],
        }) as never,
    }
    const operations: Operation[] = [stop]
    const opened = await openSession({
      provider: fakeProvider([textTurn('answer')]),
      operations,
      segments: segments(operations),
    })
    await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    expect(
      await opened.session.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).toMatchObject({ reason: 'error', error: { code: 'E_STEP_FAILED' } })
    expect(opened.session.pendingEffects()).toEqual([])
    const intents = await opened.log.scan({ type: 'effect/intent', limit: 20 })
    expect(intents.some((row) => (row.data as { effectId?: string }).effectId === 'rogue')).toBe(false)
    expect(await opened.log.scan({ type: 'x/core/operation-failed', limit: 5 })).toHaveLength(1)
  })
})
