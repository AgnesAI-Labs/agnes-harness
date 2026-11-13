import type { HookContext, HookHandler, PluginContextFacets, SideModelEntry } from '@agnes/extension-api'
import { expect, it, vi } from 'vitest'
import { judgmentPlugin } from '../src/index.js'

function fixture(config: unknown) {
  let handler: HookHandler<'turn_stopping'>
  let models: readonly SideModelEntry[] = []
  let requestSeq = 1
  const list = vi.fn(async () => models)
  const plugin = {
    hooks: {
      register: (_: string, fn: HookHandler<'turn_stopping'>) => {
        handler = fn
        return () => {}
      },
    },
    projections: { register: () => () => {} },
    eventLog: { append: vi.fn(async () => 3) },
    self: {
      extId: 'plugin/test',
      signal: new AbortController().signal,
      sideModels: { list },
      log: { info: vi.fn(), warn: vi.fn() },
    },
  } as unknown as PluginContextFacets
  const dispose = judgmentPlugin.apply(plugin, config)
  const run = async () => {
    const sideCall = {
      prepare: vi.fn(async (o: unknown) => o),
      status: vi.fn(async (invocationId) => ({ status: 'absent', invocationId })),
      invoke: vi.fn(async () => ({ status: 'ok', json: { unexpected_stop: { type: 'noul', noul: 0.1 } } })),
    }
    const ctx = {
      signal: new AbortController().signal,
      session: { key: 's' },
      sideCall,
      projections: {
        readOwn: async () => ({
          status: 'available',
          value: {
            child: false,
            request: { seq: requestSeq, text: `request ${requestSeq}` },
            reply: { seq: requestSeq + 1, text: 'I will act', hasTools: false },
            continuedSeq: 0,
            goalSources: [],
            queued: [],
          },
        }),
      },
    } as unknown as HookContext
    const result = await handler!({ turn: 1, step: 1, proposedReason: 'completed' }, ctx)
    requestSeq += 2
    return { sideCall, result }
  }
  return {
    list,
    run,
    dispose,
    set models(value: readonly SideModelEntry[]) {
      models = value
    },
  }
}
it('resolves a late catalogue on every hook and binds only its current port', async () => {
  const f = fixture({ uses: { stop: { enabled: true } } })
  expect(f.list).toHaveBeenCalledTimes(1)
  expect((await f.run()).sideCall.prepare).not.toHaveBeenCalled()
  f.models = [{ route: 'jev', model: 'j', api: 'typesafe-systemone' }]
  const one = await f.run(),
    two = await f.run()
  expect(one.sideCall.prepare).toHaveBeenCalledTimes(1)
  expect(two.sideCall.prepare).toHaveBeenCalledTimes(1)
  expect(f.list).toHaveBeenCalledTimes(4)
  f.dispose()
})
it('defaults U2 off even with an available native model', async () => {
  const f = fixture({})
  f.models = [{ route: 'jev', model: 'j', api: 'typesafe-systemone' }]
  expect((await f.run()).sideCall.prepare).not.toHaveBeenCalled()
  expect(f.list).toHaveBeenCalledTimes(1)
  f.dispose()
})
