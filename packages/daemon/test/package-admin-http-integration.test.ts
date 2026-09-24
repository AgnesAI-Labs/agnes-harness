import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestHost } from '@agnes/host/testkit'
import { createPackageManager, emptyLock, readLock, writeLock } from '@agnes/package-manager'
import type {
  PackageInspectParams,
  PackageInstallParams,
  PackageListParams,
  PackageOperation,
  PackageOperationGetParams,
  PackageOperationReceipt,
} from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { expect, it } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { type AdminSurfaceAction, createAdminSurface } from '../src/packages/admin-surface.js'
import {
  createPackageAdminService,
  FilePackageOperationStore,
  scopedPackageProfileDirectory,
} from '../src/packages/index.js'

it('installs actual bytes through authenticated HTTP → Node SDK → shared handler and reads the same durable result after reconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-admin-http-'))
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  cpSync(new URL('../../package-manager/test/fixtures/pkg-a', import.meta.url), join(root, 'candidate'), {
    recursive: true,
  })
  writeFileSync(join(root, 'candidate', 'index.ts'), "throw new Error('install must not execute this entry')")
  writeLock(profileDir, {
    ...emptyLock('local-dev', '0.1.0'),
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
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
  const manager = createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0' })
  const service = () =>
    createPackageAdminService({
      manager,
      profileDirectory: scopedPackageProfileDirectory({ profile: 'local-dev', profileDir }),
      operations: new FilePackageOperationStore(join(root, 'operations')),
    })
  const { host } = await createTestHost({ dataDir: join(root, 'host'), script: [] })
  const endpoint = createLocalEndpoint(host, { packageAdmin: { service: service() } })
  const client = createClient({
    transport: { kind: 'inproc', endpoint },
    auth: { kind: 'local' },
    journal: memoryJournal('admin-web'),
  })
  let admin: ReturnType<typeof createAdminSurface>
  const http = createServer(async (req, res) => {
    if (!(await admin.handle(req, res))) res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  const origin = `http://127.0.0.1:${address.port}`
  const invoke = async (action: AdminSurfaceAction, params: unknown) => {
    switch (action) {
      case 'list':
        return client.packages.list(params as PackageListParams)
      case 'inspect':
        return client.packages.inspect(params as PackageInspectParams)
      case 'install':
        return client.packages.install(params as PackageInstallParams)
      case 'operation/get':
        return client.packages.operation.get(params as PackageOperationGetParams)
      default:
        throw new Error('not used in this test')
    }
  }
  admin = createAdminSurface({
    origin,
    token: 'local-lifecycle-test-token',
    profile: 'local-dev',
    clientId: 'admin-web',
    invoke,
  })
  let cookie = ''
  const post = (action: string, body: unknown) =>
    fetch(`${origin}/admin/plugins/api/${action}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
  const completed = async (receipt: PackageOperationReceipt): Promise<PackageOperation> => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const response = await post('operation/get', receipt)
      expect(response.status).toBe(200)
      const operation = (await response.json()) as PackageOperation
      if (['completed', 'failed', 'cancelled'].includes(operation.state)) return operation
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('operation did not settle')
  }
  try {
    await client.initialize()
    expect(await client.packages.list({ profile: 'local-dev' })).toEqual({ packages: [] })
    const login = await post('session', { token: 'local-lifecycle-test-token' })
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    const context = await fetch(`${origin}/admin/plugins/api/context`, { headers: { Cookie: cookie } })
    expect(await context.json()).toMatchObject({ readOnly: false })
    const source = { type: 'file' as const, ref: 'file:./candidate' }
    const identity = { profile: 'local-dev', clientId: 'admin-web' }
    const previewResponse = await post('inspect', { ...identity, commandId: 'preview-1', source })
    expect(previewResponse.status).toBe(200)
    const preview = await completed((await previewResponse.json()) as PackageOperationReceipt)
    expect(preview.state).toBe('completed')
    if (!preview.preview) throw new Error('missing preview')
    const installParams = {
      ...identity,
      commandId: 'install-1',
      source,
      expectedIntegrity: preview.preview.integrity,
    }
    const installResponse = await post('install', installParams)
    const receipt = (await installResponse.json()) as PackageOperationReceipt
    const installed = await completed(receipt)
    expect(installed).toMatchObject({
      state: 'completed',
      installed: { id: 'acme/pkg-a', trusted: false, desired: 'installed-disabled' },
    })
    expect(await (await post('install', installParams)).json()).toEqual(receipt)
    expect(
      readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages['acme/pkg-a']?.state
        .enabled,
    ).toBe(false)
    expect(await client.packages.list({ profile: 'local-dev' })).toMatchObject({
      packages: [{ id: 'acme/pkg-a', trusted: false }],
    })
    const freshEndpoint = createLocalEndpoint(host, { packageAdmin: { service: service() } })
    const freshClient = createClient({
      transport: { kind: 'inproc', endpoint: freshEndpoint },
      auth: { kind: 'local' },
      journal: memoryJournal('admin-web'),
    })
    try {
      await freshClient.initialize()
      expect(await freshClient.packages.operation.get(receipt)).toEqual(installed)
    } finally {
      await freshClient.close()
    }
  } finally {
    admin.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await client.close()
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})
