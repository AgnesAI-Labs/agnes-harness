import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { PackageSource } from '../gen/ts/package-admin.js'
import {
  canAccessPackageAdmin,
  METHODS,
  PACKAGE_ADMIN_METHODS,
  PACKAGE_ADMIN_PERMISSIONS,
  type PackageAdminMethodName,
  type PackageCatalogPage,
  projectClientModuleRows,
  validateAgainst,
  validateMethod,
  validatePackageAdminCall,
  validatePackageAdminData,
  validatePackageCatalogSnapshotVersion,
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
  it('accepts only a bound installed Docs read and its two closed result variants', () => {
    const method = '_agnes/v1/packages.docs.get'
    const params = {
      profile: 'local-dev',
      id: '@acme/plugin',
      locale: 'zh-CN',
      expectedIntegrity: `sha512-${'a'.repeat(86)}==`,
    }
    expect(validatePackageAdminCall(method, 'params', params).ok).toBe(true)
    for (const change of [
      { id: '../plugin' },
      { locale: 'fr' },
      { expectedIntegrity: 'latest' },
      { docsConnectionEpoch: 'bff-only' },
      { url: 'https://example.invalid/README.md' },
    ])
      expect(validatePackageAdminCall(method, 'params', { ...params, ...change }).ok).toBe(false)
    expect(validatePackageAdminCall(method, 'result', { found: false }).ok).toBe(true)
    const result = { found: true, locale: 'en', markdown: 'x'.repeat(65_536) }
    expect(validatePackageAdminCall(method, 'result', result).ok).toBe(true)
    expect(
      validatePackageAdminCall(method, 'result', { ...result, markdown: `${result.markdown}x` }).ok,
    ).toBe(false)
    expect(validatePackageAdminCall(method, 'result', { ...result, path: 'README.md' }).ok).toBe(false)
    expect(canAccessPackageAdmin(method, { audience: 'admin', permissions: ['packages.read'] })).toBe(true)
    expect(canAccessPackageAdmin(method, { audience: 'admin', permissions: ['packages.install'] })).toBe(
      false,
    )
  })

  it('requires explicit digest and trust baselines for every reviewed dependent update', () => {
    const base = valid('_agnes/v1/packages.update')
    const activation = {
      expectedInstalledIntegrity: `sha256-${'1'.repeat(64)}`,
      expectedActiveIntegrity: null,
      trust: { integrity: `sha256-${'2'.repeat(64)}`, capabilityHash: '3'.repeat(64) },
    }
    const dependent = {
      id: 'acme/dependent',
      source: base.source,
      expectedIntegrity: activation.trust.integrity,
      activation,
    }
    expect(
      validatePackageAdminCall('_agnes/v1/packages.update', 'params', {
        ...base,
        activation,
        dependents: [dependent],
      }).ok,
    ).toBe(true)
    for (const key of ['activation', 'expectedIntegrity', 'source']) {
      const incomplete: Record<string, unknown> = { ...dependent }
      delete incomplete[key]
      expect(
        validatePackageAdminCall('_agnes/v1/packages.update', 'params', { ...base, dependents: [incomplete] })
          .ok,
      ).toBe(false)
    }
    expect(
      validatePackageAdminCall('_agnes/v1/packages.update', 'params', {
        ...base,
        dependents: [{ ...dependent, approved: true }],
      }).ok,
    ).toBe(false)
  })
  it('serves resource payloads through the same read contract up to the 32 MiB raw cap', () => {
    const base64 = Buffer.alloc(32 * 1024 * 1024).toString('base64')
    expect(validateMethod('_agnes/v1/clientModules.read', 'result', { found: true, base64 }).ok).toBe(true)
    expect(
      validateMethod('_agnes/v1/clientModules.read', 'result', { found: true, base64: `${base64}A` }).ok,
    ).toBe(false)
  })

  it('validates all checked-in contracts through production entry points', () => {
    const failure = { code: 'E_PACKAGE_SOURCE', safeMessage: 'Source refused.', blockers: [] }
    expect(validatePackageAdminData('PackageAdminError', failure).ok).toBe(true)
    for (const sourceFailure of [
      'manifest-missing',
      'manifest-invalid',
      'not-plugin',
      'git-ref',
      'git-fetch',
      'source-not-found',
    ])
      expect(validatePackageAdminData('PackageAdminError', { ...failure, sourceFailure }).ok).toBe(true)
    expect(
      validatePackageAdminData('PackageAdminError', { ...failure, sourceFailure: 'private stderr' }).ok,
    ).toBe(false)
    const write = valid('_agnes/v1/plugins.candidates.write')
    for (const mode of ['replace', 'merge']) {
      expect(
        validatePackageAdminCall('_agnes/v1/plugins.candidates.write', 'params', {
          ...write,
          mode,
          files: [],
          remove: [],
        }).ok,
      ).toBe(true)
      expect(
        validatePackageAdminCall('_agnes/v1/plugins.candidates.write', 'params', {
          ...write,
          mode,
          expectedHash: undefined,
        }).ok,
      ).toBe(false)
    }
    expect(
      validatePackageAdminCall('_agnes/v1/plugins.candidates.write', 'params', {
        ...write,
        mode: 'patch',
      }).ok,
    ).toBe(false)
    const result = runFixtureFiles([file])
    expect(result.failed).toEqual([])
    expect(result.skipped).toBe(0)
  })
  it('requires explicit classification, permission and command identity for every management method', () => {
    // `skins.list`/`skins.read` and `clientModules.list`/`clientModules.read` joined this table as
    // read-only methods derived from the installed-package inventory, so the namespace filter covers
    // `skins.`/`clientModules.` too; the equality below still pins the table to those namespaces
    // rather than accepting any method name.
    const names = Object.keys(METHODS)
      .filter((name) =>
        /^_agnes\/v1\/(?:applications|packages|skins|clientModules|plugins|sessions)\./.test(name),
      )
      .sort()
    expect(names).toEqual(Object.keys(PACKAGE_ADMIN_METHODS).sort())
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
      apiRange: '^5.0.0',
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

  it('preserves reviewed client declarations and content digests through the browser row projection', () => {
    const contentDigest = `sha256-${'a'.repeat(64)}`
    const intelligentComponents = [
      {
        kind: 'acme/ui/diff@1',
        propsSchema: { type: 'object' },
        maxPropsBytes: 256,
        fallback: 'Use table.',
        accessibility: { label: 'Differences', keyboard: true as const },
      },
    ]
    const module = {
      intelligentComponents,
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
          binding: {
            lifetime: 'profile',
            owner: 'web:acme/ui',
            packageId: 'acme/ui',
            integrity: 'sha256-revision',
            profileId: 'test',
            activationId: 'activation-1',
            availability: 'active',
          },
          homeEntries: [{ id: 'board', placement: 'primary' }],
          examplePages: ['scene'],
          exampleOf: 'acme/host',
          pageEntry: 'scene',
          streams: ['acme.events'],
          packageId: 'acme/ui',
          enabled: true,
          phase: 'ready',
          intelligentComponents,
          contentDigest,
        },
      ],
    })
    expect(withRows.modules[0]?.intelligentComponents).toEqual(intelligentComponents)
    expect(withRows.rows?.[0]?.intelligentComponents).toEqual(intelligentComponents)
    expect(withRows.modules[0]?.contentDigest).toBe(contentDigest)
    expect(withRows.rows?.[0]?.contentDigest).toBe(contentDigest)
    expect(withRows.rows?.[0]?.streams).toEqual(['acme.events'])
    expect(withRows.rows?.[0]?.binding).toMatchObject({ lifetime: 'profile', activationId: 'activation-1' })
    expect(withRows.rows?.[0]?.homeEntries).toEqual([{ id: 'board', placement: 'primary' }])
    expect(withRows.rows?.[0]?.examplePages).toEqual(['scene'])
    expect(withRows.rows?.[0]?.exampleOf).toBe('acme/host')
    expect(withRows.rowAliases).toEqual({ 'web:acme/legacy': 'web:acme/ui' })

    const compatibility = projectClientModuleRows({
      revision: 'roster-1',
      serverTime: '2026-09-22T00:00:00.000Z',
      modules: [module],
      statuses: [status],
      rowAliases: { 'web:acme/legacy': 'web:acme/ui' },
    })
    expect(compatibility.rows?.[0]?.intelligentComponents).toEqual(intelligentComponents)
    expect(compatibility.rows?.[0]?.contentDigest).toBe(contentDigest)
    expect(compatibility.rowAliases).toEqual({ 'web:acme/legacy': 'web:acme/ui' })
  })
})

