import { describe, expect, it } from 'vitest'
import { assemblePrepared, modelCaptureOf } from '../../src/runtime/model/prepared-call.js'
import { createPreparedRegistry } from '../../src/runtime/model/prepared-registry.js'
import { fixtureOwner, fixturePick, fixtureWire, prepareRequest } from './model-fixture.js'

function assembled(maxOutputTokens = 32) {
  const { hookResults: _h, ...request } = prepareRequest({ generation: { maxOutputTokens, thinking: null } })
  const result = assemblePrepared({
    runId: 'run-1',
    sessionId: 'session-1',
    owner: fixtureOwner,
    request,
    capture: modelCaptureOf('package-1', fixturePick()),
    wire: fixtureWire,
    estimatedUnits: [],
  })
  if (!result.ok) throw new Error(result.error.detailCode)
  return result.value
}

describe('prepared registry', () => {
  it('returns a frozen copy of what was put and nothing for an unknown handle', () => {
    const registry = createPreparedRegistry()
    const a = assembled()
    registry.put(a.handleId, a.entry)
    const held = registry.get(a.handleId)
    expect(held).toEqual(a.entry)
    expect(Object.isFrozen(held)).toBe(true)
    expect(Object.isFrozen(held?.prepared.view)).toBe(true)
    expect(registry.get('hdl-unknown')).toBeUndefined()
  })
  it('treats the same key with the same content as a refresh and rejects other content', () => {
    const registry = createPreparedRegistry()
    const a = assembled()
    registry.put(a.handleId, a.entry)
    registry.put(a.handleId, a.entry)
    expect(() => registry.put(a.handleId, assembled(33).entry)).toThrow('other content')
    expect(registry.get(a.handleId)).toEqual(a.entry)
  })
  it('does not use up an entry when it is read: the single send is not the registry job', () => {
    const registry = createPreparedRegistry()
    const a = assembled()
    registry.put(a.handleId, a.entry)
    expect(registry.get(a.handleId)).toBeDefined()
    expect(registry.get(a.handleId)).toBeDefined()
  })
  it('keeps at most the configured count, dropping the oldest first', () => {
    const registry = createPreparedRegistry({ maxEntries: 2 })
    const [a, b, c] = [assembled(1), assembled(2), assembled(3)]
    registry.put(a.handleId, a.entry)
    registry.put(b.handleId, b.entry)
    registry.put(c.handleId, c.entry)
    expect(registry.get(a.handleId)).toBeUndefined()
    expect(registry.get(b.handleId)).toBeDefined()
    expect(registry.get(c.handleId)).toBeDefined()
  })
  it('forgets an entry after its time limit and a refresh extends it', () => {
    let now = 1_000
    const registry = createPreparedRegistry({ ttlMs: 100, now: () => now })
    const [a, b] = [assembled(1), assembled(2)]
    registry.put(a.handleId, a.entry)
    registry.put(b.handleId, b.entry)
    now = 1_090
    registry.put(b.handleId, b.entry)
    now = 1_150
    expect(registry.get(a.handleId)).toBeUndefined()
    expect(registry.get(b.handleId)).toBeDefined()
    now = 1_300
    expect(registry.get(b.handleId)).toBeUndefined()
  })
  it('empties on clear', () => {
    const registry = createPreparedRegistry()
    const a = assembled()
    registry.put(a.handleId, a.entry)
    registry.clear()
    expect(registry.get(a.handleId)).toBeUndefined()
  })
})
