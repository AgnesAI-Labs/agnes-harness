import type { ToolContext } from '@agnes/extension-api'
import { validateBridgeFrame } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createBridge } from '../src/extensions/code-mode/bridge.js'
import { deferred, settles } from '../src/runtime/testkit-utils.js'

const request = (method: string, params: unknown, id: unknown = 7) => ({ jsonrpc: '2.0', id, method, params })
function setup() {
  const ac = new AbortController()
  const calls: unknown[][] = []
  const ctx = {
    signal: ac.signal,
    tools: {
      invoke: async (...args: unknown[]) => {
        calls.push(['invoke', ...args])
        return {
          content: [{ type: 'text', text: 'public' }],
          details: { secret: 'private-ui' },
          structured: { rows: 2 },
        }
      },
      list: () => [],
    },
    subagent: {
      spawn: async (...args: unknown[]) => {
        calls.push(['spawn', ...args])
        return { childKey: 'child' }
      },
      fork: async (...args: unknown[]) => {
        calls.push(['fork', ...args])
        return 'answer'
      },
      collect: async (...args: unknown[]) => {
        calls.push(['collect', ...args])
        return { childKey: 'child', status: 'completed' }
      },
    },
    artifacts: {
      put: async (...args: unknown[]) => {
        calls.push(['put', ...args])
        return { sha256: 'a'.repeat(64), size: 3, mime: 'text/plain' }
      },
      get: async (...args: unknown[]) => {
        calls.push(['get', ...args])
        return new Uint8Array([1, 2, 3])
      },
    },
    plan: {
      set: async (...args: unknown[]) => {
        calls.push(['plan', ...args])
        return 42
      },
    },
    log: Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((level) => [level, (text: string) => calls.push([level, text])]),
    ),
  } as unknown as ToolContext
  return { ctx, ac, calls, bridge: createBridge(ctx) }
}
it('routes all eight methods using rebuilt values and the trusted call signal', async () => {
  const { bridge, calls, ac } = setup()
  const ref = { sha256: 'a'.repeat(64), size: 3, mime: 'text/plain' }
  const inputs = [
    ['bridge.tools.invoke', { name: 'harness_propose', args: { title: 'x' } }, { rows: 2 }],
    [
      'bridge.subagent.spawn',
      { task: 'x', opts: { isolation: 'worktree', budget: 2 } },
      { childKey: 'child' },
    ],
    ['bridge.subagent.fork', { question: 'q', opts: { model: 'm' } }, 'answer'],
    [
      'bridge.subagent.collect',
      { childKey: 'child', opts: { wait: true } },
      { childKey: 'child', status: 'completed' },
    ],
    ['bridge.artifacts.put', { bytes: [1, 2, 3], meta: { mime: 'text/plain' } }, ref],
    ['bridge.artifacts.get', { ref }, [1, 2, 3]],
    ['bridge.plan.set', { items: [{ id: 'x', text: 'work', status: 'todo' }] }, { seq: 42 }],
    ['bridge.log', { level: 'info', message: 'hello' }, null],
  ] as const
  for (const [method, params, result] of inputs) {
    const reply = await bridge(request(method, params))
    expect(reply).toEqual({ jsonrpc: '2.0', id: 7, result })
    expect(validateBridgeFrame(reply).ok).toBe(true)
  }
  expect(calls).toEqual([
    ['invoke', 'harness_propose', { title: 'x' }, { signal: ac.signal }],
    ['spawn', 'x', { isolation: 'worktree', budget: 2 }],
    ['fork', 'q', { model: 'm' }],
    ['collect', 'child', { wait: true }],
    ['put', new Uint8Array([1, 2, 3]), { mime: 'text/plain' }],
    ['get', ref],
    ['plan', [{ id: 'x', text: 'work', status: 'todo' }]],
    ['info', 'hello'],
  ])
  expect(calls[0]).toEqual(['invoke', 'harness_propose', { title: 'x' }, { signal: ac.signal }])
  expect(calls[4]).toEqual(['put', new Uint8Array([1, 2, 3]), { mime: 'text/plain' }])
})
it.each([
  ['bridge.subagent.spawn', { task: 1 }],
  ['bridge.subagent.spawn', { task: 'x', opts: { isolation: 'root' } }],
  ['bridge.subagent.spawn', { task: 'x', opts: { budget: '2' } }],
  ['bridge.subagent.fork', { question: 'q', opts: { actor: 'root' } }],
  ['bridge.subagent.collect', { childKey: 'x', opts: { wait: 'yes' } }],
  ['bridge.artifacts.put', { bytes: [256] }],
  ['bridge.artifacts.put', { bytes: ['1'] }],
  ['bridge.artifacts.get', { ref: { sha256: 'a'.repeat(64), bytes: 3 } }],
  ['bridge.plan.set', { items: [{ id: 'x', text: 'x', status: 'unknown' }] }],
  ['bridge.log', { level: 'constructor', message: 'x' }],
])('refuses malformed parameters for %s before touching the context', async (method, params) => {
  const { bridge, calls } = setup()
  expect(await bridge(request(method, params))).toMatchObject({ error: { code: -32602 } })
  expect(calls).toHaveLength(0)
})
it('never leaks UI-only details and turns tool failure into an error frame', async () => {
  const { bridge, ctx } = setup()
  expect(
    JSON.stringify(await bridge(request('bridge.tools.invoke', { name: 'read', args: {} }))),
  ).not.toContain('private-ui')
  ctx.tools.invoke = async () => ({ content: [{ type: 'text', text: 'private failure' }], isError: true })
  expect(await bridge(request('bridge.tools.invoke', { name: 'read', args: {} }))).toEqual({
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32603, message: 'internal bridge error' },
  })
})
it('falls back to public text when a tool has no structured result', async () => {
  const { bridge, ctx } = setup()
  ctx.tools.invoke = async () => ({ content: [{ type: 'text', text: 'plain result' }] })
  expect(await bridge(request('bridge.tools.invoke', { name: 'read', args: {} }))).toEqual({
    jsonrpc: '2.0',
    id: 7,
    result: 'plain result',
  })
})
it('cancels in-flight work and refuses subsequent dispatch even if the port ignores cancellation', async () => {
  const { bridge, ctx, ac, calls } = setup()
  const entered = deferred<void>(),
    held = deferred<Awaited<ReturnType<ToolContext['tools']['invoke']>>>()
  ctx.tools.invoke = async () => {
    calls.push(['held'])
    entered.resolve(undefined)
    return held.promise
  }
  const pending = bridge(request('bridge.tools.invoke', { name: 'read', args: {} }))
  try {
    await settles(entered.promise)
    ac.abort()
    expect(await settles(pending)).toMatchObject({ error: { code: -32800 } })
    expect(await bridge(request('bridge.log', { level: 'info', message: 'late' }))).toMatchObject({
      error: { code: -32800 },
    })
    expect(calls).toEqual([['held']])
  } finally {
    held.resolve({ content: [{ type: 'text', text: 'late' }] })
  }
})
it('forwards concurrent calls independently: no internal queue serializes them', async () => {
  const { bridge, ctx } = setup()
  const heldSlow = deferred<Awaited<ReturnType<ToolContext['tools']['invoke']>>>()
  const order: string[] = []
  ctx.tools.invoke = async (
    ...args: unknown[]
  ): Promise<Awaited<ReturnType<ToolContext['tools']['invoke']>>> => {
    const name = args[0] as string
    order.push(`start:${name}`)
    const result =
      name === 'slow'
        ? await heldSlow.promise
        : { content: [{ type: 'text' as const, text: name }], isError: false }
    order.push(`end:${name}`)
    return result
  }
  const slow = bridge(request('bridge.tools.invoke', { name: 'slow', args: {} }, 'slow-id'))
  const fast = await settles(bridge(request('bridge.tools.invoke', { name: 'fast', args: {} }, 'fast-id')))
  // 'fast' resolves while 'slow' is still parked on an unresolved promise: proves the bridge
  // has no homegrown queue that would force the two calls to run one after another.
  expect(fast).toEqual({ jsonrpc: '2.0', id: 'fast-id', result: 'fast' })
  expect(order).toEqual(['start:slow', 'start:fast', 'end:fast'])
  heldSlow.resolve({ content: [{ type: 'text' as const, text: 'slow' }], isError: false })
  expect(await settles(slow)).toEqual({ jsonrpc: '2.0', id: 'slow-id', result: 'slow' })
})
