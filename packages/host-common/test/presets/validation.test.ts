import { presetDefaults } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { resolvePreset } from '../../src/presets/resolve.js'
import type { PresetDoc } from '../../src/presets/types.js'
import { canonicalJson, sha256hex } from '../../src/profile/canonical.js'

const resolve = (doc: PresetDoc) => resolvePreset('custom', { custom: doc })
describe('merged preset production validation', () => {
  it('validates only after inherited routes are complete and hashes unchanged raw merged content', () => {
    const docs = {
      base: { name: 'base', model: { route: { primary: 'gw', fast: 'fast' }, id: { primary: 'm' } } },
      custom: { name: 'custom', extends: 'base', model: { route: { fast: 'other' } } },
    }
    const before = JSON.stringify(docs)
    const result = resolvePreset('custom', docs)
    expect(result.view.model.route).toEqual({ primary: 'gw', fast: 'other' })
    expect(result.view.model.id).toEqual({ primary: 'm' })
    expect(result.doc.model).toEqual({ route: { primary: 'gw', fast: 'other' }, id: { primary: 'm' } })
    expect(result.hash).toBe(`sha256-${sha256hex(canonicalJson(result.doc))}`)
    expect(JSON.stringify(docs)).toBe(before)
    expect(() => resolve({ name: 'custom', model: { route: { fast: 'other' } } })).toThrow(
      /E_PRESET_UNSUPPORTED/,
    )
  })
  it('preserves explicit object model priority over the legacy pin and rejects unknown pin slots', () => {
    expect(
      resolve({
        name: 'custom',
        model: { route: { primary: { route: 'gw', model: 'explicit' } }, id: { primary: 'legacy' } },
      }).view.model.id,
    ).toEqual({ primary: 'explicit' })
    expect(() => resolve({ name: 'custom', model: { id: { typo: 'm' } } })).toThrow(/model.id.typo/)
    expect(() => resolve({ name: 'custom', model: { id: { primary: 17 } } })).toThrow(/model.id.primary/)
  })
  it('normalizes retry aliases into the actual core reader without changing the hash document', () => {
    for (const retry of [{ backoff_ms: 37 }, { base_delay_ms: 37 }, { backoff_ms: 37, base_delay_ms: 37 }]) {
      const raw = { name: 'custom', model: { retry } }
      const result = resolve(raw)
      expect(result.view.model.retry.baseDelayMs).toBe(37)
      expect(result.doc).toEqual(raw)
      expect(result.hash).toBe(`sha256-${sha256hex(canonicalJson(raw))}`)
    }
    expect(() =>
      resolve({ name: 'custom', model: { retry: { backoff_ms: 37, base_delay_ms: 38 } } }),
    ).toThrow(/conflicts/)
  })
  it('reads all reconciled fields and resolves the deprecated recovery alias to human', () => {
    const r = resolve({
      name: 'custom',
      model: { timeout_ms: 1234 },
      deferred: { poll_ms: 17 },
      telemetry: { invariants: 'strict' },
      recovery: { unknown_child: 'park' },
    })
    expect(r.view.model.timeoutMs).toBe(1234)
    expect(r.view.deferred.pollMs).toBe(17)
    expect(r.view.telemetry.invariants).toBe('strict')
    expect(r.view.recovery.unknownChild).toBe('human')
    expect(r.doc.recovery).toEqual({ unknown_child: 'park' })
  })
  it('omitted configuration reaches actual core defaults without inserting document fields', () => {
    const r = resolve({ name: 'custom' })
    expect(r.view).toEqual({ ...presetDefaults(), name: 'custom' })
    expect(r.doc).toEqual({ name: 'custom' })
  })
  it.each([
    { tools: { unknown: true } },
    { model: { retry: { unknown: true } } },
    { deferred: { unknown: true } },
    { custom_script: 'forbidden' },
    { operations: { remove: ['Approval'] } },
    { model: { unknown: true } },
    { approval: { command_policy: [{ tool: 'shell', argv: 'x', action: 'ask', unknown: true }] } },
  ])('rejects unknown keys and protected removals in merged documents: %j', (fields) => {
    expect(() => resolve({ name: 'custom', ...fields })).toThrow(/E_PRESET_UNSUPPORTED/)
  })
})

it('validates inheritance links before merge removes them and keeps minimal-rl standalone', () => {
  expect(() => resolve({ name: 'custom', extends: '' })).toThrow(/invalid extends/)
  expect(() =>
    resolvePreset('minimal-rl', {
      'minimal-rl': { name: 'minimal-rl', extends: 'base' },
      base: { name: 'base' },
    }),
  ).toThrow(/must not extend/)
})
