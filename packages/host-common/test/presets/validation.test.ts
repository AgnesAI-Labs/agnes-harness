import { presetDefaults } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { resolvePreset } from '../../src/presets/resolve.js'
import type { PresetDoc } from '../../src/presets/types.js'
import { canonicalJson, sha256hex } from '../../src/profile/canonical.js'

const resolve = (doc: PresetDoc) => resolvePreset('custom', { custom: doc })
describe('merged preset production validation', () => {
  it('validates only after inherited routes are complete and hashes unchanged raw merged content', () => {
    const docs = {
      base: { name: 'base', model: { route: { primary: { route: 'gw', model: 'm' }, fast: 'fast' } } },
      custom: { name: 'custom', extends: 'base', model: { route: { fast: 'other' } } },
    }
    const before = JSON.stringify(docs)
    const result = resolvePreset('custom', docs)
    expect(result.view.model.route).toEqual({ primary: 'gw', fast: 'other' })
    expect(result.view.model.id).toEqual({ primary: 'm' })
    expect(result.doc.model).toEqual({ route: { primary: { route: 'gw', model: 'm' }, fast: 'other' } })
    expect(result.hash).toBe(`sha256-${sha256hex(canonicalJson(result.doc))}`)
    expect(JSON.stringify(docs)).toBe(before)
    expect(() => resolve({ name: 'custom', model: { route: { fast: 'other' } } })).toThrow(
      /E_PRESET_UNSUPPORTED/,
    )
  })
  it('refuses the retired model.id pin, retry alias and recovery spelling', () => {
    for (const fields of [
      { model: { id: { primary: 'legacy' } } },
      { model: { retry: { backoff_ms: 37 } } },
      { recovery: { unknown_child: 'park' } },
    ])
      expect(() => resolve({ name: 'custom', ...fields })).toThrow(/E_PRESET_UNSUPPORTED/)
  })
  it('reads the retry delay and the reconciled fields into the actual core reader', () => {
    const raw = {
      name: 'custom',
      model: { retry: { base_delay_ms: 37 }, timeout_ms: 1234 },
      deferred: { poll_ms: 17 },
      telemetry: { invariants: 'strict' },
      recovery: { unknown_child: 'human' },
    }
    const r = resolve(raw)
    expect(r.view.model.retry.baseDelayMs).toBe(37)
    expect(r.view.model.timeoutMs).toBe(1234)
    expect(r.view.deferred.pollMs).toBe(17)
    expect(r.view.telemetry.invariants).toBe('strict')
    expect(r.view.recovery.unknownChild).toBe('human')
    expect(r.doc).toEqual(raw)
    expect(r.hash).toBe(`sha256-${sha256hex(canonicalJson(raw))}`)
  })
  it('omitted configuration reaches actual core defaults without inserting document fields', () => {
    const r = resolve({ name: 'custom' })
    expect(r.view).toEqual({ ...presetDefaults(), name: 'custom' })
    expect(r.doc).toEqual({ name: 'custom' })
  })
  it.each([
    { tools: { runtime: 'default' } },
    { approval: { policy: 'default' } },
    { loop: { id: 'agnes.default', version: '1.0.0' } },
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
