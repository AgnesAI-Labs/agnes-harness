import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import { ResourceRegistry } from '../src/registry/resources.js'
import { ToolRegistry } from '../src/registry/tools.js'
import type { CurrentRuntimeLookup, CurrentSessionRuntime } from '../src/runtime/current.js'
import { type HookPort, noopHooks } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const source = { source: 'agnes/current-runtime-test', trust: 'builtin' as const }
const toolMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}

function tools(name: string): ToolRegistry {
  const registry = new ToolRegistry()
  registry.add(
    {
      name,
      description: name,
      parameters: Type.Object({}),
      meta: toolMeta,
      execute: async () => ({ content: [{ type: 'text' as const, text: name }] }),
    } as never,
    source,
  )
  return registry
}

function resources(id: string): ResourceRegistry {
  const registry = new ResourceRegistry()
  registry.register({ id, kind: 'skill', name: id, description: id }, source)
  return registry
}

function hooks(label: string, calls: string[]): HookPort {
  return {
    ...noopHooks,
    beforeStep: async () => {
      calls.push(label)
      return {}
    },
  }
}

describe('Host-owned current runtime lookup', () => {
  it('moves an open session to the current registries while keeping one turn tool snapshot stable', async () => {
    const calls: string[] = []
    const generationA: CurrentSessionRuntime = {
      tools: tools('from_a'),
      hooks: hooks('a', calls),
      resources: resources('resource-a'),
    }
    const generationB: CurrentSessionRuntime = {
      tools: tools('from_b'),
      hooks: hooks('b', calls),
      resources: resources('resource-b'),
    }
    let current = generationA
    const currentRuntime: CurrentRuntimeLookup = { current: () => current }
    const { session } = await openSession({ provider: fakeProvider([]), currentRuntime })

    const firstTurn = session.freshTurn(0, 1)
    expect(firstTurn.snapshot.defs.map((tool) => tool.name)).toEqual(['from_a'])
    expect(
      session
        .currentResources()
        .snapshot()
        .map(({ entry }) => entry.id),
    ).toEqual(['resource-a'])
    await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })

    current = generationB
    session.turn = firstTurn
    expect(firstTurn.snapshot.defs.map((tool) => tool.name)).toEqual(['from_a'])
    expect(session.operationContext().snapshot.defs.map((tool) => tool.name)).toEqual(['from_a'])
    expect(session.freshTurn(0, 2).snapshot.defs.map((tool) => tool.name)).toEqual(['from_b'])
    expect(
      session
        .currentResources()
        .snapshot()
        .map(({ entry }) => entry.id),
    ).toEqual(['resource-b'])
    await session.hooks.beforeStep({ turn: 1, step: 2, depth: 0 })
    expect(calls).toEqual(['a', 'b'])
  })

  it('resolves the prompt preloader from current immediately before inference', async () => {
    const oldPreloader = vi.fn(() => undefined)
    const currentPreloader = vi.fn(() => undefined)
    const shared = {
      tools: new ToolRegistry(),
      hooks: noopHooks,
      resources: new ResourceRegistry(),
    }
    let current: CurrentSessionRuntime = { ...shared, runtimePromptPreloader: oldPreloader }
    const currentRuntime: CurrentRuntimeLookup = { current: () => current }
    const { session } = await openSession({ provider: fakeProvider([textTurn('ok')]), currentRuntime })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'load the current skill' }], actor })
    await session.acceptInput()

    current = { ...shared, runtimePromptPreloader: currentPreloader }
    await session.runInference()

    expect(oldPreloader).not.toHaveBeenCalled()
    expect(currentPreloader).toHaveBeenCalledWith({
      sessionKey: session.key,
      prompt: 'load the current skill',
    })

    current = shared
    expect(session.currentRuntimePromptPreloader()).toBeUndefined()
  })

  it('keeps assembly fallbacks when the Host lookup has no published session scope', async () => {
    const assembly = tools('assembly')
    const fallbackCalls: string[] = []
    const currentRuntime: CurrentRuntimeLookup = { current: () => undefined }
    const { session } = await openSession({
      provider: fakeProvider([]),
      currentRuntime,
      registry: assembly,
    })
    session.hooks = hooks('fallback', fallbackCalls)
    expect(session.currentTools()).toBe(assembly)
    expect(session.currentResources().snapshot()).toEqual([])
    await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })
    expect(fallbackCalls).toEqual(['fallback'])
  })
})
