import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackageManager, emptyLock, writeLock } from '@agnes/package-manager'
import type { PackageCatalogPage, PackageOperation } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import {
  createPackageAdminService,
  FilePackageOperationStore,
  PACKAGE_ADMIN_ALL_PERMISSIONS,
  packageOperationTerminal,
} from '../src/packages/index.js'

import { discoverLocalExamples } from '../src/packages/local-examples.js'

const workspace = fileURLToPath(new URL('../../..', import.meta.url))
const profile = 'local-dev'
const clientId = 'catalog-page-test'
const now = '2026-09-13T00:00:00.000Z'
const held: string[] = []
const authority = {
  audience: 'admin' as const,
  principalId: 'unix:catalog-page-test',
  clientId,
  permissions: PACKAGE_ADMIN_ALL_PERMISSIONS,
}

afterEach(() => {
  for (const directory of held.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function settled(
  service: ReturnType<typeof createPackageAdminService>,
  operationId: string,
): Promise<PackageOperation> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const operation = (await service.call(
      '_agnes/v1/packages.operation.get',
      { profile, operationId },
      authority,
    )) as PackageOperation
    if (packageOperationTerminal(operation.state)) return operation
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`operation did not settle: ${operationId}`)
}

it('serves real local examples through daemon catalog and source inspection', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-local-catalog-'))
  held.push(dataDir)
  const profileDir = join(dataDir, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  writeLock(profileDir, {
    ...emptyLock(profile, '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      [
        'approval',
        'checkpoint',
        'ledger',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
        'platform',
        'harness',
      ].map((name) => [name, '@agnes/base']),
    ),
    policySnapshot: {
      capabilityCeiling: ['tools', 'hooks'],
      workspacePackages: 'require-project-trust',
    },
  })
  const manager = createPackageManager({
    dataDir,
    cwd: workspace,
    agnesVersion: '0.1.0',
    references: async () => [],
    now: () => now,
  })
  const catalog = await discoverLocalExamples(workspace)
  const service = createPackageAdminService({
    manager,
    profileDirectory: async (requested) => {
      if (requested !== profile) throw new Error('profile scope violation')
      return profileDir
    },
    operations: new FilePackageOperationStore(join(dataDir, 'operations')),
    catalog,
    clock: () => now,
  })

  const helpers = (await service.call(
    '_agnes/v1/packages.catalog.list',
    { profile, query: 'skill-helper', limit: 50 },
    authority,
  )) as PackageCatalogPage
  expect(helpers.items).toHaveLength(1)
  expect(helpers.items[0]).toMatchObject({ id: '@agnes/skill-helper', sourceId: 'builtin-plugins' })

  const page = (await service.call(
    '_agnes/v1/packages.catalog.list',
    { profile, query: '@agnes-examples/hot-service', limit: 50 },
    authority,
  )) as PackageCatalogPage
  expect(page.items.map((item) => item.version)).toEqual(['1.0.0', '1.1.0'])
  expect(page.items.every((item) => item.source.ref.startsWith('file:./examples/packages/'))).toBe(true)
  const selected = await service.call(
    '_agnes/v1/packages.catalog.get',
    { profile, id: '@agnes-examples/hot-service', version: '1.1.0' },
    authority,
  )
  expect(selected).toEqual(page.items[1])

  const receipt = (await service.call(
    '_agnes/v1/packages.inspect',
    {
      profile,
      clientId,
      commandId: 'inspect-catalog-hot-service-v2',
      source: page.items[1]?.source,
    },
    authority,
  )) as { operationId: string }
  const operation = await settled(service, receipt.operationId)
  expect(operation).toMatchObject({
    state: 'completed',
    packageId: '@agnes-examples/hot-service',
    preview: {
      id: '@agnes-examples/hot-service',
      version: '1.1.0',
      source: page.items[1]?.source,
      contributions: [],
    },
  })
  expect(operation.preview?.integrity).toBe(page.items[1]?.integrity)
})
