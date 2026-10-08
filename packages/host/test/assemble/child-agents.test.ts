import { Context } from '@agnes/cordis'
import { resetChildAgentAllowlists } from '@agnes/core'
import type {
  ChildAgentCapabilities,
  ChildAgentProvider,
  ChildAgentResult,
  ChildAgentStartOptions,
} from '@agnes/extension-api'
import { readProviderSelections } from '@agnes/host-providers/assemble/provider-selection'
import { installChildAgents } from '@agnes/host-runtime/assemble/child-agents'
import { expect, it } from 'vitest'

const signal = () => new AbortController().signal

function provider(id: string, capabilities: ChildAgentCapabilities) {
  const state = { starts: 0, disposed: [] as string[] }
  const api: ChildAgentProvider = {
    id,
    version: '1.0.0',
    capabilities,
    async start(task) {
      state.starts += 1
      const childId = `${id}-${state.starts}`
      return {
        id: childId,
        providerId: id,
        capabilities,
        async *events() {},
        sendMessage: async () => ({ messageId: 'm' }),
        interrupt: async () => ({ accepted: true }),
        result: () => new Promise<ChildAgentResult>(() => undefined),
        async dispose() {
          state.disposed.push(task)
        },
      }
    },
  }
  return { api, state }
}

const limited: ChildAgentCapabilities = {
  continuable: true,
  interrupt: true,
  modelSelection: false,
  inheritsParentContext: false,
  worktree: false,
}

it('registers providers, refuses missing capabilities, and disposes handles on unload', async () => {
  const root = new Context()
  const registry = installChildAgents(root)
  const demo = provider('demo', limited)
  const plugin = root.plugin((ctx) => {
    ctx.childAgents.register(demo.api)
  })
  await expect.poll(() => registry.catalog().length).toBe(1)
  expect(Object.isFrozen(registry.catalog()[0])).toBe(true)
  expect(registry.catalog()[0]).toMatchObject({ id: 'demo', sourcePackage: '@agnes/base' })
  await expect
    .poll(() => root.providers.catalog().find((entry) => entry.kind === 'child-agent' && entry.id === 'demo'))
    .toMatchObject({
      version: '1.0.0',
      capabilities: ['continuable', 'interrupt'],
      restartRequired: false,
      sourcePackage: '@agnes/base',
    })
  expect(() => registry.register(provider('demo', limited).api)).toThrow('duplicate child-agent provider')
  await expect(
    registry.start('demo', 'task', { signal: signal(), sessionKey: 's', cwd: '/tmp', fork: true }),
  ).rejects.toMatchObject({ code: 'E_PROVIDER_INCOMPATIBLE', kind: 'child-agent', provider: 'demo' })
  expect(demo.state.starts).toBe(0)
  const handle = await registry.start('demo', 'task', { signal: signal(), sessionKey: 's', cwd: '/tmp' })
  expect(handle.id).toBe('demo-1')
  await plugin.dispose()
  expect(registry.catalog()).toEqual([])
  expect(root.providers.catalog()).toEqual([])
  expect(demo.state.disposed).toEqual(['task'])
  await expect(
    registry.start('demo', 'again', { signal: signal(), sessionKey: 's', cwd: '/tmp' }),
  ).rejects.toThrow('not registered')
  await root.fiber.dispose()
})

it('registers through the shared service and selects the configured default without overriding explicit ids', async () => {
  const selections = readProviderSelections({
    packages: [{ enabled: true, config: { 'child-agent': { provider: 'demo', version: '1.0.0' } } }],
  } as never)
  const root = new Context()
  const registry = installChildAgents(root, undefined, selections['child-agent'])
  const demo = provider('demo', limited)
  const explicit = provider('explicit', limited)
  const plugin = root.plugin((ctx) => {
    ctx.providers.register('child-agent', '@test/child', demo.api)
    ctx.childAgents.register(explicit.api)
  })
  await expect.poll(() => registry.catalog().length).toBe(2)
  try {
    const chosen = await registry.start(undefined, 'selected', { signal: signal(), sessionKey: 'configured' })
    expect(chosen.providerId).toBe('demo')
    expect(root.providers.catalog()).toContainEqual(
      expect.objectContaining({
        kind: 'child-agent',
        id: 'demo',
        sourcePackage: '@test/child',
        active: true,
      }),
    )
    const other = await registry.start('explicit', 'explicit', { signal: signal(), sessionKey: 'configured' })
    expect(other.providerId).toBe('explicit')
    await chosen.dispose()
    expect(root.providers.catalog()).toContainEqual(
      expect.objectContaining({ kind: 'child-agent', id: 'demo', active: false }),
    )
    await other.dispose()
    await expect(
      registry.start('missing', 'no fallback', { signal: signal(), sessionKey: 'configured' }),
    ).rejects.toThrow('change child-agent.provider')
  } finally {
    await plugin.dispose()
    await root.fiber.dispose()
  }
})

