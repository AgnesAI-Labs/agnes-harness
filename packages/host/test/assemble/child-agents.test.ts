import { resetChildAgentAllowlists } from '@agnes/core'
import { Context } from '@agnes/cordis'
import type { ChildAgentCapabilities, ChildAgentProvider, ChildAgentResult } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { installChildAgents } from '../../src/assemble/child-agents.js'

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
      capabilities: ['continuable', 'interrupt'],
      restartRequired: false,
      sourcePackage: '@agnes/base',
    })
  expect(() => registry.register(provider('demo', limited).api)).toThrow('duplicate child-agent provider')
  await expect(
    registry.start('demo', 'task', { signal: signal(), sessionKey: 's', cwd: '/tmp', fork: true }),
  ).rejects.toThrow('cannot inherit parent context')
  expect(demo.state.starts).toBe(0)
  const handle = await registry.start('demo', 'task', { signal: signal(), sessionKey: 's', cwd: '/tmp' })
  expect(handle.id).toBe('demo-1')
  await plugin.dispose()
  expect(registry.catalog()).toEqual([])
  expect(demo.state.disposed).toEqual(['task'])
  await expect(
    registry.start('demo', 'again', { signal: signal(), sessionKey: 's', cwd: '/tmp' }),
  ).rejects.toThrow('not registered')
  await root.fiber.dispose()
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
