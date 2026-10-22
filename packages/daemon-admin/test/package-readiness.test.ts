import {
  type PackageInstalledDescriptor,
  type PluginGenerationStatus,
  validatePackageAdminData,
} from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  classifyPackageContributions,
  packageActualReady,
  packageExtensionRowsActive,
  packageExtensionRowsStopped,
  packageOwnsReportRow,
} from '../src/package-readiness.js'
import { projectPluginPrimaryStatus } from '../src/packages/primary-status.js'

describe('package readiness classes', () => {
  it('classifies mixed, surface-only, client-only, and extension-only packages', () => {
    expect(classifyPackageContributions([{ kind: 'extension' }, { kind: 'surface' }])).toBe('mixed')
    expect(classifyPackageContributions([{ kind: 'surface' }])).toBe('surface-only')
    expect(classifyPackageContributions([{ kind: 'extension', client: { entry: './ui.js' } }])).toBe(
      'client-only',
    )
    expect(
      classifyPackageContributions([
        { kind: 'extension', client: { entry: './ui.js' }, capabilities: { ui: true, services: [{}] } },
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

describe('primary plugin read status', () => {
  const installed: PackageInstalledDescriptor = {
    id: 'acme/plugin',
    version: '1.0.0',
    integrity: `sha256-${'a'.repeat(64)}`,
    source: { type: 'file', ref: 'file:./plugin' },
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    blockers: [],
    contributions: [],
  }
  it.each([
    [{ trusted: false, desired: 'installed-disabled' }, undefined, 'untrusted', 'trust-required', 'trust'],
    [
      { trusted: false, actual: 'running', draining: true },
      'draining',
      'untrusted',
      'trust-required',
      'trust',
    ],
    [
      { trusted: false, actual: 'restart-required' },
      'restart-required',
      'untrusted',
      'trust-required',
      'trust',
    ],
    [{ desired: 'installed-disabled', actual: 'not-running' }, undefined, 'disabled', 'disabled', 'enable'],
    [{ desired: 'installed-disabled', actual: 'running' }, undefined, 'disabled', 'disabled', 'enable'],
    [{ actual: 'not-running' }, undefined, 'blocked', 'not-running', 'none'],
    [{ actual: 'unavailable' }, undefined, 'blocked', 'observation-unavailable', 'none'],
    [{ actual: 'starting' }, undefined, 'blocked', 'starting', 'none'],
    [{ actual: 'failed' }, undefined, 'blocked', 'activation-failed', 'none'],
    [{}, 'failed', 'blocked', 'activation-failed', 'none'],
    [{ actual: 'failed' }, 'active', 'blocked', 'activation-failed', 'none'],
    [{ trusted: false }, 'active', 'untrusted', 'trust-required', 'trust'],
    [{ actual: 'unavailable' }, 'active', 'blocked', 'observation-unavailable', 'none'],
    [{ blockers: [{ code: 'policy', references: [] }] }, 'active', 'blocked', 'policy-blocked', 'none'],
    [{}, undefined, 'ready', 'ready', 'none'],
    [{ actualVersion: '0.9.0' }, undefined, 'blocked', 'not-running', 'none'],
    [{ actualIntegrity: `sha256-${'b'.repeat(64)}` }, undefined, 'blocked', 'not-running', 'none'],
    [{ draining: true }, 'active', 'ready', 'ready-with-history', 'none'],
    [{ actual: 'restart-required' }, undefined, 'restart-required', 'restart-required', 'restart'],
    [{}, 'restart-required', 'restart-required', 'restart-required', 'restart'],
    [
      { desired: 'installed-disabled' },
      'restart-required',
      'restart-required',
      'restart-required',
      'restart',
    ],
    // Open older sessions still belong to the historical-only state when disabled for new work.
    [
      { desired: 'installed-disabled', actual: 'not-running', draining: true },
      'draining',
      'historical-only',
      'historical-only',
      'enable',
    ],
    [{ actual: 'not-running', draining: true }, 'historical', 'historical-only', 'historical-only', 'none'],
    [
      { blockers: [{ code: 'dependency', references: ['acme/provider'] }] },
      undefined,
      'blocked',
      'dependency-missing',
      'install-dependency',
    ],
    [
      { actual: 'failed', actualReason: 'A required plugin service is missing.' },
      undefined,
      'blocked',
      'dependency-missing',
      'install-dependency',
    ],
    [{ blockers: [{ code: 'policy', references: [] }] }, undefined, 'blocked', 'policy-blocked', 'none'],
  ] satisfies [
    Partial<PackageInstalledDescriptor>,
    PluginGenerationStatus['plugins'][number]['state'] | undefined,
    string,
    string,
    string,
  ][])(
    'projects %j / %s as %s with a reason and action',
    (patch, generationState, state, reasonCode, nextAction) => {
      const item = { ...installed, ...patch }
      const before = structuredClone(item)
      const result = projectPluginPrimaryStatus(
        item,
        generationState
          ? {
              id: item.id,
              state: generationState,
              boundSessions: 2,
              drainingSessions: 2,
              historicalSessions: 0,
            }
          : undefined,
      )
      expect(result).toMatchObject({ state, reasonCode, nextAction })
      expect(result.reason.en.length).toBeGreaterThan(0)
      expect(result.reason['zh-CN'].length).toBeGreaterThan(0)
      expect(
        validatePackageAdminData('PackageInstalledDescriptor', { ...item, primaryStatus: result }).ok,
      ).toBe(true)
      expect(item).toEqual(before)
    },
  )
})
