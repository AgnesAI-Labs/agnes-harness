import { canonicalJson, createEnvelopeCache, deriveRequest, sha256Hex } from '@agnes/core'
import { expect, it } from 'vitest'
import { createSdkRenderer, renderPython, snapshotKey } from '../src/index.js'
import { snapshot, tool } from './fixtures/sdk.js'

it('matches canonical schema hashing while ignoring self and deferred tools', () => {
  const a = snapshot([tool('read')]),
    b = snapshot([tool('read'), tool('run_code'), tool('later', undefined, true)])
  expect(snapshotKey(a)).toBe(snapshotKey(b))
  expect(snapshotKey(a)).toBe(sha256Hex(canonicalJson(a.defs.map((t) => [t.name, t.parameters]))))
  expect(snapshotKey(a)).not.toBe(snapshotKey(snapshot([tool('read'), tool('ls')])))
  expect(snapshotKey(a)).not.toBe(
    snapshotKey(snapshot([tool('read', { type: 'object', properties: { n: { type: 'integer' } } })])),
  )
})
it('canonical-equivalent schemas produce identical direct and cached SDK text', () => {
  const nestedA = { type: 'object', properties: { z: { type: 'string' }, a: { type: 'integer' } } }
  const nestedB = { properties: { a: { type: 'integer' }, z: { type: 'string' } }, type: 'object' }
  const a = snapshot([tool('read', { type: 'object', properties: { z: nestedA, a: { type: 'string' } } })])
  const b = snapshot([tool('read', { properties: { a: { type: 'string' }, z: nestedB }, type: 'object' })])
  expect(snapshotKey(a)).toBe(snapshotKey(b))
  expect(renderPython(a)).toBe(renderPython(b))
  const r = createSdkRenderer({})
  expect(r.render(a)).toBe(r.render(b))
  expect(r.stats()).toEqual({ hits: 1, misses: 1, size: 1 })
})
it('uses the default 32 entries and promotes hits before evicting the least recently used item', () => {
  const r = createSdkRenderer({}),
    all = Array.from({ length: 33 }, (_, n) => snapshot([tool(`tool_${n}`)]))
  for (const s of all.slice(0, 32)) r.render(s)
  expect(r.stats()).toEqual({ hits: 0, misses: 32, size: 32 })
  const [first, second] = all,
    last = all.at(-1)
  if (!first || !second || !last) throw new Error('missing cache fixture')
  r.render(first)
  r.render(last)
  r.render(first)
  expect(r.stats()).toEqual({ hits: 2, misses: 33, size: 32 })
  r.render(second)
  expect(r.stats()).toEqual({ hits: 2, misses: 34, size: 32 })
})
it('validates capacity and isolates caches and returned counters', () => {
  for (const max of [0, -1, 0.5, NaN, Infinity])
    expect(() => createSdkRenderer({ max })).toThrow('positive safe integer')
  const r = createSdkRenderer({ max: 1 }),
    other = createSdkRenderer({})
  r.render(snapshot([tool('a')]))
  r.stats().hits = 100
  r.render(snapshot([tool('b')]))
  expect(r.stats()).toEqual({ hits: 0, misses: 2, size: 1 })
  expect(other.stats()).toEqual({ hits: 0, misses: 0, size: 0 })
})
it('reports skipped bindings only on actual render misses and does not lose new invalid names', () => {
  const skipped: string[] = [],
    r = createSdkRenderer({ onSkip: (n) => skipped.push(n) })
  const s = snapshot([tool('class')])
  r.render(s)
  r.render(s)
  expect(skipped).toEqual(['class'])
  r.render(snapshot([tool('class'), tool('run_code')]))
  expect(skipped).toEqual(['class'])
  r.render(snapshot([tool('class'), tool('await')]))
  expect(skipped).toEqual(['class', 'await', 'class'])
})
it('propagates actual SDK changes through deriveRequest prompt hash without changing the disclosed tool schema', () => {
  const r = createSdkRenderer({}),
    run = tool('run_code')
  function request(withExtra: boolean) {
    const s = snapshot([run, tool('read'), ...(withExtra ? [tool('ls')] : [])])
    return deriveRequest({
      kind: 'turn',
      merged: {
        tools: ['run_code'],
        sections: [{ id: 'tools:sdk', order: 150, text: r.render(s), source: 'code' }],
        runtimeContext: {},
        conflicts: [],
      },
      harnessEntries: [],
      surface: [],
      disclosed: [run],
      model: { slot: 'primary', route: 'default', model: 'm1' },
      contract: { contract_id: null, parser_version: '1' },
      nonce: '0123456789abcdef0123456789abcdef',
      envelopeCache: createEnvelopeCache(),
    })
  }
  const before = request(false),
    after = request(true),
    cached = request(true)
  expect(after.header.prompt_prefix_hash).not.toBe(before.header.prompt_prefix_hash)
  expect(after.header.tool_schema_hash).toBe(before.header.tool_schema_hash)
  expect(cached.header.prompt_prefix_hash).toBe(after.header.prompt_prefix_hash)
  expect(cached.header.tool_schema_hash).toBe(after.header.tool_schema_hash)
  expect(r.stats()).toEqual({ hits: 1, misses: 2, size: 2 })
})
