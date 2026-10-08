import { describe, expect, it } from 'vitest'
import {
  classifyPackageContributions,
  packageActualReady,
  packageExtensionRowsActive,
  packageExtensionRowsStopped,
  packageOwnsReportRow,
} from '../src/package-readiness.js'

describe('package readiness classes', () => {
  it('classifies mixed, surface-only, client-only, and extension-only packages', () => {
    expect(classifyPackageContributions([{ kind: 'extension' }, { kind: 'surface' }])).toBe('mixed')
    expect(classifyPackageContributions([{ kind: 'surface' }])).toBe('surface-only')
    expect(classifyPackageContributions([{ kind: 'extension', client: { entry: './ui.js' } }])).toBe(
      'client-only',
    )
    expect(
      classifyPackageContributions([
        { kind: 'extension', client: { entry: './ui.js' }, capabilities: { ui: ['client'], services: [{}] } },
      ]),
    ).toBe('extension-only')
    expect(classifyPackageContributions([{ kind: 'extension' }])).toBe('extension-only')
    expect(classifyPackageContributions([{ kind: 'client' }], true)).toBe('extension-only')
    expect(classifyPackageContributions([{ kind: 'surface' }], true)).toBe('mixed')
  })

  it('does not treat a qualified tree with no matching or only disabled rows as active', () => {
    expect(packageExtensionRowsActive('@agnes-examples/hot-tool', [])).toBe(false)
    expect(
      packageExtensionRowsActive('@agnes-examples/hot-tool', [
        { id: 'ext:@agnes-examples/hot-tool/fail', state: 'disabled' },
      ]),
    ).toBe(false)
    expect(
      packageExtensionRowsActive('@agnes-examples/hot-tool', [
        { id: 'seam:provider', state: 'active' },
        { id: 'preset:coding', state: 'active' },
      ]),
    ).toBe(false)
    expect(
      packageExtensionRowsActive('@agnes-examples/hot-tool', [
        { id: 'ext:@agnes-examples/hot-tool/tool', state: 'active' },
      ]),
    ).toBe(true)
  })

  it('knows a row by the ids the tree loads from the package, not only by its name', () => {
    const custom = 'ext:vendor/custom-name'
    expect(packageOwnsReportRow('@acme/pkg', custom)).toBe(false)
    expect(packageOwnsReportRow('@acme/pkg', custom, new Set([custom]))).toBe(true)
    expect(packageOwnsReportRow('@acme/pkg', 'ext:@acme/pkg/tool')).toBe(true)
    expect(packageExtensionRowsActive('@acme/pkg', [{ id: custom, state: 'active' }])).toBe(false)
    expect(
      packageExtensionRowsActive('@acme/pkg', [{ id: custom, state: 'active' }], new Set([custom])),
    ).toBe(true)
    expect(
      packageExtensionRowsStopped('@acme/pkg', [{ id: custom, state: 'active' }], new Set([custom])),
    ).toBe(false)
  })

  it('treats a package as stopped when none of its rows are anything but disabled', () => {
    const owned = 'ext:@agnes-examples/hot-tool/tool'
    // Never enabled, or removed from the desired tree: nothing of this package is in the report.
    expect(packageExtensionRowsStopped('@agnes-examples/hot-tool', [])).toBe(true)
    expect(
      packageExtensionRowsStopped('@agnes-examples/hot-tool', [{ id: 'seam:provider', state: 'active' }]),
    ).toBe(true)
    // Disabled or removed: the desired tree keeps its rows, marked disabled.
    expect(packageExtensionRowsStopped('@agnes-examples/hot-tool', [{ id: owned, state: 'disabled' }])).toBe(
      true,
    )
    // Anything still starting, running, or broken is not stopped.
    for (const state of ['active', 'pending', 'loading', 'waiting-drain', 'failed']) {
      expect(packageExtensionRowsStopped('@agnes-examples/hot-tool', [{ id: owned, state }])).toBe(false)
    }
    expect(
      packageExtensionRowsStopped('@agnes-examples/hot-tool', [
        { id: owned, state: 'disabled' },
        { id: `${owned}-2`, state: 'active' },
      ]),
    ).toBe(false)
  })

  it('requires worker report and surface revision for mixed actual', () => {
    expect(
      packageActualReady({
        class: 'mixed',
        desiredPublished: true,
        treeQualified: true,
        extensionRowsActive: true,
        surfaceRunningRevision: 'rev-2',
        desiredSurfaceRevision: 'rev-2',
        clientRosterMatch: false,
      }),
    ).toBe(true)
    expect(
      packageActualReady({
        class: 'mixed',
        desiredPublished: true,
        treeQualified: true,
        extensionRowsActive: true,
        surfaceRunningRevision: 'rev-1',
        desiredSurfaceRevision: 'rev-2',
        clientRosterMatch: false,
      }),
    ).toBe(false)
  })

  it('does not wait on worker report for surface-only actual', () => {
    expect(
      packageActualReady({
        class: 'surface-only',
        desiredPublished: true,
        treeQualified: false,
        extensionRowsActive: false,
        surfaceRunningRevision: 'surf-1',
        desiredSurfaceRevision: 'surf-1',
        clientRosterMatch: false,
      }),
    ).toBe(true)
    expect(
      packageActualReady({
        class: 'surface-only',
        desiredPublished: false,
        treeQualified: false,
        extensionRowsActive: false,
        surfaceRunningRevision: 'surf-1',
        desiredSurfaceRevision: 'surf-1',
        clientRosterMatch: false,
      }),
    ).toBe(false)
  })

  it('requires client roster match for client-only and ignores a late worker qualification', () => {
    expect(
      packageActualReady({
        class: 'client-only',
        desiredPublished: true,
        treeQualified: true,
        extensionRowsActive: true,
        clientRosterMatch: true,
      }),
    ).toBe(true)
    expect(
      packageActualReady({
        class: 'client-only',
        desiredPublished: true,
        treeQualified: true,
        extensionRowsActive: true,
        clientRosterMatch: false,
      }),
    ).toBe(false)
  })
})
