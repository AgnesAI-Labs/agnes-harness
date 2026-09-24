import type { ExtensionManifest } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { isHostError } from '../../src/errors.js'
import type { LockEntry } from '../../src/packages/lockfile.js'
import { isDangerous, runTrustGate } from '../../src/packages/trust-gate.js'

const localEntry = (license = 'MIT'): LockEntry => ({
  version: '1.0.0',
  source: { type: 'file', ref: 'file:./pkg' },
  integrity: `sha256-${'0'.repeat(64)}`,
  trust: 'trusted',
  license,
  state: { installed: '2026-09-01T00:00:00Z', trusted: null, enabled: false },
  dependencies: {},
  previous: null,
})

const manifest = (over: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
  id: 'acme/pkg',
  version: '1.0.0',
  apiRange: '^1.0',
  entry: './index.js',
  capabilities: { tools: { prefix: 'pkg_', names: ['pkg_echo'] } },
  ...over,
})

function refusal(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected refusal')
}

describe('package trust gates', () => {
  const base = {
    id: 'acme/pkg',
    ceiling: ['tools'],
    now: '2026-09-07T00:00:00Z',
    minimumReleaseAgeMin: 2880,
  }

  it('checks license before API range and capability ceiling', () => {
    const error = refusal(() =>
      runTrustGate({
        ...base,
        entry: localEntry('GPL-3.0-only'),
        manifest: manifest({ apiRange: '^9.0', capabilities: { events: true } }),
      }),
    )
    expect(isHostError(error, 'E_PACKAGE_QUARANTINED')).toBe(true)
    expect((error as { detail?: unknown }).detail).toMatchObject({ reason: 'license' })
  })

  it('quarantines young npm releases before evaluating extension compatibility', () => {
    const entry: LockEntry = {
      ...localEntry(),
      source: { type: 'npm', ref: 'npm:acme@1.0.0' },
      integrity: 'sha512-eA==',
      releasedAt: '2026-09-06T23:00:00Z',
    }
    const error = refusal(() => runTrustGate({ ...base, entry, manifest: manifest({ apiRange: '^9.0' }) }))
    expect(isHostError(error, 'E_PACKAGE_QUARANTINED')).toBe(true)
    expect((error as { detail?: unknown }).detail).toMatchObject({ reason: 'release-age' })
  })

  it('translates API incompatibility and then enforces the capability ceiling', () => {
    const incompatible = refusal(() =>
      runTrustGate({ ...base, entry: localEntry(), manifest: manifest({ apiRange: '^9.0' }) }),
    )
    expect(isHostError(incompatible, 'E_API_RANGE')).toBe(true)

    const ceiling = refusal(() =>
      runTrustGate({
        ...base,
        entry: localEntry(),
        manifest: manifest({ capabilities: { events: true } }),
      }),
    )
    expect(isHostError(ceiling, 'E_CEILING_EXCEEDED')).toBe(true)
  })

  it('recognizes the combined invoke/subagent capability as dangerous', () => {
    expect(isDangerous(manifest({ capabilities: { 'tools.invoke': true, subagent: true } }))).toBe(true)
    expect(isDangerous(manifest())).toBe(false)
  })
})
