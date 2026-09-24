import { presetDefaults, ToolRegistry } from '@agnes/core'
import { actor, fakeProvider, openSession, textTurn, toolTurn } from '@agnes/core/testkit'
import { expect, it } from 'vitest'
import { createBridge } from '../src/extensions/code-mode/bridge.js'
import { tool } from './fixtures/sdk.js'

it('returns a nested tool structured result through the real core re-entry path', async () => {
  const registry = new ToolRegistry()
  const target = tool('structured_target')
  target.execute = async () => ({
    content: [{ type: 'text', text: 'human fallback' }],
    structured: { rows: 2, source: 'actual child result' },
  })
  const probe = tool('structured_bridge_probe')
  let reply: unknown
  probe.execute = async (_args, ctx) => {
    reply = await createBridge(ctx)({
      jsonrpc: '2.0',
      id: 'structured',
      method: 'bridge.tools.invoke',
      params: { name: 'structured_target', args: {} },
    })
    return { content: [{ type: 'text', text: JSON.stringify(reply) }] }
  }
  registry.add(target, { source: 'fixture/bridge', trust: 'trusted' })
  registry.add(probe, { source: 'fixture/bridge', trust: 'trusted' })
  const provider = fakeProvider([toolTurn('structured_bridge_probe', {}), textTurn('done')])
  const { session } = await openSession({ registry, provider })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'run structured probe' }] })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 'structured',
      result: { rows: 2, source: 'actual child result' },
    })
  } finally {
    await session.close()
  }
})

it('a real model tool call writes a plan through core and returns its actual depth refusal', async () => {
  const registry = new ToolRegistry()
  const def = tool('bridge_probe')
  const replies: unknown[] = []
  def.execute = async (_args, ctx) => {
    const bridge = createBridge(ctx)
    replies.push(
      await bridge({
        jsonrpc: '2.0',
        id: 'plan',
        method: 'bridge.plan.set',
        params: { items: [{ id: 'work', text: 'verified bridge plan', status: 'todo' }] },
      }),
    )
    replies.push(
      await bridge({
        jsonrpc: '2.0',
        id: 'depth',
        method: 'bridge.tools.invoke',
        params: { name: 'read', args: {} },
      }),
    )
    return { content: [{ type: 'text', text: JSON.stringify(replies) }] }
  }
  registry.add(def, { source: 'fixture/bridge', trust: 'trusted' })
  const preset = presetDefaults()
  preset.depthLimit = 0
  const provider = fakeProvider([toolTurn('bridge_probe', {}), textTurn('done')])
  const { session, log } = await openSession({ registry, preset, provider })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'run the bridge check' }] })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(log.latest('plan.items')).toEqual({
      items: [{ id: 'work', text: 'verified bridge plan', status: 'todo' }],
    })
    expect(replies[0]).toMatchObject({ jsonrpc: '2.0', id: 'plan', result: { seq: expect.any(Number) } })
    expect(replies[1]).toEqual({
      jsonrpc: '2.0',
      id: 'depth',
      error: { code: 1003, message: 'DEPTH_EXCEEDED' },
    })
    expect(provider.requests).toHaveLength(2)
    expect(JSON.stringify(provider.requests[1])).toContain('DEPTH_EXCEEDED')
  } finally {
    await session.close()
  }
})
