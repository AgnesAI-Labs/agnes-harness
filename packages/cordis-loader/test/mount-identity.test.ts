import { describe, expect, it } from 'vitest'
import { buildMountIdentity, type MountIdentityInput, normalizePluginRuntime } from '../src/index.js'

function identityInput(overrides: Partial<MountIdentityInput> = {}): MountIdentityInput {
  return {
    snapshotDigest: 'sha256-snapshot',
    exportName: 'main',
    entryRevision: 'entry-1',
    extrasRevision: 'extras-1',
    plugin: 'acme/example@sha256-snapshot/main',
    inject: ['storage', 'logger'],
    isolate: { storage: 'row', logger: 'shared' },
    provides: ['example.service', 'example.metrics'],
    runtime: 'in-process',
    mountRevision: 'mount-1',
    ...overrides,
  }
}

describe('buildMountIdentity', () => {
  it('canonicalizes set-like lists and isolate key order by code point', () => {
    const first = buildMountIdentity(identityInput())
    const second = buildMountIdentity(
      identityInput({
        inject: ['logger', 'storage', 'logger'],
        isolate: { logger: 'shared', storage: 'row' },
        provides: ['example.metrics', 'example.service', 'example.metrics'],
      }),
    )
    expect(second).toBe(first)
  })

  it.each<keyof MountIdentityInput>([
    'snapshotDigest',
    'exportName',
    'entryRevision',
    'extrasRevision',
    'plugin',
    'inject',
    'isolate',
    'provides',
    'runtime',
    'mountRevision',
  ])('changes when %s changes', (field) => {
    const changed: Record<keyof MountIdentityInput, unknown> = {
      snapshotDigest: 'sha256-other',
      exportName: 'other',
      entryRevision: 'entry-2',
      extrasRevision: 'extras-2',
      plugin: 'acme/other@sha256-snapshot/main',
      inject: ['different'],
      isolate: { different: 'scope' },
      provides: ['different.service'],
      runtime: 'isolated',
      mountRevision: 'mount-2',
    }
    expect(buildMountIdentity(identityInput({ [field]: changed[field] }))).not.toBe(
      buildMountIdentity(identityInput()),
    )
  })

  it('treats undefined map entries as missing while encoding an explicit empty map', () => {
    const omitted = buildMountIdentity(
      identityInput({ isolate: { logger: undefined } as unknown as Readonly<Record<string, string>> }),
    )
    const missing = buildMountIdentity(identityInput({ isolate: {} }))
    expect(omitted).toBe(missing)

    const unsafe = identityInput() as unknown as Record<string, unknown>
    delete unsafe.isolate
    expect(buildMountIdentity(unsafe as unknown as MountIdentityInput)).not.toBe(missing)
  })
})

describe('normalizePluginRuntime', () => {
  it('defaults an omitted runtime before EntryRow construction', () => {
    expect(normalizePluginRuntime(undefined)).toBe('in-process')
    expect(normalizePluginRuntime('isolated')).toBe('isolated')
  })

  it('rejects an unknown runtime', () => {
    expect(() => normalizePluginRuntime('worker')).toThrow(/plugin runtime/i)
  })
})
