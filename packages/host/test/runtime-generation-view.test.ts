import { noopHooks, ResourceRegistry, type SessionImpl, ToolRegistry } from '@agnes/core'
import { createPluginRow, normalizePluginExport } from '@agnes/plugin-runtime/host'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { buildPresetRows } from '../src/assemble/preset-rows.js'
import { assembleOrdinaryPluginTree } from '../src/assemble/seams-cordis.js'
import {
  bindMountedConfiguration,
  mountedConfigurationSource,
  readMountedConfiguration,
} from '../src/mounted-attestation.js'
import { mountJevTools } from '../src/runtime/jev-tool-mount.js'
import {
  generationRegistries,
  prepareGenerationOwnerReplacement,
  publishedSessionRuntime,
} from '../src/runtime-generation-view.js'

describe('published generation runtime view', () => {
  it('keeps the Jev mount isolated across same-schema reload, revocation and runtime view changes', async () => {
    const tools = new ToolRegistry()
    const resources = new ResourceRegistry()
    const owner = {
      source: 'agnes/tools-core',
      trust: 'builtin' as const,
      executionDomain: 'workspace' as const,
    }
    const tool = (name: string, text: string) => ({
      name,
      description: name,
      parameters: Type.Object({}),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe' as const,
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: undefined,
      },
      execute: async () => ({ content: [{ type: 'text' as const, text }] }),
    })
    tools.add(tool('read', 'old'), owner)
    tools.add(tool('todo', 'disabled'), owner)
    let source = {
      tools,
      resources,
      hooks: noopHooks,
      runtimePromptPreloader: () => ({ note: 'old', key: 'old' }),
    }
    const evidence = {
      scope: 'active-host-rows-and-selected-preset' as const,
      digest: 'a'.repeat(64),
      count: 1,
    }
    let currentEvidence: typeof evidence | null = evidence
    bindMountedConfiguration(source, () => currentEvidence)
    let published = true
    const lookup = { current: () => (published ? source : undefined) }
    const dependencies: Pick<SessionImpl['d'], 'registry' | 'currentRuntime'> = {
      registry: tools,
      currentRuntime: lookup,
    }
    const session = {
      key: 'jev-mount',
      hooks: noopHooks,
      d: dependencies,
      currentResources: () => resources,
      currentTools: () => dependencies.currentRuntime?.current('jev-mount')?.tools ?? tools,
    } as unknown as SessionImpl
    mountJevTools(session)
    const mounted = session.d.currentRuntime?.current(session.key)
    expect(mounted?.tools.list().map((tool) => tool.name)).toEqual(['read'])
    expect(mounted?.tools.resolve('todo')).toBeUndefined()
    expect(tools.resolve('todo')).toBeDefined()
    expect(mounted?.tools.resolve('read')?.definitionFingerprint).toBe(
      tools.resolve('read')?.definitionFingerprint,
    )
    expect(readMountedConfiguration(mounted)).toEqual(evidence)
    expect(session.d.currentRuntime?.current(session.key)).toBe(mounted)
    expect(session.d.currentRuntime?.current('other-session')).toBe(source)

    const refreshed = new ToolRegistry()
    refreshed.add(tool('read', 'new'), owner)
    refreshed.add(tool('todo', 'still disabled'), owner)
    const replacement = tools.prepareOwnerReplacement(owner.source, refreshed)
    replacement.commit()
    replacement.finalize()
    const reloaded = session.currentTools()
    expect(reloaded).not.toBe(mounted?.tools)
    expect(reloaded.list().map((tool) => tool.name)).toEqual(['read'])
    expect(reloaded.resolve('read')?.definitionFingerprint).toBe(
      mounted?.tools.resolve('read')?.definitionFingerprint,
    )
    expect(await reloaded.resolve('read')?.execute({}, {} as never)).toMatchObject({
      content: [{ text: 'new' }],
    })

    source = {
      ...source,
      resources: new ResourceRegistry(),
      hooks: { ...noopHooks },
      runtimePromptPreloader: () => ({ note: 'new', key: 'new' }),
    }
    bindMountedConfiguration(source, () => currentEvidence)
    const changed = session.d.currentRuntime?.current(session.key)
    expect(changed?.tools).toBe(reloaded)
    expect(changed?.hooks).toBe(source.hooks)
    expect(changed?.resources).toBe(source.resources)
    expect(changed?.runtimePromptPreloader).toBe(source.runtimePromptPreloader)
    expect(readMountedConfiguration(changed)).toEqual(evidence)
    currentEvidence = null
    expect(readMountedConfiguration(changed)).toBeNull()
    published = false
    const fallback = session.d.currentRuntime?.current(session.key)
    expect(fallback?.tools.list().map((tool) => tool.name)).toEqual(['read'])
    expect(fallback?.hooks).toBe(noopHooks)
    expect(fallback?.resources).toBe(resources)
    expect(fallback?.runtimePromptPreloader).toBeUndefined()
    expect(readMountedConfiguration(fallback)).toBeNull()
    const revoked = tools.prepareOwnerReplacement(owner.source, new ToolRegistry())
    revoked.commit()
    revoked.finalize()
    expect(session.currentTools().size).toBe(0)
  })

  it('binds actual mounted config to the exact runtime pointer and refuses in-place drift', async () => {
    const presets = buildPresetRows({ standard: { name: 'standard', model: { id: 'm' } } })
    const row = createPluginRow({
      id: 'builtin:configured',
      plugin: 'builtin:configured',
      snapshotDigest: 'builtin:configured',
      exportName: 'default',
      entryRevision: 'v1',
      extrasRevision: 'none',
      mountRevision: 'v1',
      config: { limit: 1, apiKey: 'fake-key' },
    })
    const plugin = Object.assign(() => undefined, {
      Config: {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: (value: unknown) => ({ value: { ...(value as object), limit: 2 } }),
        },
      },
    })
    const mounted = await assembleOrdinaryPluginTree(
      {},
      {
        bootRows: [...presets.rows, row],
        builtinClaims: [...presets.builtinClaims, { row, entry: normalizePluginExport(plugin) }],
      },
    )
    try {
      const source = mountedConfigurationSource(mounted.pluginTree, 'standard')
      const cache = new Map()
      const runtime = publishedSessionRuntime({ cache, hooks: noopHooks, mountedConfiguration: source })
      const captured = readMountedConfiguration(runtime)
      expect(captured).toMatchObject({ scope: 'active-host-rows-and-selected-preset', count: 2 })
      expect(captured?.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(captured)).not.toContain('fake-key')
      expect(readMountedConfiguration({ ...runtime })).toBeNull()
      const fiber = mounted.pluginTree.tree.fiber(row.id)
      if (!fiber) throw new Error('Missing actual mounted fiber')
      expect(fiber.config.limit).toBe(2)
      fiber.config = { ...fiber.config, limit: 1 }
      const changed = source()
      expect(changed?.digest).not.toBe(captured?.digest)
      expect(readMountedConfiguration(runtime)).toBeNull()
      const next = publishedSessionRuntime({ cache, hooks: noopHooks, mountedConfiguration: source })
      expect(readMountedConfiguration(next)).toEqual(changed)
      expect(next.tools).toBe(runtime.tools)
      // Functions/getters cannot be silently dropped into a claimed complete JSON digest.
      fiber.config = { callback: () => 'fake-key' }
      expect(source()).toBeNull()
      fiber.config = Object.defineProperty({}, 'secret', {
        enumerable: true,
        get: () => {
          throw new Error('must not evaluate')
        },
      })
      expect(source()).toBeNull()
      expect(mountedConfigurationSource(mounted.pluginTree, 'missing')()).toBeNull()
      fiber.config = { limit: 1 }
      const selected = mounted.pluginTree.tree.fiber('preset:standard')
      if (!selected) throw new Error('Missing selected preset fiber')
      selected.config = { name: 'other' }
      expect(source()).toBeNull()
    } finally {
      await mounted.close()
    }
  })
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
