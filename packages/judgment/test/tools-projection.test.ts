import type { EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createToolsProjection } from '../src/uses/tools-projection.js'

it('authorizes only a fresh trusted main-session identity and stores no raw key', () => {
  const projection = createToolsProjection()
  const initial = projection.init()
  expect(initial).toEqual({ sessionHash: null, child: true })
  const start = (data: unknown, over: object = {}) =>
    ({ type: 'session/start', origin: 'system', trust: 'trusted', data, ...over }) as EventEnvelope
  expect(projection.apply(initial, start({ key: 'synthetic' }, { origin: 'principal' }))).toBe(initial)
  expect(projection.apply(initial, start({ key: 'synthetic' }, { trust: 'untrusted' }))).toBe(initial)
  const parent = projection.apply(initial, start({ key: 'synthetic' }))
  expect(parent.child).toBe(false)
  expect(parent.sessionHash).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(parent)).not.toContain('synthetic')
  for (const data of [
    { key: 'child', parent: null },
    { key: 'child', delegation: {} },
    { key: 'x'.repeat(513) },
    { key: '' },
    {},
  ])
    expect(projection.apply(parent, start(data)).child).toBe(true)
  expect(projection.apply(parent, start({ key: 'new' })).sessionHash).not.toBe(parent.sessionHash)
})
