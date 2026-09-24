import type { SeamImplementations } from '@agnes/core'
import type { Context } from '@agnes/plugin-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  approvalPlugin,
  artifactsPlugin,
  checkpointPlugin,
  defineSeamPlugin,
  HOST_SEAM_INIT,
  harnessPlugin,
  ledgerPlugin,
  principalsPlugin,
  repairPlugin,
  verifierPlugin,
} from '../src/cordis-seams.js'
import type { SeamInitContext } from '../src/seam-init.js'

type Approval = SeamImplementations['approval']
type TestApproval = Approval & { readonly label: string; close(): void }

function testInit(preset: Record<string, unknown>): SeamInitContext {
  return {
    profile: {
      name: 'test-profile',
      resolvedProfileHash: null,
      dataDir: '/data',
      workspaceRoot: '/workspace',
      homeDir: '/home',
      limits: {},
      preset,
    },
  } as SeamInitContext
}

function testApproval(label: string, close: () => void): TestApproval {
  return {
    label,
    async ask() {
      return 'rejected'
    },
    async resume() {
      return null
    },
    close,
  }
}

function pluginContext(
  init: SeamInitContext,
  disposeService = vi.fn(),
  onProvide: (value: Approval) => void = () => undefined,
): Context {
  return {
    [HOST_SEAM_INIT]: () => init,
    provide: vi.fn((_service, value: Approval) => {
      onProvide(value)
      return disposeService
    }),
  } as unknown as Context
}

function normalizeConfig<T>(
  plugin: {
    Config: { '~standard': { validate(value: unknown): { value: T } | { issues: readonly unknown[] } } }
  },
  value: unknown,
): T {
  const result = plugin.Config['~standard'].validate(value)
  if ('issues' in result) throw new TypeError(JSON.stringify(result.issues))
  return result.value
}

describe('ordinary Cordis seam exports', () => {
  it('declares all eight dynamic seams as normal plugins', () => {
    const plugins = {
      approval: approvalPlugin,
      principals: principalsPlugin,
      artifacts: artifactsPlugin,
      checkpoint: checkpointPlugin,
      ledger: ledgerPlugin,
      verifier: verifierPlugin,
      repair: repairPlugin,
      harness: harnessPlugin,
    }
    expect(Object.entries(plugins).map(([name, plugin]) => [plugin.provide, plugin.inject, name])).toEqual(
      Object.keys(plugins).map((name) => [`seam:${name}`, ['host:seam-init'], name]),
    )
  })

  it('rebuilds a seam with the complete preset from updated row config', async () => {
    const seen: Readonly<Record<string, unknown>>[] = []
    const closed: string[] = []
    let active: Approval | undefined
    const plugin = defineSeamPlugin('approval', async (init) => {
      seen.push(init.profile.preset)
      return testApproval(String(init.profile.preset.marker), () => {
        closed.push(String(init.profile.preset.marker))
      })
    })
    const ctx = pluginContext(
      testInit({ name: 'stale', marker: 'host-value' }),
      vi.fn(() => {
        active = undefined
      }),
      (value) => {
        active = value
      },
    )

    const first = { name: 'default', marker: 'first', nested: { retained: true } }
    const second = { name: 'default', marker: 'second', nested: { retained: true } }
    const firstConfig = normalizeConfig(plugin, first)
    const disposeFirst = await plugin.apply(ctx, firstConfig)

    expect(seen).toEqual([first])
    expect((active as TestApproval).label).toBe('first')

    await disposeFirst()
    const secondConfig = normalizeConfig(plugin, second)
    const disposeSecond = await plugin.apply(ctx, secondConfig)

    expect(seen).toEqual([first, second])
    expect(closed).toEqual(['first'])
    expect((active as TestApproval).label).toBe('second')
    await disposeSecond()
  })

  it('rejects a non-plain row config before calling the seam factory', async () => {
    const factory = vi.fn(async () => testApproval('unused', vi.fn()))
    const plugin = defineSeamPlugin('approval', factory)
    const ctx = pluginContext(testInit({ name: 'stale' }))

    expect(() => normalizeConfig(plugin, ['not', 'a', 'preset'])).toThrow(/plain preset object/)
    expect(factory).not.toHaveBeenCalled()
    expect(ctx.provide).not.toHaveBeenCalled()
  })

  it('removes the service and closes the implementation when disposed', async () => {
    const close = vi.fn()
    const disposeService = vi.fn()
    const plugin = defineSeamPlugin('approval', async () => testApproval('active', close))
    const ctx = pluginContext(testInit({ name: 'stale' }), disposeService)

    const config = normalizeConfig(plugin, { name: 'default' })
    const dispose = await plugin.apply(ctx, config)
    await dispose()

    expect(ctx.provide).toHaveBeenCalledTimes(1)
    expect(disposeService).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