it('keeps the large index response budget scoped to catalogs and accepts only supported opt-ins', () => {
  const snapshot = {
    state: 'ready',
    lastSuccessAt: null,
    nextAttemptAt: null,
    error: null,
    totalReported: 600,
    items: Array.from({ length: 600 }, (_, i) => ({
      id: 'plugin-' + i,
      fullName: 'example/plugin',
      description: 'x'.repeat(2000),
      summary: 'x'.repeat(2000),
    })),
  }
  const page = { items: [], nextCursor: null, communityIndex: snapshot }
  expect(validatePackageAdminData('PackageCatalogPage', page).ok).toBe(true)
  expect(validatePackageAdminCall('_agnes/v1/packages.catalog.list', 'result', page).ok).toBe(true)
  expect(
    validatePackageAdminCall('_agnes/v1/clientModules.callService', 'result', { output: snapshot }).ok,
  ).toBe(false)
  expect(
    validatePackageAdminCall('_agnes/v1/packages.catalog.list', 'params', {
      profile: 'local-dev',
      communityVersion: 2,
    }).ok,
  ).toBe(true)
  for (const invalid of [
    { profile: 'local-dev', communityVersion: 4 },
    { profile: 'local-dev', communityVersion: 3, includeCommunity: false },
  ]) {
    expect(validatePackageAdminCall('_agnes/v1/packages.catalog.list', 'params', invalid).ok).toBe(false)
    expect(validateMethod('_agnes/v1/packages.catalog.list', 'params', invalid).ok).toBe(false)
  }
  const v3 = { profile: 'local-dev', communityVersion: 3 }
  expect(validatePackageAdminCall('_agnes/v1/packages.catalog.list', 'params', v3).ok).toBe(true)
  expect(validateMethod('_agnes/v1/packages.catalog.list', 'params', v3).ok).toBe(true)
})