it('applies a session model allowlist before the provider starts', async () => {
  const root = new Context()
  const registry = installChildAgents(root)
  const demo = provider('demo', { ...limited, modelSelection: true })
  root.plugin((ctx) => {
    ctx.childAgents.register(demo.api)
  })
  await expect.poll(() => registry.catalog().length).toBe(1)
  registry.setSessionAllowlist('s', { models: ['fast'] })
  expect(registry.allowlist('s')).toEqual({ models: ['fast'] })
  try {
    await expect(
      registry.start('demo', 'task', { signal: signal(), sessionKey: 's', cwd: '/tmp' }),
    ).rejects.toThrow('E_MODEL_UNKNOWN')
    expect(demo.state.starts).toBe(0)
  } finally {
    resetChildAgentAllowlists()
    await root.fiber.dispose()
  }
})

it('binds parent constraints and refuses handles belonging to another parent scope', async () => {
  const root = new Context()
  const registry = installChildAgents(root, undefined, { provider: 'demo' })
  const demo = provider('demo', { ...limited, budget: true, toolFilter: true })
  let received: ChildAgentStartOptions | undefined
  const start = demo.api.start
  demo.api.start = async (task, options) => {
    received = options
    return start(task, options)
  }
  const unregister = registry.register(demo.api)
  const scope = registry.forSession({
    sessionKey: 'parent',
    cwd: '/tmp',
    signal: signal(),
    generation: 'g1',
    budget: 2,
    toolFilter: { allow: ['read', 'shell'], deny: ['shell'] },
  })
  const other = registry.forSession({ sessionKey: 'other', cwd: '/tmp', signal: signal() })
  const handle = await scope.start('work', {
    budget: 10,
    toolFilter: { allow: ['read', 'write'] },
    sessionKey: 'forged',
    generation: 'g2',
  } as never)
  expect(received).toMatchObject({
    sessionKey: 'parent',
    cwd: '/tmp',
    generation: 'g1',
    budget: 2,
    toolFilter: { allow: ['read'], deny: ['shell'] },
  })
  expect(() => other.events(handle.id)).toThrow('not owned')
  await expect(scope.sendMessage(handle.id, 'next')).resolves.toEqual({ messageId: 'm' })
  await scope.dispose()
  await expect(scope.start('closed')).rejects.toThrow()
  await other.dispose()
  await unregister()
  expect(demo.state.disposed).toEqual(['work'])
  await root.fiber.dispose()
})

it('joins starting children on unregister and preserves a late handle disposal failure', async () => {
  const root = new Context()
  const registry = installChildAgents(root)
  const demo = provider('demo', limited)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const start = demo.api.start
  demo.api.start = async (task, options) => {
    await gate
    const handle = await start(task, options)
    return {
      ...handle,
      dispose: async () => {
        throw new Error('late dispose failed')
      },
    }
  }
  const unregister = registry.register(demo.api)
  const started = registry.start('demo', 'work', { sessionKey: 's', signal: signal() })
  const refused = expect(started).rejects.toThrow('late dispose failed')
  let joined = false
  const cleanup = unregister().finally(() => {
    joined = true
  })
  const failed = expect(cleanup).rejects.toThrow('Child provider cleanup failed')
  await Promise.resolve()
  expect(joined).toBe(false)
  expect(registry.catalog()).toEqual([])
  release()
  await refused
  await failed
  await expect(unregister()).rejects.toThrow('Child provider cleanup failed')
  await root.fiber.dispose()
})
