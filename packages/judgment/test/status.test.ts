import type { PluginContextFacets, ServiceDef } from '@agnes/extension-api'
import { checkServiceDef } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { createJudgmentRuntime } from '../src/runtime.js'
import { registerJudgmentStatus } from '../src/status.js'

function fixture(config: unknown = {}, models: any[] = []) {
  let service!: ServiceDef
  const owner = new AbortController()
  const plugin = {
    self: { signal: owner.signal, log: { warn() {} }, sideModels: { list: async () => models } },
    services: {
      register(def: ServiceDef) {
        service = def
        return () => {
          service = undefined as any
        }
      },
    },
  } as unknown as PluginContextFacets
  const runtime = createJudgmentRuntime(plugin, config)
  const dispose = registerJudgmentStatus(plugin, runtime, config)
  return {
    runtime,
    dispose,
    get service() {
      return service
    },
  }
}
it('declares an exact bounded read-only profile query without authority claims or private data', async () => {
  const f = fixture({
    uses: { rules: { enabled: true, items: [{ id: 'secret', text: 'PRIVATE_RULE', tools: ['exec'] }] } },
  })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(checkServiceDef(f.service)).toEqual({ ok: true })
  expect(f.service).toMatchObject({
    name: 'judgment.status',
    kind: 'query',
    scope: 'profile',
    timeoutMs: 1000,
    maxResultBytes: 4096,
    inputSchema: { additionalProperties: false },
  })
  const status = (await f.service.handler({}, {} as any)) as any
  expect(Object.keys(status).sort()).toEqual([
    'cache',
    'configurationRevision',
    'hookTimeout',
    'reason',
    'state',
    'uses',
    'version',
  ])
  expect(status).toMatchObject({
    version: 1,
    hookTimeout: 'unknown',
    state: 'unconfigured',
    reason: 'model-not-configured',
    cache: { hit: 0, miss: 0, size: 0 },
    uses: {
      rules: { enabled: true, available: false, reason: 'model-unavailable', requests: 0 },
      stop: { enabled: false, available: false, reason: 'disabled', requests: 0 },
    },
  })
  expect(JSON.stringify(status)).not.toMatch(/PRIVATE_RULE|secret|endpoint|session|password/)
  expect(status.configurationRevision).toMatch(/^[a-f0-9]{64}$/)
  await expect(f.service.handler({ key: 'x' }, {} as any)).rejects.toThrow()
  f.dispose()
  f.runtime.dispose()
  expect(f.service).toBeUndefined()
})
it('reports text/native availability separately and hashes active config canonically', async () => {
  const config = {
    judge: { route: 'chat', model: 'c' },
    uses: {
      rules: { enabled: true, items: [] },
      find: { enabled: true },
      batch: { enabled: true },
      stop: { enabled: true },
    },
  }
  const f = fixture(config, [{ route: 'chat', model: 'c', api: 'openai-completions' }])
  const reordered = fixture({ uses: config.uses, judge: { model: 'c', route: 'chat' } }, [
    { route: 'chat', model: 'c', api: 'openai-completions' },
  ])
  for (let i = 0; i < 10; i++) await Promise.resolve()
  const status = (await f.service.handler({}, {} as any)) as any
  expect(status).toMatchObject({
    state: 'ready',
    reason: 'none',
    uses: {
      stop: { available: true, reason: 'none' },
      judgeBatch: { available: true },
      findRelevant: { enabled: true, available: false, reason: 'native-required' },
      rules: { available: false, reason: 'native-required' },
    },
  })
  expect(status.configurationRevision).toBe(
    ((await reordered.service.handler({}, {} as any)) as any).configurationRevision,
  )
  f.dispose()
  f.runtime.dispose()
  reordered.dispose()
  reordered.runtime.dispose()
})
it('counts non-replayed requests per purpose and returns detached snapshots', async () => {
  const f = fixture({ uses: { title: { enabled: true, refreshAfterPrompts: 1 } } }, [
    { route: 'jev', model: 'j', api: 'typesafe-systemone' },
  ])
  const signal = new AbortController().signal
  let replay = false
  const port = {
    status: async (invocationId: string) => ({ status: 'absent', invocationId }),
    prepare: async (input: any) => input,
    invoke: async () => ({
      status: 'ok',
      text: '',
      json: { q: { type: 'noul', noul: 0.8 } },
      replayed: replay,
    }),
  }
  const judge = await f.runtime.judge({
    signal,
    sideCall: port as any,
    session: { key: 'PRIVATE_SESSION' } as any,
  })
  const req = { state: 'PRIVATE_INPUT', questions: { q: { type: 'noul' as const, instructions: 'ok?' } } }
  await judge!.judge('judgment.rules', req, { signal, idPrefix: 'r1', totalMs: 1000, attemptMs: 1000 })
  await judge!.judge('judgment.rules', req, { signal, idPrefix: 'r2', totalMs: 1000, attemptMs: 1000 })
  await judge!.judge(
    'judgment.title',
    { ...req, state: 'title input' },
    { signal, idPrefix: 't1', totalMs: 1000, attemptMs: 1000 },
  )
  replay = true
  await judge!.judge(
    'judgment.batch',
    { ...req, state: 'other' },
    { signal, idPrefix: 'b1', totalMs: 1000, attemptMs: 1000 },
  )
  const status = (await f.service.handler({}, {} as any)) as any
  expect(status.uses.rules.requests).toBe(1)
  expect(status.uses.judgeBatch.requests).toBe(0)
  expect(status.cache).toMatchObject({ hit: 1, size: 3 })
  expect(Object.keys(status.uses).sort()).toEqual(['findRelevant', 'judgeBatch', 'rules', 'stop'])
  const schema = f.service.outputSchema as {
    properties: { uses: { additionalProperties: boolean; required: string[] } }
  }
  expect(schema.properties.uses.additionalProperties).toBe(false)
  expect(schema.properties.uses.required.sort()).toEqual(['findRelevant', 'judgeBatch', 'rules', 'stop'])
  status.uses.rules.requests = 99
  expect(((await f.service.handler({}, {} as any)) as any).uses.rules.requests).toBe(1)
  f.dispose()
  f.runtime.dispose()
})
it('distinguishes a missing selected model from an ambiguous catalogue', async () => {
  const models = [{ route: 'jev', model: 'j', api: 'typesafe-systemone' }]
  const missing = fixture({ judge: { route: 'missing', model: 'unknown' } }, models)
  const ambiguous = fixture({}, [...models, { route: 'jev', model: 'other', api: 'typesafe-systemone' }])
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(((await missing.service.handler({}, {} as any)) as any).reason).toBe('model-unavailable')
  expect(((await ambiguous.service.handler({}, {} as any)) as any).reason).toBe('ambiguous-model')
  missing.dispose()
  missing.runtime.dispose()
  ambiguous.dispose()
  ambiguous.runtime.dispose()
})
it('keeps use counters finite and closed for unknown labels including object prototype names', async () => {
  const f = fixture({}, [{ route: 'jev', model: 'j', api: 'typesafe-systemone' }])
  const signal = new AbortController().signal
  const port = {
    status: async (invocationId: string) => ({ status: 'absent', invocationId }),
    prepare: async (input: any) => input,
    invoke: async () => ({ status: 'ok', text: '', json: { q: { type: 'noul', noul: 0.8 } } }),
  }
  const judge = await f.runtime.judge({ signal, sideCall: port as any, session: { key: 'synthetic' } as any })
  await judge!.judge(
    'constructor',
    { state: null, questions: { q: { type: 'noul', instructions: 'yes?' } } },
    { signal, idPrefix: 'unknown', attemptMs: 1000, totalMs: 1000 },
  )
  expect(f.runtime.stats().requests).toEqual({ stop: 0, findRelevant: 0, judgeBatch: 0, rules: 0 })
  f.dispose()
  f.runtime.dispose()
})

it('reads real find/batch switches and makes native-only use availability explicit', async () => {
  const f = fixture(
    { uses: { find: { enabled: true }, batch: { enabled: true }, rules: { enabled: true, items: [] } } },
    [{ route: 'jev', model: 'j', api: 'typesafe-systemone' }],
  )
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(await f.service.handler({}, {} as any)).toMatchObject({
    uses: {
      findRelevant: { enabled: true, available: true, reason: 'none' },
      judgeBatch: { enabled: true, available: true, reason: 'none' },
      rules: { enabled: true, available: true, reason: 'none' },
    },
  })
  f.dispose()
  f.runtime.dispose()
})
