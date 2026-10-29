import type { InstalledPackage } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { runningPackageIdentity } from '../src/package-actual-identity.js'

const PACKAGE_ID = '@acme/widgets'
const V1 = `sha256-${'1'.repeat(64)}`
const V2 = `sha256-${'2'.repeat(64)}`
const V3 = `sha256-${'3'.repeat(64)}`

function row(id: string, plugin: string) {
  return createPluginRow({
    id,
    plugin,
    snapshotDigest: V1,
    exportName: 'x',
    entryRevision: V1,
    extrasRevision: 'none',
    mountRevision: 'test',
    runtime: 'in-process',
    disabled: false,
  })
}

function artifact(...plugins: readonly [string, string][]) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: plugins.map(([id, plugin]) => row(id, plugin)),
      resources: { mcp: [], skills: {} },
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
    }),
  )
}

function installed(
  version: string,
  integrity: string,
  rollback?: { version: string; integrity: string },
): InstalledPackage {
  return {
    id: PACKAGE_ID,
    entry: { version, integrity } as unknown as InstalledPackage['entry'],
    capabilityHash: 'capability',
    trusted: true,
    enabled: true,
    contributions: [],
    blockers: [],
    verifiedRollbackTarget: rollback
      ? { ...rollback, capabilityHash: 'capability', treeIntegrity: 'tree' }
      : null,
  } as unknown as InstalledPackage
}

describe('runningPackageIdentity', () => {
  it('reads the integrity from the row the worker last applied, not from the installed entry', () => {
    // 1.2.0 is installed but the worker still runs 1.1.0 (a failed update, or right after a rollback).
    const lastGood = artifact(['ext:@acme/widgets/x', `${PACKAGE_ID}@${V2}/x`])
    const identity = runningPackageIdentity({
      lastGood,
      packageId: PACKAGE_ID,
      pkg: installed('1.2.0', V3, { version: '1.1.0', integrity: V2 }),
    })
    expect(identity).toEqual({ integrity: V2, version: '1.1.0' })
  })

  it('takes the version from the installed entry when that is what is running', () => {
    const lastGood = artifact(['ext:@acme/widgets/x', `${PACKAGE_ID}@${V3}/x`])
    expect(runningPackageIdentity({ lastGood, packageId: PACKAGE_ID, pkg: installed('1.2.0', V3) })).toEqual({
      integrity: V3,
      version: '1.2.0',
    })
  })

  it('omits the version rather than guessing when the running integrity matches nothing known', () => {
    const lastGood = artifact(['ext:@acme/widgets/x', `${PACKAGE_ID}@${V1}/x`])
    const identity = runningPackageIdentity({
      lastGood,
      packageId: PACKAGE_ID,
      pkg: installed('1.2.0', V3, { version: '1.1.0', integrity: V2 }),
    })
    expect(identity).toEqual({ integrity: V1 })
    expect(identity).not.toHaveProperty('version')
  })

  it('returns nothing when the worker has applied no row of this package', () => {
    const other = artifact(['ext:@other/pkg/x', `@other/pkg@${V1}/x`])
    expect(runningPackageIdentity({ lastGood: other, packageId: PACKAGE_ID, pkg: installed('1', V1) })).toBe(
      undefined,
    )
  })

  it('returns nothing when nothing has been applied at all', () => {
    expect(
      runningPackageIdentity({ lastGood: undefined, packageId: PACKAGE_ID, pkg: installed('1', V1) }),
    ).toBe(undefined)
  })

  it('does not mistake a package whose id merely starts with the same text', () => {
    // `@acme/widgets-extra@…` must not be read as a row of `@acme/widgets`.
    const lastGood = artifact(['ext:@acme/widgets-extra/x', `@acme/widgets-extra@${V1}/x`])
    expect(runningPackageIdentity({ lastGood, packageId: PACKAGE_ID, pkg: installed('1', V1) })).toBe(
      undefined,
    )
  })
})
