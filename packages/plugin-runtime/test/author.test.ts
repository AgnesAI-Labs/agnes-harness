import { webhookTriggerKind } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/index.js'
import {
  defineAgnesPlugin,
  defineChildAgentProvider,
  defineCompactionEngine,
  defineModelAdapter,
  definePersistenceProvider,
  defineProvider,
  defineSandboxProvider,
  defineToolPolicy,
  defineToolRuntime,
} from '../src/index.js'

describe('plugin author API', () => {
  it('preserves a standard Cordis plugin without wrapping it', () => {
    const plugin = (ctx: Context, config: { readonly greeting: string }) => {
      void ctx
      return config.greeting
    }

    expect(defineAgnesPlugin(plugin)).toBe(plugin)
  })

  it('preserves all kind helpers and refuses non-semver declarations', () => {
    const policy = {
      id: 'test',
      version: '1.0.0',
      decide: () => ({ effect: 'deny' as const, reason: 'test' }),
    }
    expect(defineToolPolicy(policy)).toBe(policy)
    const adapter = {
      id: 'custom',
      version: '1.0.0',
      wireApi: 'custom-wire',
      capabilities: { imageInput: false, tools: true, streaming: true },
      create: () => ({ id: 'custom', routes: () => [], models: () => [], async *stream() {} }),
    }
    expect(defineModelAdapter(adapter)).toBe(adapter)
    for (const wireApi of [undefined, '', ' '])
      expect(() => defineModelAdapter({ ...adapter, wireApi, api: 'custom-wire' } as never)).toThrow(
        'Invalid model-adapter',
      )
    const trigger = { id: 'generic', version: '1.0.0', verify: async () => undefined }
    expect(defineProvider(webhookTriggerKind, trigger)).toBe(trigger)
    expect(() => defineProvider(webhookTriggerKind, { ...trigger, verify: undefined } as never)).toThrow()
    const helpers: readonly ((provider: never) => unknown)[] = [
      defineToolPolicy,
      defineToolRuntime,
      defineCompactionEngine,
      defineSandboxProvider,
      definePersistenceProvider,
      defineChildAgentProvider,
    ]
    for (const helper of helpers) expect(() => helper({ id: 'bad', version: '1' } as never)).toThrow('semver')
  })

  it('defines a tool that is never replayed unless it says otherwise', async () => {
    const { defineTool, writeTool } = await import('../src/index.js')
    const { replay: _replay, ...unstated } = writeTool
    const authored = {
      name: 'note',
      description: 'Write a note',
      parameters: {} as never,
      execute: async () => ({ content: [] }),
    }
    expect(defineTool({ ...authored, meta: unstated }).meta.replay).toBe('never')
    expect(defineTool({ ...authored, meta: { ...unstated, replay: 'idempotent' } }).meta.replay).toBe(
      'idempotent',
    )
  })

  it('is the one author import: the contract root plus these helpers, and nothing Host-side', async () => {
    const root = await import('../src/index.js')
    const contracts = await import('@agnes/extension-api')
    for (const name of Object.keys(contracts)) expect(root).toHaveProperty(name)
    // A helper of the same name replaces the contract package's own.
    expect(root.definePersistenceProvider).not.toBe(
      (contracts as Record<string, unknown>).definePersistenceProvider,
    )
    const helpers = Object.keys(root).filter(
      (name) => (root as Record<string, unknown>)[name] !== (contracts as Record<string, unknown>)[name],
    )
    expect(helpers.sort()).toEqual([
      'defineAgnesPlugin',
      'defineChildAgentProvider',
      'defineCompactionEngine',
      'defineLoop',
      'defineModelAdapter',
      'definePersistenceProvider',
      'defineProvider',
      'defineSandboxProvider',
      'defineTool',
      'defineToolPolicy',
      'defineToolRuntime',
      'defineWorkflowLoop',
      'drainDeferredToolInvocations',
      'readOnlyTool',
      'toolCancelled',
      'toolError',
      'withDeferredToolInvocations',
      'workflowChecked',
      'workflowModelText',
      'workflowResult',
      'workflowText',
      'workflowTool',
      'workflowValue',
      'writeTool',
    ])
  })
})
