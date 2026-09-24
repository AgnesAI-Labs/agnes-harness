import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validatePreset } from '../src/index.js'
import { runFixtureLine } from '../tools/conformance-core.js'

const rows = readFileSync(new URL('../fixtures/configs/preset.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { id: string; kind: string; payload: unknown })

describe('preset document contract', () => {
  it('omitted consumer defaults stay omitted and validation preserves object identity', () => {
    const document = Object.freeze({ name: 'custom' })
    const result = validatePreset(document)
    expect(result).toEqual({ ok: true, value: { name: 'custom' } })
    if (result.ok) expect(result.value).toBe(document)
    expect(document).not.toHaveProperty('disclosure')
  })
  it.each(rows)('$id', (row) => {
    expect(validatePreset(row.payload).ok).toBe(row.kind === 'valid')
  })
  it.each([0, 1, 2])('accepts verifier tier %i', (default_tier) => {
    expect(validatePreset({ name: 'custom', verifier: { default_tier } }).ok).toBe(true)
  })
  it('config dispatch rejects unknown names and a wrong expectation really fails', () => {
    expect(() =>
      runFixtureLine({
        id: 'unknown',
        target: 'config',
        name: 'unknown',
        kind: 'valid',
        payload: { name: 'custom' },
      }),
    ).toThrow('no config validator')
    expect(
      runFixtureLine({
        id: 'wrong',
        target: 'config',
        name: 'preset',
        kind: 'invalid',
        payload: { name: 'custom' },
      }).pass,
    ).toBe(false)
  })
})
