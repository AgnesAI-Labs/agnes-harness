import type { RuntimePluginSnapshot, RuntimeSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { RuntimePluginCatalogue } from '../src/runtime-plugin-catalogue.js'

const revision = 'a'.repeat(64)

function source(packageId: string, snapshotId: string): RuntimePluginSnapshot {
  const snapshot: RuntimeSnapshot = Object.freeze({
    snapshotId,
    profile: 'default',
    packageId,
    version: '1.0.0',
    integrity: `sha256-${'b'.repeat(64)}`,
    treeIntegrity: `sha256-${'c'.repeat(64)}`,
    capabilityHash: revision,
    directory: `/snapshots/${snapshotId}`,
    contributions: Object.freeze([]),
  })
  return Object.freeze({ snapshot, generation: 1, trusted: true })
}

function row(id: string, plugin: string) {
  const slash = plugin.lastIndexOf('/')
  return createPluginRow({
    id,
    plugin,
    snapshotDigest: `sha256-${'d'.repeat(64)}`,
    exportName: plugin.slice(slash + 1),
    entryRevision: revision,
    extrasRevision: revision,
    mountRevision: revision,
    inject: [],
    provides: [id],
    runtime: 'in-process',
  })
}

function target(rows: ReturnType<typeof row>[]) {
  return buildRuntimeTarget({
    rows,
    resourceRevision: revision,
    compositeRevision: revision,
    resources: { mcp: [], skills: {} },
  })
}

describe('RuntimePluginCatalogue', () => {
  it('resolves scoped package identities from ordinary and resource-owned rows', () => {
    const alpha = source('@scope/alpha', 'alpha-snapshot')
    const resources = source('@scope/resources', 'resource-snapshot')
    const catalogue = new RuntimePluginCatalogue([resources, alpha])

    expect(
      catalogue.select(
        target([
          row('feature:alpha', '@scope/alpha@alpha-snapshot/main'),
          row('skills', '@scope/resources@resource-snapshot/skills'),
          row('feature:builtin', 'builtin:@agnes/base/builtin'),
        ]),
      ),
    ).toEqual([alpha, resources])
  })

  it('refuses unavailable, malformed, duplicate and split package authority', () => {
    const alpha = source('alpha', 'one')
    expect(() => new RuntimePluginCatalogue([alpha, alpha])).toThrow('duplicate catalogue snapshot')
    const catalogue = new RuntimePluginCatalogue([alpha, source('alpha', 'two')])
    expect(() => catalogue.select(target([row('feature:missing', 'missing@snapshot/main')]))).toThrow(
      'unavailable snapshot',
    )
    expect(() => catalogue.select(target([row('feature:bad', 'bad-plugin')]))).toThrow(
      'invalid snapshot plugin identity',
    )
    expect(() =>
      catalogue.select(
        target([row('feature:one', 'alpha@one/main'), row('feature:two', 'alpha@two/secondary')]),
      ),
    ).toThrow('multiple snapshots')
  })
})
