import { noopHooks, ResourceRegistry, ToolRegistry } from '@agnes/core'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import {
  generationRegistries,
  prepareGenerationOwnerReplacement,
  publishedSessionRuntime,
} from '../src/runtime-generation-view.js'

describe('published generation runtime view', () => {
  it('does not reuse Kernel shared tables across composite revisions', () => {
    const cache = new Map()
    const kernelTools = new ToolRegistry()
    const first = publishedSessionRuntime({
      compositeRevision: '1'.repeat(64),
      cache,
      hooks: noopHooks,
    })
    const second = publishedSessionRuntime({
      compositeRevision: '2'.repeat(64),
      cache,
      hooks: noopHooks,
    })
    const again = publishedSessionRuntime({
      compositeRevision: '1'.repeat(64),
      cache,
      hooks: noopHooks,
    })
    expect(first.tools).not.toBe(kernelTools)
    expect(first.tools).not.toBe(second.tools)
    expect(first.resources).not.toBe(second.resources)
    expect(again.tools).toBe(first.tools)
    expect(generationRegistries(cache, '1'.repeat(64)).tools).toBe(first.tools)
  })

  it('keys overlay candidate runtime by the candidate composite revision, not a live Kernel table', () => {
    const cache = new Map()
    const kernelTools = new ToolRegistry()
    const kernelResources = new ResourceRegistry()
    const candidateRevision = 'c'.repeat(64)
    const runtime = publishedSessionRuntime({
      compositeRevision: candidateRevision,
      cache,
      hooks: noopHooks,
    })
    expect(runtime.tools).not.toBe(kernelTools)
    expect(runtime.resources).not.toBe(kernelResources)
    expect(generationRegistries(cache, candidateRevision).tools).toBe(runtime.tools)
  })

  it('keys session registries by runtime registry revision, not composite artifact revision', () => {
    const cache = new Map()
    const first = publishedSessionRuntime({
      compositeRevision: '1'.repeat(64),
      runtimeRegistryRevision: 'r'.repeat(64),
      cache,
      hooks: noopHooks,
    })
    const webOnly = publishedSessionRuntime({
      compositeRevision: '2'.repeat(64),
      runtimeRegistryRevision: 'r'.repeat(64),
      cache,
      hooks: noopHooks,
    })
    const registryChanged = publishedSessionRuntime({
      compositeRevision: '3'.repeat(64),
      runtimeRegistryRevision: 's'.repeat(64),
      cache,
      hooks: noopHooks,
    })

    expect(webOnly.tools).toBe(first.tools)
    expect(webOnly.resources).toBe(first.resources)
    expect(registryChanged.tools).not.toBe(first.tools)
    expect(registryChanged.resources).not.toBe(first.resources)
  })

  it('snapshots attested registrations into a generation without mutating an older generation', () => {
    const cache = new Map()
    const tools = new ToolRegistry()
    const resources = new ResourceRegistry()
    const source = { source: 'agnes/generation-test', trust: 'builtin' as const }
    tools.add(
      {
        name: 'generation_one',
        description: 'first generation',
        parameters: Type.Object({}),
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
        execute: async () => ({ content: [] }),
      } as never,
      source,
    )
    resources.register({ id: 'generation-one', kind: 'skill', name: 'one', description: 'one' }, source)
    const first = publishedSessionRuntime({
      compositeRevision: '1'.repeat(64),
      cache,
      hooks: noopHooks,
      seed: { tools, resources },
    })
    tools.add(
      {
        name: 'generation_two',
        description: 'second generation',
        parameters: Type.Object({}),
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
        execute: async () => ({ content: [] }),
      } as never,
      source,
    )
    resources.register({ id: 'generation-two', kind: 'skill', name: 'two', description: 'two' }, source)
    const second = publishedSessionRuntime({
      compositeRevision: '2'.repeat(64),
      cache,
      hooks: noopHooks,
      seed: { tools, resources },
    })
    expect(first.tools.list().map((tool) => tool.name)).toEqual(['generation_one'])
    expect(first.resources.snapshot().map(({ entry }) => entry.id)).toEqual(['generation-one'])
    expect(
      second.tools
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['generation_one', 'generation_two'])
    expect(
      second.resources
        .snapshot()
        .map(({ entry }) => entry.id)
        .sort(),
    ).toEqual(['generation-one', 'generation-two'])
  })

  it('replaces one owner in a bound generation without copying unrelated Kernel registrations', () => {
    const source = { source: 'agnes/reloadable', trust: 'builtin' as const }
    const other = { source: 'agnes/unrelated', trust: 'builtin' as const }
    const tool = (name: string) =>
      ({
        name,
        description: name,
        parameters: Type.Object({}),
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
        execute: async () => ({ content: [] }),
      }) as never
    const initialTools = new ToolRegistry()
    const initialResources = new ResourceRegistry()
    initialTools.add(tool('reload_old'), source)
    initialTools.add(tool('unrelated_tool'), other)
    initialResources.register({ id: 'reload-old', kind: 'skill', name: 'old', description: 'old' }, source)
    initialResources.register(
      { id: 'unrelated-resource', kind: 'skill', name: 'other', description: 'other' },
      other,
    )
    const generation = generationRegistries(new Map(), 'r'.repeat(64), {
      tools: initialTools,
      resources: initialResources,
    })
    const refreshedTools = new ToolRegistry()
    const refreshedResources = new ResourceRegistry()
    refreshedTools.add(tool('reload_new'), source)
    refreshedTools.add(tool('unrelated_tool'), other)
    refreshedResources.register({ id: 'reload-new', kind: 'skill', name: 'new', description: 'new' }, source)
    refreshedResources.register(
      { id: 'unrelated-resource', kind: 'skill', name: 'other', description: 'other' },
      other,
    )

    const replacement = prepareGenerationOwnerReplacement(generation, source.source, {
      tools: refreshedTools,
      resources: refreshedResources,
    })
    replacement.commit()
    replacement.finalize()

    expect(
      generation.tools
        .list()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['reload_new', 'unrelated_tool'])
    expect(
      generation.resources
        .snapshot()
        .map(({ entry }) => entry.id)
        .sort(),
    ).toEqual(['reload-new', 'unrelated-resource'])
  })
})
