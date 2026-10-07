import { describe, expect, it } from 'vitest'
import type { ToolRuntimeCall, ToolRuntimeExecution } from '@agnes/extension-api'
import { defaultToolRuntimeProvider } from '../src/effects/tool-runtime.js'
import { ToolPolicyRegistry, ToolRuntimeRegistry } from '../src/effects/tool-providers.js'
import { LoopEventRegistry } from '../src/loop/events.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import { policy } from '../../../examples/policies/read-only/index.mjs'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import {
  actor,
  noTimers,
  readTool,
  shellTool,
  testFsOps,
  testWorkspaceInvocation,
} from './helpers/open-session.js'

const signal = () => new AbortController().signal
const call = (id: string, concurrencySafe = true): ToolRuntimeCall => ({
  id,
  name: 'read',
  args: {},
  concurrencySafe,
})
const result = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('tool providers', () => {
  it('bounds parallel-safe work, preserves result order and treats exclusive calls as barriers', async () => {
    const runtime = defaultToolRuntimeProvider.create({ maxParallel: 2 })
    const release = deferred(),
      bothStarted = deferred()
    const started: string[] = []
    const finished: string[] = []
    const execution: ToolRuntimeExecution = {
      async dispatch(input) {
        started.push(input.id)
        if (input.id === 'b') bothStarted.resolve()
        if (input.id === 'a' || input.id === 'b') await release.promise
        if (input.id === 'exclusive') expect(finished).toEqual(['a', 'b', 'c'])
        if (input.id === 'last') expect(finished).toContain('exclusive')
        finished.push(input.id)
        return result(input.id)
      },
    }
    const batch = runtime.batch(
      [call('a'), call('b'), call('c'), call('exclusive', false), call('last')],
      execution,
      signal(),
    )
    await bothStarted.promise
    expect(started).toEqual(['a', 'b'])
    release.resolve()
    expect((await batch).map((r) => r.content)).toEqual(
      ['a', 'b', 'c', 'exclusive', 'last'].map((id) => result(id).content),
    )
    await runtime.dispose()
  })

  it('cancels queued work and drains started work before resolving cancellation', async () => {
    const runtime = defaultToolRuntimeProvider.create({ maxParallel: 1 })
    const release = deferred(),
      started = deferred()
    const ran: string[] = []
    const batch = runtime.batch(
      [call('a'), call('b')],
      {
        async dispatch(input, signal) {
          ran.push(input.id)
          started.resolve()
          await release.promise
          expect(signal.aborted).toBe(true)
          return result(input.id)
        },
      },
      signal(),
    )
    await started.promise
    let drained = false
    const cancel = Promise.resolve(runtime.cancel()).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    release.resolve()
    await cancel
    expect(ran).toEqual(['a'])
    expect((await batch)[1]?.isError).toBe(true)
    await runtime.dispose()
  })

  it('drains siblings after a dispatch fails and stops replenishing the pool', async () => {
    const runtime = defaultToolRuntimeProvider.create({ maxParallel: 2 })
    const release = deferred(),
      started = deferred()
    const ran: string[] = []
    const batch = runtime.batch(
      [call('a'), call('b'), call('c')],
      {
        async dispatch(input) {
          ran.push(input.id)
          if (input.id === 'a') throw new Error('dispatch failed')
          started.resolve()
          await release.promise
          return result(input.id)
        },
      },
      signal(),
    )
    const rejected = expect(batch).rejects.toThrow('dispatch failed')
    await started.promise
    release.resolve()
    await rejected
    expect(ran).toEqual(['a', 'b'])
    await runtime.dispose()
  })

  it('selects a policy by preset and denies writes even with full access, while the default loop emits lifecycle events', async () => {
    const policies = new ToolPolicyRegistry()
    const remove = policies.register('@agnes-example/read-only-policy', policy)
    expect(policies.catalog()).toContainEqual({
      id: 'read-only',
      version: '1.0.0',
      sourcePackage: '@agnes-example/read-only-policy',
    })
    const runtimes = new ToolRuntimeRegistry()
    runtimes.register('@test/tagged', {
      id: 'tagged',
      version: '1.0.0',
      create(options) {
        const runtime = defaultToolRuntimeProvider.create(options)
        return {
          ...runtime,
          async execute(call, execution, signal) {
            const returned = await runtime.execute(call, execution, signal)
            return { ...returned, content: result('runtime read').content }
          },
        }
      },
    })
    const events = new LoopEventRegistry()
    const observed: string[] = []
    events.on('before_model_request', () => {
      observed.push('request')
      return { patch: { maxTokens: 77 } }
    })
    events.on('after_model_response', () => {
      observed.push('response')
    })
    events.on('before_tool_call', () => {
      observed.push('tool')
      return { allow: true }
    })
    events.on('after_tool_result', (payload) => {
      expect(payload.result.content).toEqual(result('runtime read').content)
      return { result: result('transformed read') }
    })
    events.on('turn_end', () => {
      observed.push('end')
    })
    const preset = presetDefaults()
    preset.approval.policy = 'read-only'
    preset.tools.runtime = 'tagged'
    preset.tools.maxParallel = 2
    const provider = fakeProvider([toolTurn('shell', {}), toolTurn('read', {}), textTurn('done')])
    const k = Kernel.create({
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider,
      preset,
      toolPolicies: policies,
      toolRuntimes: runtimes,
      loopEvents: events,
      contract: { contract_id: null, parser_version: '1' },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      timers: noTimers,
    })
    k.tools.add(
      shellTool(async () => {
        throw new Error('write must not run')
      }),
      { source: 'test', trust: 'builtin' },
    )
    k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const session = await k.session('policy', {
      actor,
      cwd: '/w',
      resolvedProfileHash: null,
      writerRunId: 'writer',
      workspaceInvocation: testWorkspaceInvocation(),
    })
    try {
      await session.setYolo(true, actor)
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'work' }] })
      expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
      const rows = await session.scan({ fromSeq: 1, limit: 200 })
      expect(
        rows.find(
          (row) => row.type === 'tool/result' && (row.data as { code?: string }).code === 'POLICY_DENIED',
        ),
      ).toBeDefined()
      expect(rows.filter((row) => row.type === 'tool/result').map((row) => row.data)).toContainEqual(
        expect.objectContaining({ content: result('transformed read').content }),
      )
      expect(provider.requests[0]?.sampling?.maxTokens).toBe(77)
      expect(observed).toEqual([
        'request',
        'response',
        'tool',
        'request',
        'response',
        'tool',
        'request',
        'response',
        'end',
      ])
    } finally {
      await k.close()
    }
    remove()
    expect(() => policies.resolve('read-only')).toThrow('not installed')
  })
})
