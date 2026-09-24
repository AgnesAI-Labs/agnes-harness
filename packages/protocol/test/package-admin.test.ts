import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canAccessPackageAdmin,
  METHODS,
  PACKAGE_ADMIN_METHODS,
  PACKAGE_ADMIN_PERMISSIONS,
  type PackageAdminMethodName,
  projectClientModuleRows,
  validateMethod,
  validatePackageAdminCall,
  validatePackageAdminData,
} from '../src/index.js'
import { runFixtureFiles } from '../tools/conformance-core.js'

const file = fileURLToPath(new URL('../fixtures/package-admin/package-admin.jsonl', import.meta.url))
const rows = readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const valid = (name: string) =>
  structuredClone(rows.find((row) => row.name === name && row.kind === 'valid').payload)

describe('PM4 management contracts', () => {
  it('validates all checked-in contracts through production entry points', () => {
    const result = runFixtureFiles([file])
    expect(result.failed).toEqual([])
    // 380 -> 382 added the skin roster samples (S5/S15); 382 -> 390 adds the skin read DTOs, their
    // method-side params row and the actor-rejection row (S14b); 390 -> 403 adds the client-module
    // roster/read DTOs and their method-side params rows (P1a); 455 -> 457 adds row-level
    // negatives proving config/credential fields are refused, plus standalone row fixtures for
    // the generated-schema parity table.
    expect(result.total).toBe(486)
    expect(result.skipped).toBe(0)
  })
  it('requires explicit classification, permission and command identity for every management method', () => {
    // `skins.list`/`skins.read` and `clientModules.list`/`clientModules.read` joined this table as
    // read-only methods derived from the installed-package inventory, so the namespace filter covers
    // `skins.`/`clientModules.` too; the equality below still pins the table to those namespaces
    // rather than accepting any method name.
    const names = Object.keys(METHODS)
      .filter((name) => /^_agnes\/v1\/(?:packages|skins|clientModules|plugins)\./.test(name))
      .sort()
    expect(names).toEqual(Object.keys(PACKAGE_ADMIN_METHODS).sort())
    expect(names).toHaveLength(27)
    for (const name of names as PackageAdminMethodName[]) {
      const method = METHODS[name],
        policy = method.administration
      expect(policy).toBeDefined()
      if (!policy) throw new Error('missing policy')
      expect(PACKAGE_ADMIN_PERMISSIONS).toContain(policy.permission)
      expect(['read', 'effect', 'unblock']).toContain(policy.execution)
      expect(policy.identity).toBe(policy.execution === 'read' ? 'none' : 'principal-client-command')
      expect(Object.isFrozen(policy)).toBe(true)
      const params = structuredClone(
        rows.find((row) => row.name === name && row.side === 'params' && row.kind === 'valid').payload,
      )
      if (policy.execution !== 'read') {
        delete params.commandId
        expect(validateMethod(name, 'params', params).ok).toBe(false)
      }
    }
  })
  it.each(['chat', 'extension', 'surface', 'unknown'])(
    'never grants management to %s audience, even with all claimed permissions',
    (audience) => {
      for (const name of Object.keys(PACKAGE_ADMIN_METHODS) as PackageAdminMethodName[])
        expect(canAccessPackageAdmin(name, { audience, permissions: PACKAGE_ADMIN_PERMISSIONS })).toBe(false)
    },
  )
  it('admin still needs exactly the permission for each operation', () => {
    for (const name of Object.keys(PACKAGE_ADMIN_METHODS) as PackageAdminMethodName[]) {
      const permission = PACKAGE_ADMIN_METHODS[name].administration.permission
      expect(canAccessPackageAdmin(name, { audience: 'admin', permissions: [] })).toBe(false)
      expect(canAccessPackageAdmin(name, { audience: 'admin', permissions: [permission] })).toBe(true)
      expect(
        canAccessPackageAdmin(name, {
          audience: 'admin',
          permissions: PACKAGE_ADMIN_PERMISSIONS.filter((p) => p !== permission),
        }),
      ).toBe(false)
    }
  })
  it('rejects getters, cycles, non-JSON and total-size overflow before recursive schema validation', () => {
    const params = valid('PackageInstallParams')
    let reads = 0
    Object.defineProperty(params, 'source', {
      get() {
        reads++
        return {}
      },
      enumerable: true,
    })
    expect(validateMethod('_agnes/v1/packages.install', 'params', params).ok).toBe(false)
    expect(reads).toBe(0)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(validatePackageAdminData('PackagePreview', cyclic).ok).toBe(false)
    expect(validatePackageAdminData('PackagePreview', { ...valid('PackagePreview'), callback() {} }).ok).toBe(
      false,
    )
    const installed = valid('PackageInstalledDescriptor')
    installed.contributions = Array.from({ length: 128 }, (_, i) => ({
      kind: 'extension',
      id: `pkg${i}`,
      path: './index.js',
      apiRange: '^1.0',
      capabilities: {
        tools: { prefix: 'fx_', names: Array.from({ length: 256 }, () => `fx_${'x'.repeat(50)}`) },
      },
    }))
    expect(validatePackageAdminData('PackageInstalledDescriptor', installed).ok).toBe(false)
  })
  it('validates packages.pins.inspect/release params and results', () => {
    expect(
      validatePackageAdminCall('_agnes/v1/packages.pins.inspect', 'params', { profile: 'local-dev' }).ok,
    ).toBe(true)
    expect(
      validatePackageAdminData('PackagePinsInspectResult', {
        orphans: [
          {
            pinId: 'act-abc123',
            purpose: 'candidate',
            packageId: '@acme/pkg',
            version: '1.0.0',
            snapshotId: `sha256-${'a'.repeat(64)}`,
            operationId: 'op-1',
          },
        ],
      }).ok,
    ).toBe(true)
    expect(
      validatePackageAdminCall('_agnes/v1/packages.pins.release', 'params', {
        profile: 'local-dev',
        clientId: 'client-1',
        commandId: 'cmd-1',
        pinIds: ['act-abc123'],
      }).ok,
    ).toBe(true)
    expect(
      validatePackageAdminCall('_agnes/v1/packages.pins.release', 'params', {
        profile: 'local-dev',
        clientId: 'client-1',
        commandId: 'cmd-1',
        pinIds: [],
      }).ok,
    ).toBe(false)
    expect(
      validatePackageAdminData('PackagePinsReleaseResult', {
        results: [{ pinId: 'act-abc123', outcome: 'released' }],
      }).ok,
    ).toBe(true)
  })

  it('preserves verified client content digests through the browser row projection', () => {
    const contentDigest = `sha256-${'a'.repeat(64)}`
    const module = {
      rowId: 'web:acme/ui',
      packageId: 'acme/ui',
      revision: 'sha256-revision',
      entryUrl: '/plugins/acme/ui/sha256-revision/client.js',
      styleUrls: [],
      slots: ['conversation.chat.node'],
      slotCatalogVersion: 'dsh-client-slots/v1',
      contentDigest,
      extIds: [],
    }
    const status = {
      packageId: 'acme/ui',
      installedRevision: 'sha256-revision',
      backendRevision: null,
      state: 'ready' as const,
    }
    const withRows = projectClientModuleRows({
      revision: 'roster-1',
      serverTime: '2026-09-22T00:00:00.000Z',
      modules: [module],
      statuses: [status],
      rowAliases: { 'web:acme/legacy': 'web:acme/ui' },
      rows: [
        {
          rowId: 'web:acme/ui',
          moduleName: 'ui',
          packageId: 'acme/ui',
          enabled: true,
          phase: 'ready',
          contentDigest,
        },
      ],
    })
    expect(withRows.modules[0]?.contentDigest).toBe(contentDigest)
    expect(withRows.rows?.[0]?.contentDigest).toBe(contentDigest)
    expect(withRows.rowAliases).toEqual({ 'web:acme/legacy': 'web:acme/ui' })

    const compatibility = projectClientModuleRows({
      revision: 'roster-1',
      serverTime: '2026-09-22T00:00:00.000Z',
      modules: [module],
      statuses: [status],
      rowAliases: { 'web:acme/legacy': 'web:acme/ui' },
    })
    expect(compatibility.rows?.[0]?.contentDigest).toBe(contentDigest)
    expect(compatibility.rowAliases).toEqual({ 'web:acme/legacy': 'web:acme/ui' })
  })
})
