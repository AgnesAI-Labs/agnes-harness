import type { HarnessEntry, OpContext, RefineProposal, SeamImplementations } from '@agnes/core'
import { actor, fakeProvider, fakeSeams, openSession, textTurn } from '@agnes/core/testkit'
import type { ExtensionAPI, HookHandler, ToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { createEcosystemExtensions } from '../../../src/ecosystem.js'
import { operations } from '../../../src/index.js'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { refineOperation } from '../src/operation.js'
import { RefineQueue } from '../src/queue.js'

const entry = (id: string, scope: HarnessEntry['scope'] = 'local'): HarnessEntry => ({
  kind: 'memory',
  id,
  title: id,
  content: `content:${id}`,
  scope,
  version: 1,
  source: 'test',
})
const proposal = (over: Partial<RefineProposal> = {}): RefineProposal => ({
  proposalId: 'p1',
  trigger: 'auto',
  edits: [{ op: 'upsert', entry: entry('m1') }],
  baseline: [],
  rationale: 'measured improvement',
  evidenceSeqs: [1],
  ...over,
})
const rawPreset = {
  harness: {
    max_entries: { prompt: 10, memory: 50, skill: 30, subagent: 10 },
    max_chars_per_entry: 2_000,
    auto_refine: { enabled: true, cooldown_turns: 5, global_needs_human: true },
  },
}

function context(
  session: Awaited<ReturnType<typeof openSession>>['session'],
  turn: number,
  verdict = 'pass',
) {
  return {
    session,
    preset: session.preset,
    state: {
      meta: { turn, triggerSeq: 1 },
      step: 1,
      taint: false,
    },
    snapshot: session.d.registry.snapshot(session.lastSeq),
    signal: new AbortController().signal,
    disclosed: [],
    model: { slot: 'primary', route: 'default', model: 'default' },
    verifier: { verdict, reasons: [] },
  } as unknown as OpContext
}

describe('refine after-core operation', () => {
  it('shares the production ecosystem queue with the assembled operation factory', async () => {
    const init = fakeSeamInit({ preset: rawPreset })
    const tools: ToolDef[] = []
    const api = {
      registerTool(tool: ToolDef) {
        tools.push(tool)
        return () => undefined
      },
      registerHook(_event: string, _handler: HookHandler<never>) {
        return () => undefined
      },
      events: { append: async () => 1 },
    } as unknown as ExtensionAPI
    await createEcosystemExtensions(init).refine()(api)

    const tool = tools.find((candidate) => candidate.name === 'harness_propose')
    if (!tool) throw new Error('production refine extension did not register harness_propose')
    await tool.execute(
      {
        proposalId: 'from-production-tool',
        trigger: 'manual',
        rationale: 'exercise the shared durable queue',
        evidenceSeqs: [1],
        edits: [{ op: 'upsert', entry: entry('from-tool') }],
      },
      fakeToolContext(),
    )

    const { session } = await openSession({ provider: fakeProvider([]) })
    const operation = operations.refine({ adapters: init.adapters, profile: init.profile })
    expect(await operation.applicable(context(session, 1))).toBe('applied')
    await operation.run(context(session, 1))
    expect([...session.state.registers.harnessEntries.values()][0]?.value.id).toBe('from-tool')
    await session.close()
  })

  it('receives the real verifier result through the Core after-core delivery path', async () => {
    const init = fakeSeamInit({ preset: rawPreset })
    const queue = new RefineQueue(init.adapters.storage.table('refine_queue'))
    queue.push(proposal())
    const operation = refineOperation({ queue, preset: rawPreset })
    const { session } = await openSession({
      provider: fakeProvider([textTurn('done')]),
      operations: [operation],
      seams: fakeSeams({ verifier: { verify: async () => ({ verdict: 'pass', reasons: [] }) } }),
    })

    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'finish' }],
      actor,
    })
    await expect(
      session.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      reason: 'completed',
    })
    expect([...session.state.registers.harnessEntries.values()][0]?.value.id).toBe('m1')
    expect(queue.next()).toBeUndefined()
    await session.close()
  })

  it('applies after a passing verifier and enforces cooldown', async () => {
    const init = fakeSeamInit({ preset: rawPreset })
    const queue = new RefineQueue(init.adapters.storage.table('refine_queue'))
    queue.push(proposal())
    const { session } = await openSession({ provider: fakeProvider([]) })
    const operation = refineOperation({ queue, preset: rawPreset })

    expect(await operation.applicable(context(session, 10))).toBe('applied')
    await operation.run(context(session, 10))
    expect(queue.next()).toBeUndefined()
    expect([...session.state.registers.harnessEntries.values()][0]?.value.id).toBe('m1')

    queue.push(proposal({ proposalId: 'p2', edits: [{ op: 'upsert', entry: entry('m2') }] }))
    expect(await operation.applicable(context(session, 12))).toBe('skip')
    expect(await operation.applicable(context(session, 15))).toBe('applied')
    await session.close()
  })

  it('requires approval for a global edit and rejects a refusal', async () => {
    const ask = vi.fn(async () => 'rejected' as const)
    const seams: SeamImplementations = { ...fakeSeams(), approval: { ...fakeSeams().approval, ask } }
    const { session } = await openSession({ provider: fakeProvider([]), seams })
    const init = fakeSeamInit({ preset: rawPreset })
    const queue = new RefineQueue(init.adapters.storage.table('refine_queue'))
    queue.push(proposal({ edits: [{ op: 'upsert', entry: entry('global', 'global') }] }))
    const operation = refineOperation({ queue, preset: rawPreset })

    await operation.run(context(session, 4))
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'refine', summary: 'measured improvement' }),
    )
    expect(queue.next()).toBeUndefined()
    expect([...session.state.registers.harnessEntries.values()]).toEqual([])
    await session.close()
  })

  it('accepts a compact trigger from the durable extension event even when verification fails', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await session.append([session.ev('x/agnes/refine/compact-trigger', {})])
    const init = fakeSeamInit({ preset: rawPreset })
    const queue = new RefineQueue(init.adapters.storage.table('refine_queue'))
    queue.push(proposal())
    const operation = refineOperation({ queue, preset: rawPreset })

    expect(await operation.applicable(context(session, 2, 'fail'))).toBe('applied')
    await session.close()
  })
})