it('keeps indexed version projections closed and requires compatibility only on v3', () => {
  // The version validator as generated before v3, independent of the new union.
  const oldV2Version = Type.Object(
    { version: Type.String({ minLength: 1, maxLength: 128 }), source: PackageSource },
    { additionalProperties: false },
  )
  const v2 = {
    version: '1.0.0',
    source: { type: 'git' as const, ref: `git:https://github.com/acme/p.git#${'a'.repeat(40)}` },
  }
  const v3 = {
    ...v2,
    provides: ['tool', 'skills'] as const,
    publishTimestamp: 1,
    compatibility: { kind: 'declared-compatible' as const, range: '^1.0.0' },
  }
  const page = (versions: unknown[]) => ({
    items: [],
    nextCursor: null,
    communityIndex: {
      state: 'ready',
      lastSuccessAt: null,
      nextAttemptAt: null,
      error: null,
      totalReported: 1,
      items: [{ id: 'plugin', fullName: 'acme/p', description: '', versions }],
    },
  })
  expect(validateAgainst(oldV2Version, v2).ok).toBe(true)
  expect(validateAgainst(oldV2Version, v3).ok).toBe(false)
  for (const [expected, version] of [
    [2, v2],
    [3, v3],
  ] as const) {
    const wire = page([version])
    expect(validateMethod('_agnes/v1/packages.catalog.list', 'result', wire).ok).toBe(true)
    expect(validatePackageCatalogSnapshotVersion(wire as PackageCatalogPage, expected)).toBe(true)
    expect(validatePackageCatalogSnapshotVersion(wire as PackageCatalogPage, expected === 2 ? 3 : 2)).toBe(
      false,
    )
  }
  const mixed = page([v2, v3]) as PackageCatalogPage
  expect(validatePackageCatalogSnapshotVersion(mixed, 2)).toBe(false)
  expect(validatePackageCatalogSnapshotVersion(mixed, 3)).toBe(false)
  for (const invalid of [
    { ...v2, provides: ['tool'] },
    { ...v3, provides: ['tool', 'tool'] },
    { ...v3, publishTimestamp: 253402300800 },
    { ...v3, compatibility: { kind: 'incompatible' } },
    { ...v3, compatibility: { kind: 'unknown', range: false } },
    { ...v3, compatibility: { kind: 'undeclared', range: '*' } },
    { ...v3, compatibility: { kind: 'supported' } },
    { ...v3, aghEngine: { kind: 'range', range: '*' } },
  ]) {
    expect(validatePackageAdminData('PackageCatalogPage', page([invalid])).ok).toBe(false)
  }
})
