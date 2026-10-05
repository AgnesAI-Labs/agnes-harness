import { fakeModel } from '@agnes/ai/testkit'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  type CatalogRegistry,
  captureModelCatalog,
  restoreModelCatalog,
} from '../../src/runtime/model/model-catalog-capture.js'

const decl = (route: string): RouteDecl =>
  ({ route, api: 'openai-completions', baseUrl: 'https://fake.invalid' }) as RouteDecl
function registry(models: ModelRecord[], routes = [decl('r1'), decl('r2')]) {
  let sealed = 0
  const view: CatalogRegistry = {
    routes: () => routes,
    models: () => models,
    seal: () => {
      sealed++
    },
  }
  return { view, models, routes, sealed: () => sealed }
}
const cost = (output: number) => ({ input: 1, output, cacheRead: 0, cacheWrite: 0 })

describe('model catalog capture', () => {
  it('seals once, selects a route with only its own models and answers undefined for unknowns', () => {
    const r = registry([fakeModel({ id: 'a', route: 'r1' }), fakeModel({ id: 'b', route: 'r2' })])
    const catalog = captureModelCatalog(r.view)
    expect(r.sealed()).toBe(1)
    const picked = catalog.select('r1', 'a')
    expect(picked?.model.id).toBe('a')
    expect(picked?.route.models.map((m) => m.id)).toEqual(['a'])
    expect(catalog.select('r1', 'b')).toBeUndefined()
    expect(catalog.select('nope', 'a')).toBeUndefined()
    expect(catalog.routes()).toEqual(['r1', 'r2'])
  })

  it('deep-freezes a copy: later edits to the registry data never reach the capture', () => {
    const r = registry([fakeModel({ id: 'a', route: 'r1', cost: cost(2) })])
    const catalog = captureModelCatalog(r.view)
    const before = catalog.digest
    ;(r.models[0] as ModelRecord).cost.output = 99
    expect(catalog.select('r1', 'a')?.model.cost.output).toBe(2)
    expect(catalog.digest).toBe(before)
    expect(Object.isFrozen(catalog.select('r1', 'a')?.model)).toBe(true)
    expect(() => {
      ;(catalog.select('r1', 'a')?.model.cost as { output: number }).output = 5
    }).toThrow()
  })

  it('changes its digest when a cost changes even though route and model ids stay the same', () => {
    const first = captureModelCatalog(registry([fakeModel({ id: 'a', route: 'r1', cost: cost(2) })]).view)
    const second = captureModelCatalog(registry([fakeModel({ id: 'a', route: 'r1', cost: cost(3) })]).view)
    expect(second.digest).not.toBe(first.digest)
  })

  it('marks only the listed routes keyless', () => {
    const r = registry([fakeModel({ id: 'a', route: 'r1' }), fakeModel({ id: 'b', route: 'r2' })])
    const catalog = captureModelCatalog(r.view, { keyless: new Set(['r2']) })
    expect(catalog.select('r1', 'a')?.route.keyless).toBeUndefined()
    expect(catalog.select('r2', 'b')?.route.keyless).toBe(true)
  })

  it('round-trips through its snapshot with the same digest, and a changed snapshot has another digest', () => {
    const catalog = captureModelCatalog(registry([fakeModel({ id: 'a', route: 'r1', cost: cost(2) })]).view)
    const restored = restoreModelCatalog(JSON.parse(JSON.stringify(catalog.snapshot())))
    expect(restored.digest).toBe(catalog.digest)
    expect(restored.select('r1', 'a')?.model).toEqual(catalog.select('r1', 'a')?.model)
    const changed = JSON.parse(JSON.stringify(catalog.snapshot()))
    changed[0].models[0].cost.output = 7
    expect(restoreModelCatalog(changed).digest).not.toBe(catalog.digest)
  })
})
