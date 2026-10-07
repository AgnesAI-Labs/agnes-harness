import { describe, expect, it } from 'vitest'
import type { Context } from '../src/index.js'
import {
  defineAgnesPlugin,
  defineChildAgentProvider,
  defineCompactionEngine,
  definePersistenceProvider,
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

  it('keeps the runtime root surface author-only', async () => {
    expect(Object.keys(await import('../src/index.js')).sort()).toEqual([
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
      'toolCancelled',
      'toolError',
    ])
  })
})
