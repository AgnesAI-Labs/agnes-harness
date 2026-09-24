import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { presetDefaults } from '../src/step/preset.js'
import type { OpContext, Operation } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool, shellTool } from './helpers/open-session.js'

/** A tool the registry holds and the preset does not offer, so `disclosed` and `snapshot` differ. */
const deferredTool = () =>
  ({
    name: 'mcp_jira_search',
    description: 'deferred',
    parameters: { type: 'object' },
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe' as const,
      costHint: undefined,
      deferLoading: true,
      requiresApproval: undefined,
    },
    execute: async () => ({ content: [{ type: 'text' as const, text: '' }] }),
  }) as never

function spy(): { op: Operation; seen: OpContext[] } {
  const seen: OpContext[] = []
  const op: Operation = {
    name: 'spy',
    slot: 'before-inference',
    replay: 'safe',
    applicable: async () => 'applied',
    run: async () => ({}),
    contribute(ctx) {
      seen.push(ctx)
      return {}
    },
  }
  return { op, seen }
}

async function turn(over: Record<string, unknown>) {
  const registry = new ToolRegistry()
  registry.add(readTool(), { source: 'agnes/tools-core', trust: 'builtin' })
  registry.add(shellTool(), { source: 'agnes/tools-core', trust: 'builtin' })
  registry.add(deferredTool(), { source: 'agnes/mcp', trust: 'trusted' })
  const provider = fakeProvider([textTurn('ok')])
  const s = await openSession({ provider, registry, ...over })
  await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
  await s.session.acceptInput()
  await s.session.runInference()
  return s
}

describe('OpContext carries what the request is about to be', () => {
  it('disclosed is the offer the model is shown, not everything the registry holds', async () => {
    const { op, seen } = spy()
    await turn({ operations: [op] })
    expect(seen).toHaveLength(1)
    expect([...(seen[0] as OpContext).disclosed].sort()).toEqual(['read', 'shell'])
    expect((seen[0] as OpContext).snapshot.defs.map((d) => d.name).sort()).toEqual([
      'mcp_jira_search',
      'read',
      'shell',
    ])
  })

  it('disclosed is exactly the tool list the provider was handed', async () => {
    const { op, seen } = spy()
    const s = await turn({ operations: [op] })
    const req = (s.session.d.provider as unknown as { requests: Array<{ tools: { name: string }[] }> })
      .requests[0]
    expect(req?.tools.map((t) => t.name).sort()).toEqual([...(seen[0] as OpContext).disclosed].sort())
  })

  it('model is the slot, route and model id the turn resolves to', async () => {
    const d = presetDefaults()
    const preset = {
      ...d,
      model: { ...d.model, route: { primary: 'ds' }, id: { primary: 'deepseek-chat' } },
    }
    const { op, seen } = spy()
    const s = await turn({ operations: [op], preset })
    expect((seen[0] as OpContext).model).toEqual({ slot: 'primary', route: 'ds', model: 'deepseek-chat' })
    const header = (await s.log.scan({ type: 'request/header', limit: 1 }))[0]
    const data = header?.data as { model: string }
    expect(data.model).toBe('deepseek-chat')
  })
})
