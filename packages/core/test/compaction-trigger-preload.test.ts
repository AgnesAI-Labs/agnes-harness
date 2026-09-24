import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import type { RuntimePromptPreloader } from '../src/runtime/current.js'
import { CompactionRunner } from '../src/step/compaction.js'
import { withPhase } from '../src/step/op-state.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool, shellTool } from './helpers/open-session.js'

const signal = () => new AbortController().signal
const SKILL = 'LOOP SKILL BODY'

function preloader(prompts: string[]): RuntimePromptPreloader {
  return ({ prompt }) => {
    prompts.push(prompt)
    return prompt.includes('LOOP-SKILL')
      ? { section: { id: 'skill:loop', order: 500, text: SKILL, source: 'host' }, suppressTools: ['shell'] }
      : undefined
  }
}

const toolNames = (request: RequestBody | undefined) => (request?.tools ?? []).map((tool) => tool.name)

describe('the current prompt once compaction has masked the trigger', () => {
  it('keeps the preloaded skill section and suppressed tools for every later step of the turn', async () => {
    const provider = fakeProvider([
      toolTurn('read', { path: 'a' }),
      toolTurn('read', { path: 'b' }),
      textTurn('S'),
      toolTurn('read', { path: 'c' }),
      textTurn('done'),
    ])
    const registry = new ToolRegistry()
    registry.add(readTool(), { source: 'agnes/base', trust: 'builtin' })
    registry.add(shellTool(), { source: 'agnes/base', trust: 'builtin' })
    const prompts: string[] = []
    const { session, log } = await openSession({
      provider,
      registry,
      runtimePromptPreloader: preloader(prompts),
    })
    let masked: number[] = []
    session.compaction = new CompactionRunner({
      plan: async (payload) => {
        const nodes = payload.getSurface()
        // [trigger, a, r, a, r]: mask through the first batch, trigger included, keep the second step.
        const firstResult = nodes.findIndex((node) => node.type === 'tool/result')
        const first = nodes[0]
        const end = nodes[firstResult]
        const kept = nodes[firstResult + 1]
        if (!first || !end || !kept) throw new Error('needs a tool loop on the surface')
        masked = nodes.slice(0, firstResult + 1).map((node) => node.seq)
        return {
          keepFromSeq: kept.seq,
          summarizeRange: [first.seq, end.seq],
          prompts: { system: 'S', history: 'summarize it' },
          maxTokens: 100,
          details: { readFiles: [], modifiedFiles: [] },
        }
      },
      onCompact: async () => undefined,
    })
    session.preset.compaction.enabled = false
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'use LOOP-SKILL' }], actor })
    while (provider.calls < 2 || session.op()?.phase.kind !== 'checkpoint') await session.step()
    const op = session.op()
    if (op?.phase.kind !== 'checkpoint') throw new Error('expected a checkpoint after the second batch')
    const triggerSeq = op.meta.triggerSeq
    await session.transition(
      [],
      withPhase(op, { kind: 'compaction', reason: 'threshold', resumeAfter: op.phase }),
    )
    expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
    expect(masked).toContain(triggerSeq)
    expect(session.surface().some((node) => node.seq === triggerSeq)).toBe(false)
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')

    expect(await log.scan({ type: 'x/core/compaction-end', limit: 5 })).toHaveLength(1)
    const main = provider.requests.filter((request) => request.kind === 'inference')
    expect(main).toHaveLength(4)
    const [beforeCompaction] = main
    for (const request of main) {
      expect(request.system).toContain(SKILL)
      expect(toolNames(request)).not.toContain('shell')
      expect(request.system).toBe(beforeCompaction?.system)
      expect(toolNames(request)).toEqual(toolNames(beforeCompaction))
    }
    expect(prompts.every((prompt) => prompt === 'use LOOP-SKILL')).toBe(true)
  })

  it('still reads no prompt for a turn a decided approval opened', async () => {
    let asks = 0
    const receipts = new Map<string, { requestId: string; bindingHash: string; expiresAt: string }>()
    const seams = fakeSeams({
      approval: {
        ask: async (req) => {
          const ticket = `ticket-${++asks}`
          const expiresAt = new Date(1_757_203_200_000 + 1000).toISOString()
          receipts.set(ticket, { requestId: req.requestId, bindingHash: req.bindingHash, expiresAt })
          return { ticket, expiresAt }
        },
        resume: async (ticket) => receipts.get(ticket) ?? null,
      },
    })
    const registry = new ToolRegistry()
    registry.add(shellTool(), { source: 'test', trust: 'builtin' })
    const prompts: string[] = []
    const provider = fakeProvider([toolTurn('shell', { command: 'echo ok' }), textTurn('finished')])
    const { session } = await openSession({
      provider,
      registry,
      seams,
      runtimePromptPreloader: preloader(prompts),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('parked')
    await session.resumeApproval('ticket-1', 'allowed-once', { ...actor, id: 'approver' })
    expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    expect(provider.calls).toBe(2)
    // Only the user-triggered turn had a prompt to preload for; the resumed turn has none.
    expect(prompts).toEqual(['go'])
  })
})
