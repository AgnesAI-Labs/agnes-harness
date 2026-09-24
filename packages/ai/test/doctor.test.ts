import type { ProbeReport } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { buildRegistry, compareDeclaration, runDoctor } from '../src/index.js'
import { FakeAdapter, fakeModel } from '../testkit/index.js'

const obs = (modelId: string) => ({ modelId, thinking: true, nativeToolCalls: true, usageComplete: true })
const check = (value: unknown) => ({ name: 'minimal_inference', ok: true, detail: JSON.stringify(value) })
function setup(ids = ['m']) {
  const a = new FakeAdapter({
    id: 'adapter',
    routes: [{ route: 'r', api: 'openai-completions', baseUrl: 'https://unused.invalid' }],
    models: { r: ids.map((id) => fakeModel({ route: 'r', id, reasoning: true })) },
  })
  const registry = buildRegistry([a])
  registry.seal()
  return { a, registry }
}
const options = () => ({ signal: new AbortController().signal })
const report = (checks: ProbeReport['checks']): ProbeReport => ({
  route: 'r',
  ok: true,
  latencyMs: 1,
  checks,
})
describe('provider diagnostic aggregation', () => {
  it('rejects an empty registry as health evidence', async () => {
    expect((await runDoctor(buildRegistry([]), options())).ok).toBe(false)
  })
  it('keeps an adapter without probe and its models unverified', async () => {
    const { registry } = setup()
    const result = await runDoctor(registry, options())
    expect(result.ok).toBe(false)
    expect(result.routes[0]?.ok).toBe(false)
    expect(result.models[0]).toMatchObject({ id: 'm', observed: false })
  })
  it('binds distinct observations to each model', async () => {
    const { a, registry } = setup(['one', 'two'])
    a.probe = async () => report([check(obs('one')), check(obs('two'))])
    const result = await runDoctor(registry, options())
    expect(result.ok).toBe(true)
    expect(result.models.map((model) => [model.id, model.observed, model.mismatches])).toEqual([
      ['one', true, []],
      ['two', true, []],
    ])
  })
  it('does not apply the first model observation to untested models', async () => {
    const { a, registry } = setup(['one', 'two'])
    a.probe = async () => report([check(obs('one'))])
    const result = await runDoctor(registry, options())
    expect(result.ok).toBe(false)
    expect(result.models[1]).toMatchObject({ id: 'two', observed: false })
  })
  it.each(
    [
      [check({ thinking: true, nativeToolCalls: true, usageComplete: true })],
      [check(obs('other'))],
      [check(obs('m')), check(obs('m'))],
      [check({ ...obs('m'), thinking: 'yes' })],
    ].map((checks) => ({ checks })),
  )('does not certify absent, wrong, duplicate or malformed observations: %j', async ({ checks }) => {
    const { a, registry } = setup()
    a.probe = async () => report(checks)
    const result = await runDoctor(registry, options())
    expect(result.ok).toBe(false)
    expect(result.models[0]?.observed).toBe(false)
  })
  it('reads sealed registry models rather than a later mutable adapter catalogue', async () => {
    const { a, registry } = setup()
    a.models = () => []
    a.probe = async () => report([check(obs('m'))])
    expect((await runDoctor(registry, options())).models.map((model) => model.id)).toEqual(['m'])
  })
  it('does not call a route healthy when it has no declared models', async () => {
    const { a, registry } = setup([])
    a.probe = async () => report([check(obs('unregistered'))])
    expect((await runDoctor(registry, options())).ok).toBe(false)
  })
  it('preserves route failure even when model observations are present', async () => {
    const { a, registry } = setup()
    a.probe = async () => ({ ...report([check(obs('m'))]), ok: false })
    expect((await runDoctor(registry, options())).ok).toBe(false)
  })
  it('probes routes serially so diagnostic traffic has concurrency one', async () => {
    let active = 0,
      maximum = 0
    const adapters = ['a', 'b'].map((id) => {
      const route = `route-${id}`,
        modelId = `model-${id}`
      const adapter = new FakeAdapter({
        id,
        routes: [{ route, api: 'openai-completions', baseUrl: 'https://unused.invalid' }],
        models: { [route]: [fakeModel({ route, id: modelId, reasoning: true })] },
      })
      adapter.probe = async () => {
        active++
        maximum = Math.max(maximum, active)
        await Promise.resolve()
        active--
        return { route, ok: true, latencyMs: 0, checks: [check(obs(modelId))] }
      }
      return adapter
    })
    const registry = buildRegistry(adapters)
    registry.seal()
    expect((await runDoctor(registry, options())).ok).toBe(true)
    expect(maximum).toBe(1)
  })
  it('reports unobserved declarations without claiming they are unsupported', () => {
    expect(
      compareDeclaration(fakeModel({ id: 'm', route: 'r', reasoning: true }), {
        ...obs('m'),
        thinking: false,
        nativeToolCalls: false,
        usageComplete: false,
      }),
    ).toEqual([
      'reasoning: declared but not observed by this probe',
      'toolCallFormats: native declared but not observed by this probe',
      'usage: incomplete',
    ])
  })
})

it.each([
  { name: 'malformed duplicate', extra: check({ ...obs('m'), thinking: 'yes' }), ok: true },
  { name: 'unknown model', extra: check(obs('unknown')), ok: true },
  { name: 'non-object', extra: check(null), ok: true },
  { name: 'invalid JSON', extra: { name: 'minimal_inference', ok: true, detail: '{' }, ok: true },
  { name: 'missing detail', extra: { name: 'minimal_inference', ok: true }, ok: true },
  { name: 'failed duplicate', extra: { ...check(obs('m')), ok: false }, ok: false },
])('keeps mixed evidence inconclusive: $name', async ({ extra, ok }) => {
  const { a, registry } = setup()
  a.probe = async () => ({ ...report([check(obs('m')), extra]), ok })
  const result = await runDoctor(registry, options())
  // The protocol wrapper accepted the report; this tests evidence integrity in the aggregator.
  expect(result.routes[0]?.checks).toEqual([check(obs('m')), extra])
  expect(result.ok).toBe(false)
  expect(result.models[0]?.observed).toBe(false)
})
