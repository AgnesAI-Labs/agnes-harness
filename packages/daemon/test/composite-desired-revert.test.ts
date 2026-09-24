import type { InstalledInventory } from '@agnes/package-manager'
import { installedRuntimeSnapshotId } from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import {
  differingPackages,
  emptyTarget,
  loadableSnapshotsFromInventory,
  packageOfRow,
  revertTarget,
} from '../src/composite-desired.js'

const revision = 'a'.repeat(64)
const snapshot = (fill: string) => `sha256-${fill.repeat(64)}`

function row(
  id: string,
  packageId: string,
  snapshotId: string,
  over: { disabled?: boolean; config?: unknown; entryRevision?: string } = {},
) {
  return createPluginRow({
    id,
    plugin: `${packageId}@${snapshotId}/main`,
    snapshotDigest: snapshotId,
    exportName: 'main',
    entryRevision: over.entryRevision ?? snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    ...(over.disabled ? { disabled: true } : {}),
    ...(over.config === undefined ? {} : { config: over.config }),
  })
}

function builtinRow(id: string, packageId: string) {
  return createPluginRow({
    id,
    plugin: `builtin:${packageId}/main`,
    snapshotDigest: 'builtin:host:v1',
    exportName: 'main',
    entryRevision: 'host-row:v1',
    extrasRevision: 'none',
    mountRevision: 'host-row:v1',
  })
}

function target(rows: ReturnType<typeof row>[], skills: Record<string, unknown> = {}) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows,
      resources: { mcp: [], skills },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

const rowIds = (artifact: Parameters<typeof decodeRuntimeTargetArtifact>[0]) =>
  decodeRuntimeTargetArtifact(artifact).tree.rows.map((r) => r.id)

describe('packageOfRow', () => {
  it.each([
    ['@scope/name@sha256-abc/export', '@scope/name'],
    ['acme/echo@sha256-abc/echo', 'acme/echo'],
    ['plain@sha256-abc/export', 'plain'],
    ['pkg@sha256-abc/exp@rt', 'pkg'],
    ['builtin:@agnes/base/tools', '@agnes/base'],
    ['builtin:host/tools', 'host'],
  ])('reads the package of %s', (plugin, expected) => {
    expect(packageOfRow(plugin)).toBe(expected)
  })

  it.each(['nonsense', 'builtin:x', 'builtin:/x', 'builtin:x/', 'a@/b', '@x/y', 'pkg@sha256-abc/'])(
    'returns undefined instead of throwing for %s',
    (plugin) => {
      expect(packageOfRow(plugin)).toBeUndefined()
    },
  )
})

describe('revertTarget', () => {
  const loadable = new Map([
    ['pkg-a@' + snapshot('1'), snapshot('1')],
    ['pkg-b@' + snapshot('2'), snapshot('2')],
  ])

  it('gives back the previous target when a newly enabled package failed', () => {
    const previous = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    const failed = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('1')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('2')),
    ])
    expect(rowIds(revertTarget(failed, previous, loadable))).toEqual(['ext:pkg-a/main'])
  })

  it('drops the rows of a package whose previous version is no longer installed', () => {
    const previous = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('9')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('2')),
    ])
    const failed = target([
      row('ext:pkg-a/main', 'pkg-a', snapshot('1')),
      row('ext:pkg-b/main', 'pkg-b', snapshot('2')),
    ])
    expect(rowIds(revertTarget(failed, previous, loadable))).toEqual(['ext:pkg-b/main'])
  })

  it('drops a row whose entry revision is not the snapshot it names', () => {
    const previous = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'), { entryRevision: snapshot('7') })])
    expect(rowIds(revertTarget(previous, previous, loadable))).toEqual([])
  })

  it('keeps builtin rows and disabled rows of a loadable snapshot', () => {
    const previous = target([
      builtinRow('seam:approval', 'host'),
      row('ext:pkg-a/main', 'pkg-a', snapshot('1'), { disabled: true }),
    ])
    expect([...rowIds(revertTarget(previous, previous, loadable))].sort()).toEqual([
      'ext:pkg-a/main',
      'seam:approval',
    ])
  })

  it('is an empty package set with the failed target resources when there is no previous target', () => {
    const failed = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))], { keep: 'me' })
    const reverted = decodeRuntimeTargetArtifact(revertTarget(failed, undefined, loadable))
    expect(reverted.tree.rows).toEqual([])
    expect(reverted.resource.resources.skills).toEqual({ keep: 'me' })
  })
})

describe('emptyTarget', () => {
  it('has no rows at all, builtin rows included, and keeps the resources', () => {
    const desired = target(
      [builtinRow('seam:approval', 'host'), row('ext:pkg-a/main', 'pkg-a', snapshot('1'))],
      {
        keep: 'me',
      },
    )
    const empty = decodeRuntimeTargetArtifact(emptyTarget(desired))
    expect(empty.tree.rows).toEqual([])
    expect(empty.resource.resources.skills).toEqual({ keep: 'me' })
  })
})

describe('differingPackages', () => {
  it('names the package whose row was only enabled, not changed in any other way', () => {
    const before = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'), { disabled: true })])
    const after = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    expect(differingPackages(after, before)).toEqual({ packages: ['pkg-a'], unattributed: 0 })
  })

  it('names the package whose config changed', () => {
    const before = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'), { config: { a: 1 } })])
    const after = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'), { config: { a: 2 } })])
    expect(differingPackages(after, before).packages).toEqual(['pkg-a'])
  })

  it('names every package that was added or removed, once each', () => {
    const before = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    const after = target([row('ext:pkg-b/main', 'pkg-b', snapshot('2'))])
    expect(differingPackages(after, before).packages).toEqual(['pkg-a', 'pkg-b'])
  })

  it('finds nothing when the rows are the same', () => {
    const one = target([row('ext:pkg-a/main', 'pkg-a', snapshot('1'))])
    expect(differingPackages(one, one)).toEqual({ packages: [], unattributed: 0 })
  })

  it('counts a row it cannot attribute instead of throwing', () => {
    const odd = createPluginRow({
      id: 'ext:odd',
      plugin: 'not-a-plugin-identity',
      snapshotDigest: 'x',
      exportName: 'main',
      entryRevision: 'x',
      extrasRevision: 'none',
      mountRevision: 'host-ordinary-row:v1',
    })
    const after = target([odd])
    const before = target([])
    expect(differingPackages(after, before)).toEqual({ packages: [], unattributed: 1 })
  })
})

describe('loadableSnapshotsFromInventory', () => {
  const installed = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      directory: `/tmp/${id}`,
      entry: {
        version: '1.0.0',
        integrity: `sha256-${'a'.repeat(64)}`,
        treeIntegrity: `sha256-${'c'.repeat(64)}`,
        source: { kind: 'path', ref: `/tmp/${id}` },
      },
      capabilityHash: 'capability',
      trusted: true,
      enabled: true,
      contributions: [],
      blockers: [],
      verifiedRollbackTarget: null,
      ...over,
    }) as unknown as InstalledInventory['packages'][number]

  it('names the current snapshot of each trusted package a worker could import', () => {
    const ok = installed('pkg-ok')
    const loadable = loadableSnapshotsFromInventory({
      profile: 'p',
      hash: 'h',
      packages: [
        ok,
        installed('pkg-untrusted', { trusted: false }),
        installed('pkg-no-dir', { directory: undefined }),
      ],
    })
    expect([...loadable.keys()]).toEqual([`pkg-ok@${installedRuntimeSnapshotId(ok)}`])
  })
})
