import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createTreeSnapshot,
  type RowState,
  type RuntimeConvergenceReport,
  type TreeSnapshot,
  verifyTreeSnapshot,
} from '../src/convergence.js'
import type { PluginRow } from '../src/plugin-row.js'

function row(id: string, config: unknown = { nested: { enabled: true } }): PluginRow {
  return {
    id,
    plugin: `@example/plugin:${id}`,
    config,
    inject: Object.freeze([]),
    disabled: false,
    isolate: Object.freeze({}),
    provides: Object.freeze([]),
    runtime: 'in-process',
    mountIdentity: `identity:${id}` as PluginRow['mountIdentity'],
    mountRevision: 'mount-1',
    entryRevision: 'entry-1',
    extrasRevision: 'extras-1',
  }
}

describe('Task 7 convergence contracts', () => {
  it('freezes a canonical, content-addressed tree snapshot', () => {
    const config = { nested: { enabled: true } }
    const first = createTreeSnapshot([row('b'), row('a', config)])
    const second = createTreeSnapshot([row('a', config), row('b')])

    expect(first.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.hash).toBe(second.hash)
    expect(first.rows.map(({ id }) => id)).toEqual(['a', 'b'])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.rows)).toBe(true)
    expect(Object.isFrozen(first.rows[0])).toBe(true)
    expect(Object.isFrozen(first.rows[0]?.config)).toBe(true)

    config.nested.enabled = false
    expect(first.rows[0]?.config).toEqual({ nested: { enabled: true } })
  })

  it('rejects a forged hash and returns a fresh immutable snapshot', () => {
    const snapshot = createTreeSnapshot([row('a')])
    expect(() => verifyTreeSnapshot({ ...snapshot, hash: '0'.repeat(64) })).toThrow(/E_TREE_HASH/)

    const verified = verifyTreeSnapshot(structuredClone(snapshot))
    expect(verified).toEqual(snapshot)
    expect(verified).not.toBe(snapshot)
    expect(Object.isFrozen(verified.rows[0])).toBe(true)
  })

  it('normalizes negative zero to the same returned value and hash as zero', () => {
    const negative = createTreeSnapshot([row('number', { value: -0 })])
    const positive = createTreeSnapshot([row('number', { value: 0 })])

    expect(negative.hash).toBe(positive.hash)
    const negativeConfig = negative.rows.at(0)?.config
    expect(negativeConfig).toEqual({ value: 0 })
    if (!negativeConfig) throw new Error('expected normalized config')
    expect(Object.is((negativeConfig as { value: number }).value, -0)).toBe(false)
  })

  it('normalizes sparse array entries to explicit null values before hashing', () => {
    const values = new Array<unknown>(2)
    values[1] = 'present'
    const sparse = createTreeSnapshot([row('array', { values })])
    const explicit = createTreeSnapshot([row('array', { values: [null, 'present'] })])

    expect(sparse.hash).toBe(explicit.hash)
    const sparseConfig = sparse.rows.at(0)?.config
    expect(sparseConfig).toEqual({ values: [null, 'present'] })
    if (!sparseConfig) throw new Error('expected normalized config')
    expect(0 in (sparseConfig as { values: unknown[] }).values).toBe(true)

    const sparseInject = new Array<string>(1)
    expect(() => createTreeSnapshot([{ ...row('inject'), inject: sparseInject }])).toThrow(
      /row\.inject must be a string array/,
    )
    const sparseRows = new Array<PluginRow>(1)
    expect(() => createTreeSnapshot(sparseRows)).toThrow(/rows must not be sparse/)
  })

  it('sorts row and record keys by Unicode code point without locale dependence', () => {
    const snapshot = createTreeSnapshot([
      row('\u{1f600}', { '\u{1f600}': 1, '\ue000': 1, a: 1, Z: 1 }),
      row('\ue000'),
      row('a'),
      row('Z'),
    ])

    expect(snapshot.rows.map(({ id }) => id)).toEqual(['Z', 'a', '\ue000', '\u{1f600}'])
    const configured = snapshot.rows.find(({ id }) => id === '\u{1f600}')
    expect(Object.keys(configured?.config as object)).toEqual(['Z', 'a', '\ue000', '\u{1f600}'])
  })

  it('keeps the Task 7 report independent from Task 8 runtime targets', () => {
    const state: RowState = 'pending'
    const report: RuntimeConvergenceReport = {
      hash: 'a'.repeat(64),
      ok: true,
      rows: [{ id: 'ext:example', state }],
    }
    expect(report).toEqual({
      hash: 'a'.repeat(64),
      ok: true,
      rows: [{ id: 'ext:example', state: 'pending' }],
    })
    expectTypeOf<TreeSnapshot['rows']>().toMatchTypeOf<readonly Readonly<PluginRow>[]>()
    expectTypeOf(report).not.toHaveProperty('target')
    expectTypeOf(report).not.toHaveProperty('resource')
  })
})
