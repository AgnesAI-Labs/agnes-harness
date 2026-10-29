import type { PinnedSeam } from '@agnes/package-manager'
import { describe, expect, it } from 'vitest'
import {
  assertPinsMatch,
  assertRepinConsented,
  classifyGenerationFailure,
  describeDifferences,
  diffPins,
  pinnedBindings,
  translateSessionFailure,
} from '../../src/runtime/generation/seam-pins.js'

const pin = (
  kind: string,
  provider: string,
  version = '1.0.0',
  sourcePackage = '@agnes/base',
): PinnedSeam => ({
  kind,
  provider,
  version,
  sourcePackage,
  integrity: 'sha-1',
})

describe('seam pins', () => {
  it('keeps only the pinned kinds of a container’s bindings', () => {
    const bindings = ['approval', 'verifier', 'billing', 'repair'].map((kind) => ({
      ...pin(kind, 'x'),
      kind: kind as never,
    }))
    expect(pinnedBindings(bindings).map((binding) => binding.kind)).toEqual(['approval', 'billing'])
  })

  it('compares provider, version, source package and integrity', () => {
    const base = [pin('approval', 'a'), pin('billing', 'b')]
    expect(diffPins(base, base)).toEqual([])
    expect(
      diffPins(base, [pin('approval', 'a', '1.1.0'), pin('billing', 'b')]).map((item) => item.kind),
    ).toEqual(['approval'])
    expect(diffPins(base, [pin('approval', 'a', '1.0.0', '@acme/x'), pin('billing', 'b')]).length).toBe(1)
    expect(
      diffPins(base, [{ ...pin('approval', 'a'), integrity: 'sha-2' }, pin('billing', 'b')]).length,
    ).toBe(1)
    expect(diffPins(base, [pin('approval', 'a')]).map((item) => item.kind)).toEqual(['billing'])
    expect(describeDifferences(diffPins([pin('approval', 'a')], [pin('approval', 'z', '2.0.0')]))).toBe(
      'approval: a@1.0.0 (@agnes/base) -> z@2.0.0 (@agnes/base)',
    )
  })

  it('refuses a pin that records no seams as corrupt instead of skipping the comparison', () => {
    expect(() => assertPinsMatch('s', undefined, [pin('approval', 'z')])).toThrowError(
      expect.objectContaining({ code: 'E_SESSION_CORRUPT' }),
    )
  })

  it('refuses a container whose bindings drifted from the pin', () => {
    expect(() => assertPinsMatch('s', [pin('approval', 'a')], [pin('approval', 'a')])).not.toThrow()
    expect(() => assertPinsMatch('s', [pin('approval', 'a')], [pin('approval', 'z')])).toThrowError(
      expect.objectContaining({
        code: 'E_SESSION_VERSION_OLDER',
        detail: expect.objectContaining({
          cause: 'E_SEAM_PIN_MISMATCH',
          kinds: ['approval'],
          sessionKey: 's',
        }),
      }),
    )
  })

  it('lets a migration through only for the kinds the request names', () => {
    const differences = diffPins(
      [pin('approval', 'a'), pin('billing', 'b')],
      [pin('approval', 'z'), pin('billing', 'y')],
    )
    expect(() => assertRepinConsented('s', differences, ['approval', 'billing'])).not.toThrow()
    expect(() => assertRepinConsented('s', [], [])).not.toThrow()
    expect(() => assertRepinConsented('s', differences, ['approval'])).toThrowError(
      expect.objectContaining({
        code: 'E_SESSION_VERSION_OLDER',
        detail: expect.objectContaining({ cause: 'E_SEAM_PIN_CHANGE', kinds: ['billing'] }),
      }),
    )
  })

  it.each([
    ['E_GENERATION_SNAPSHOT_NEWER: x', 'newer'],
    ['E_FORMAT_NEWER: ledger', 'newer'],
    ['E_GENERATION_INCOMPATIBLE: build changed', 'older'],
    ['E_GENERATION_SNAPSHOT_MISSING: gone', 'older'],
    ['E_GENERATION_SEAMS_MISSING: old', 'older'],
    ['E_SEAM_MISSING: provider gone', 'older'],
    ['E_GENERATION_INTEGRITY: changed', 'corrupt'],
    ['E_GENERATION_CONFIG_INTEGRITY: live config', 'corrupt'],
    ['E_COMPOSITION_BINDING_INVALID: intent', 'corrupt'],
    ['E_GENERATION_PIN_NEWER: pin', 'newer'],
    ['E_FORMAT_CORRUPT: header', 'corrupt'],
  ] as const)('classifies %s as %s', (message, issue) => {
    expect(classifyGenerationFailure(new Error(message))).toBe(issue)
  })

  it('maps a damaged durable record to a corrupt refusal that names its file, and keeps newer distinct', () => {
    const damaged = Object.assign(new Error('E_GENERATION_INTEGRITY: abc.json: not valid JSON'), {
      file: '.runtime-generations/sessions/abc.json',
    })
    expect(translateSessionFailure(damaged, 's')).toMatchObject({
      code: 'E_SESSION_CORRUPT',
      detail: { sessionKey: 's', issue: 'corrupt', file: '.runtime-generations/sessions/abc.json' },
    })
    expect(translateSessionFailure(new Error('E_GENERATION_PIN_NEWER: pin format 9'), 's')).toMatchObject({
      code: 'E_SESSION_VERSION_NEWER',
    })
  })

  it('leaves an unrelated failure alone', () => {
    expect(classifyGenerationFailure(new Error('E_WRITER_LEASE: held'))).toBeUndefined()
  })
})
