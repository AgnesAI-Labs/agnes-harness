import { boundToolResult } from '@agnes/core-effects/effects/tool-dispatch'
import type { ToolContext } from '@agnes/extension-api'
import { validateBridgeFrame } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { pluginCreatorTools } from '../../base/extensions/plugin-creator/src/index.js'
import { createBridge } from '../src/extensions/code-mode/bridge.js'
import { bridgeDispatch } from '../src/extensions/code-mode/bridge-dispatch.js'
import { deferred, settles } from '../src/runtime/testkit-utils.js'

it.each(['complete', 'pages', 'stale', 'duplicate', 'oversized-write'])(
  'runs the shipped cell through real candidate tools, output budgets and the bridge: %s',
  async (mode) => {
    const guide = readFileSync(
      new URL('../../base/extensions/plugin-creator/skills/plugin-creator/SKILL.md', import.meta.url),
      'utf8',
    )
    const program = guide.match(/```ts\n([\s\S]*?)\n```/)?.[1]
    if (!program) throw new Error('missing example')
    const candidateId = `candidate-${'a'.repeat(32)}`,
      hash = `sha256-${'b'.repeat(64)}`
    let candidateHash = hash,
      reads = 0,
      written: { action: string; mode?: string; files?: unknown; expectedHash?: string } | undefined
    const sourceFiles = [
      {
        path: 'skills/example/SKILL.md',
        content: `${mode === 'oversized-write' ? '\u0002'.repeat(200_000) : '\ufeff# Example\r\n'}<!-- next-section -->\n`,
      },
      { path: 'other.txt', content: mode === 'complete' ? '中文'.repeat(10_000) : '\u0001'.repeat(100_000) },
      { path: 'empty.txt', content: mode === 'oversized-write' ? '\u0002'.repeat(100_000) : '' },
    ]
    const { ctx } = setup()
    Object.assign(ctx, {
      outputMaxBytes: 4096,
      pluginManage: {
        request: async (input: unknown) => {
          const args = input as { action: string; files?: unknown }
          if (args.action === 'candidate.show') {
            if (++reads === 2 && mode === 'stale') candidateHash = `sha256-${'c'.repeat(64)}`
          } else {
            written = args
          }
          return {
            candidateId,
            candidateHash,
            sourceFiles,
            packageId: 'example',
            state: 'draft',
            baseHash: null,
            reviewHash: null,
            tests: null,
            message: '',
            files: sourceFiles.map((f) => ({ path: f.path, before: null, after: f.content })),
          }
        },
      },
    })
    ctx.tools.invoke = async (name, args) => {
      const tool = pluginCreatorTools.find((tool) => tool.name === name)
      if (!tool) throw new Error('unknown tool')
      const result = boundToolResult(await tool.execute(args as never, ctx), 4096)
      if (mode === 'stale' && reads === 2)
        expect(result).toMatchObject({ isError: true, details: { code: 'E_PACKAGE_PREVIEW_STALE' } })
      expect(result.structured).not.toEqual({ truncated: true })
      expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThan(4096)
      if (mode === 'duplicate' && reads === 2 && result.structured && typeof result.structured === 'object')
        Object.assign(result.structured, { offset: 0 })
      return result
    }
    const bridge = createBridge(ctx)
    const invoke = async (name: string, args: unknown) => {
      const response = (await bridge(
        JSON.parse(JSON.stringify(request('bridge.tools.invoke', { name, args }))),
      )) as { error?: { message: string }; result?: unknown }
      expect(validateBridgeFrame(response).ok).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1048576)
      if (response.error) throw new Error(response.error.message)
      return response.result
    }
    const tools = Object.fromEntries(
      ['plugin_candidate_read', 'plugin_candidate_write'].map((name) => [
        name,
        (args: unknown) => invoke(name, args),
      ]),
    )
    const run = runInNewContext(`(async () => {${program.replace('CANDIDATE_ID', candidateId)}})()`, {
      tools,
      TextEncoder,
    })
    if (['stale', 'duplicate', 'oversized-write'].includes(mode)) {
      await expect(run).rejects.toThrow(
        mode === 'duplicate'
          ? 'Incomplete or changed candidate'
          : mode === 'oversized-write'
            ? 'Full write exceeds'
            : 'internal bridge error',
      )
      expect(written).toBeUndefined()
    } else {
      await expect(run).resolves.toMatchObject({ candidateId, candidateHash: hash })
      // Merge writes only the changed file; unrelated large files stay on the Host.
      expect(written).toMatchObject({ mode: 'merge', expectedHash: hash })
      expect(written?.files).toEqual([
        {
          ...sourceFiles[0],
          content: sourceFiles[0]!.content.replace('<!-- next-section -->', 'A complete small section.'),
        },
      ])
      expect(reads).toBe(
        mode === 'complete'
          ? 1
          : Math.ceil(
              Buffer.byteLength(JSON.stringify({ candidateId, candidateHash: hash, sourceFiles })) / 32768,
            ),
      )
    }
  },
)

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
it.each(['text', 'structured', 'failed-text', 'failed-structured'])(
  'executes the shipped candidate edit example through the %s bridge',
  async (mode) => {
    const guide = readFileSync(
      new URL('../../base/extensions/plugin-creator/skills/plugin-creator/SKILL.md', import.meta.url),
      'utf8',
    )
    const program = guide.match(/```ts\n([\s\S]*?)\n```/)?.[1]
    if (!program) throw new Error('missing shipped example')
    const { ctx } = setup()
    let written: unknown
    ctx.tools.invoke = async (name, args) => {
      if (name === 'plugin_candidate_write') written = args
      const value = mode.startsWith('failed')
        ? { state: 'failed' }
        : {
            candidateId: 'CANDIDATE_ID',
            candidateHash: 'hash',
            sourceFiles: [{ path: 'skills/example/SKILL.md', content: '<!-- next-section -->' }],
          }
      return mode.endsWith('structured')
        ? { content: [], structured: value }
        : { content: [{ type: 'text', text: JSON.stringify(value) }] }
    }
    const invoke = (name: string, args: import('@agnes/protocol').JsonValue) =>
      bridgeDispatch(ctx, { jsonrpc: '2.0', id: 1, method: 'bridge.tools.invoke', params: { name, args } })()
    const tools = {
      plugin_candidate_read: (args: import('@agnes/protocol').JsonValue) =>
        invoke('plugin_candidate_read', args),
      plugin_candidate_write: (args: import('@agnes/protocol').JsonValue) =>
        invoke('plugin_candidate_write', args),
    }
    const run = runInNewContext(`(async () => {${program}})()`, { tools, TextEncoder })
    if (mode.startsWith('failed')) {
      await expect(run).rejects.toThrow('Candidate operation refused')
      expect(written).toBeUndefined()
    } else {
      await run
      expect(written).toMatchObject({
        expectedHash: 'hash',
        files: [{ content: 'A complete small section.' }],
      })
    }
  },
)
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
  ctx.tools.invoke = async () => ({
    content: [],
    isError: true,
    structured: { id: 'run-1', status: 'interrupted' },
  })
  expect(await bridge(request('bridge.tools.invoke', { name: 'workflow', args: {} }))).toMatchObject({
    result: { id: 'run-1', status: 'interrupted' },
  })
})
it('returns the text of a search tool whose structured result lists only paths', async () => {
  const { bridge, ctx } = setup()
  ctx.tools.invoke = async () => ({
    content: [{ type: 'text', text: 'src/a.ts:1:hit' }],
    structured: {
      schema: 'agh.path-references/1',
      references: [{ kind: 'file', path: 'src/a.ts' }],
      total: 1,
      truncated: false,
    },
  })
  expect(
    await bridge(request('bridge.tools.invoke', { name: 'grep', args: { pattern: 'hit' } })),
  ).toMatchObject({
    result: 'src/a.ts:1:hit',
  })
  ctx.tools.invoke = async () => ({ content: [{ type: 'text', text: 'x' }], structured: { rows: 2 } })
  expect(await bridge(request('bridge.tools.invoke', { name: 'harness_propose', args: {} }))).toMatchObject({
    result: { rows: 2 },
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

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
