import { describe, expect, it } from 'vitest'
import { detectDependencyCycle, missingDependencies, persistSecretRef } from '../src/dependency-graph.js'
import { createPluginRow } from '../src/plugin-row.js'
import { assertPublishableRows } from '../src/publish-validation.js'

describe('plugin dependency graph', () => {
  it('rejects cycles, reports missing deps as pending, and persists only secret:// refs', () => {
    expect(
      detectDependencyCycle(
        ['a', 'b', 'c'],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      ),
    ).toBeUndefined()
    expect(
      detectDependencyCycle(
        ['a', 'b'],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      ),
    ).toEqual(['a', 'b', 'a'])
    expect(missingDependencies(['a'], [{ from: 'a', to: 'missing' }])).toEqual(['missing'])
    expect(persistSecretRef('secret://vault/token')).toBe('secret://vault/token')
    expect(() => persistSecretRef('sk-plaintext')).toThrow(/E_SECRET_REF/)
  })

  it('rejects a publish-time cycle and plaintext secrets, and refuses third-party policy rows', () => {
    const row = (id: string, extra: Partial<Parameters<typeof createPluginRow>[0]> = {}) =>
      createPluginRow({
        id,
        plugin: extra.plugin ?? `builtin:host/${id}`,
        snapshotDigest: 'builtin:host:v1',
        exportName: id,
        entryRevision: 'host-row:v1',
        extrasRevision: 'none',
        mountRevision: 'host-row:v1',
        ...extra,
      })
    expect(() =>
      assertPublishableRows([row('ext:a', { inject: ['ext:b'] }), row('ext:b', { inject: ['ext:a'] })]),
    ).toThrow(/E_DEPENDENCY_CYCLE/)
    expect(() => assertPublishableRows([row('ext:a', { config: { token: 'sk-plaintext' } })])).toThrow(
      /E_SECRET_REF/,
    )
    expect(() => assertPublishableRows([row('policy:approvals', { plugin: 'ext:third/policy' })])).toThrow(
      /E_POLICY_BUILTIN/,
    )
    expect(() =>
      assertPublishableRows([row('ext:a', { config: { token: 'secret://vault/x' } })]),
    ).not.toThrow()
  })
})
