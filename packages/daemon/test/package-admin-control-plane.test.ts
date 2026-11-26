import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeHome } from '@agnes/host'
import * as packageManager from '@agnes/package-manager'
import {
  activeRuntimePinId,
  createPackageManager,
  emptyLock,
  PackageError,
  type PackageManager,
  packageDir,
  parseSource,
  readLock,
  SKIN_MAX_ASSET_BYTES,
  writeLock,
} from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  type ApplicationPreview,
  jcs,
  type PackageOperation,
  type RuntimePinDescriptor,
  type RuntimePinReleaseResult,
  type SkinChoice,
  type SkinListResult,
  type SkinReadResult,
} from '@agnes/protocol'
import * as systemNode from '@agnes/system-node'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { openTestHost } from '../../daemon-rpc/test/host.js'
import {
  type ClientModuleRegistry,
  type ClientModulesChanged,
  createPackageAdminService,
  createPackageReferences,
  FilePackageOperationStore,
  PACKAGE_ADMIN_ALL_PERMISSIONS,
  type PackageActivationAdapter,
  type PackageAdminService,
  packageOperationTerminal,
  type RuntimePinsAdapter,
  scopedPackageProfileDirectory,
} from '../src/packages/index.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { runAgnesd } from '../src/supervisor/supervisor.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../package-manager/test/fixtures')
const examples = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/packages')
const now = '2026-09-13T00:00:00.000Z'
const profile = 'local-dev'
const secondProfile = 'local-two'
const clientId = 'daemon-test-client'
const authority = {
  audience: 'admin' as const,
  principalId: 'unix:test-owner',
  clientId,
  permissions: PACKAGE_ADMIN_ALL_PERMISSIONS,
}
const seams = ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals']

let root: string
let temporaryRoot: string
let profileDir: string
let manager: PackageManager
let source = parseSource('file:./candidate')

function createProfile(name: string, capabilityCeiling: readonly string[] = ['tools']): string {
  const directory = join(root, 'profiles', name)
  mkdirSync(directory, { recursive: true })
  writeLock(directory, {
    ...emptyLock(name, '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(seams.map((seam) => [seam, { provider: 'local' }])),
    policySnapshot: { capabilityCeiling: [...capabilityCeiling], workspacePackages: 'require-project-trust' },
  })
  return directory
}

function profileDirectory(name: string): string {
  return join(root, 'profiles', name)
}

function service(
  options: {
    manager?: PackageManager
    operations?: FilePackageOperationStore
    activation?: PackageActivationAdapter
    runtimePins?: RuntimePinsAdapter
    clientModules?: ClientModuleRegistry
    pluginTree?: CompositeTargetStore
    workerGeneration?: () => number
  } = {},
) {
  return createPackageAdminService({
    manager: options.manager ?? manager,
    profileDirectory: async (requested) => {
      if (requested !== profile && requested !== secondProfile) throw new Error('profile scope violation')
      return profileDirectory(requested)
    },
    operations:
      options.operations ?? new FilePackageOperationStore(join(root, 'daemon', 'package-operations')),
    ...(options.activation ? { activation: options.activation } : {}),
    ...(options.runtimePins ? { runtimePins: options.runtimePins } : {}),
    ...(options.clientModules ? { clientModules: options.clientModules } : {}),
    ...(options.pluginTree ? { pluginTree: options.pluginTree } : {}),
    ...(options.workerGeneration ? { workerGeneration: options.workerGeneration } : {}),
    clock: () => now,
  })
}

async function qualifyInstalledSkin(tree: CompositeTargetStore): Promise<void> {
  const row = (await manager.inventory(profileDirectory(secondProfile))).packages.find(
    (pkg) => pkg.id === '@agnes-examples/skins-builtin',
  )
  if (!row?.entry.treeIntegrity) throw new Error('skin package has no installed snapshot')
  const integrity = row.entry.integrity
  const pinId = activeRuntimePinId({ packageId: row.id, integrity })
  await manager.pinRuntimeSnapshot(profileDirectory(secondProfile), {
    pinId,
    operationId: pinId,
    packageId: row.id,
    purpose: 'active',
    selector: {
      kind: 'installed',
      expectedIntegrity: integrity,
      expectedTreeIntegrity: row.entry.treeIntegrity,
    },
  })
  const rowId = 'ext:examples/skins-builtin/main'
  const skinRow = createPluginRow({
    id: rowId,
    plugin: `${row.id}@${integrity}/main`,
    snapshotDigest: integrity,
    exportName: 'main',
    entryRevision: integrity,
    extrasRevision: 'none',
    mountRevision: 'skin-test:v1',
  })
  const webRow = createPluginRow({
    id: `web:${row.id}`,
    plugin: `${row.id}@${integrity}/client`,
    snapshotDigest: integrity,
    exportName: 'client',
    entryRevision: integrity,
    extrasRevision: 'none',
    mountRevision: 'skin-test:v1',
  })
  const ordinary = buildRuntimeTarget({
    rows: [skinRow],
    resources: { mcp: [], skills: {} },
    resourceRevision: 'a'.repeat(64),
    compositeRevision: 'b'.repeat(64),
  })
  const target = encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [skinRow, webRow],
      resources: { mcp: [], skills: {} },
      resourceRevision: 'a'.repeat(64),
      compositeRevision: 'b'.repeat(64),
    }),
  )
  tree.publishDesired(target)
  if (
    !tree.qualifyConverged(1, target, {
      // Host reports the ordinary tree; browser rows stay in the complete desired artifact.
      hash: ordinary.tree.hash,
      ok: true,
      rows: [{ id: rowId, state: 'active' }],
    })
  )
    throw new Error('skin target did not qualify')
}

function recordingClientModules(events: ClientModulesChanged[]): ClientModuleRegistry {
  const empty = { revision: `sha256-${'0'.repeat(64)}`, modules: [], statuses: [], serverTime: now }
  return {
    list: async () => empty,
    read: async () => ({ found: false }),
    refresh: async (input, reason, packageId) => {
      events.push({
        profile: input.profile,
        revision: empty.revision,
        reason,
        ...(packageId ? { packageId } : {}),
      })
      return empty
    },
    subscribe: () => () => undefined,
    close: () => undefined,
  }
}

async function operation(
  admin: ReturnType<typeof service>,
  profileName: string,
  operationId: string,
  actor = authority,
): Promise<PackageOperation> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = (await admin.call(
      '_agnes/v1/packages.operation.get',
      { profile: profileName, operationId },
      actor,
    )) as PackageOperation
    if (packageOperationTerminal(value.state)) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`operation did not settle: ${operationId}`)
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

function command(commandId: string, profileName = profile) {
  return { profile: profileName, clientId, commandId, source }
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'agnes-package-admin-'))
  root = join(temporaryRoot, 'home')
  createPrivateDirectorySync(root)
  initializeHome(root)
  profileDir = createProfile(profile)
  createProfile(secondProfile)
  cpSync(join(fixtures, 'pkg-a'), join(root, 'candidate'), { recursive: true })
  source = parseSource('file:./candidate')
  manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    references: async () => [],
    now: () => now,
  })
})

// A completed operation refreshes the client-module snapshots in the background after its terminal
// state is visible, and the service offers nothing to await that refresh by. A test that returns on
// the terminal state can therefore race a snapshot write into this tree; retry the removal (as
// node:fs does for ENOTEMPTY) rather than fail on it.
afterEach(() => rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

it.each(['before', 'after'])(
  'does not acknowledge a %s-rename failure and resumes the same operation on retry',
  async (phase) => {
    const admin = service()
    let committedId: string | undefined
    const replace = systemNode.renameWriteThrough
    const fault = vi.spyOn(systemNode, 'renameWriteThrough').mockImplementation(async (source, target) => {
      if (basename(target) === 'operations.json') {
        if (phase === 'after') {
          await replace(source, target)
          committedId = JSON.parse(readFileSync(target, 'utf8')).operations.at(-1).operation.operationId
        }
        throw Object.assign(new Error('injected I/O failure'), { code: 'EACCES' })
      }
      return replace(source, target)
    })
    try {
      await expect(
        admin.call('_agnes/v1/packages.inspect', command('journal-retry'), authority),
      ).rejects.toMatchObject({
        data: { code: 'SEMANTIC_REJECTED', reason: 'E_PACKAGE_STATE' },
      })
    } finally {
      fault.mockRestore()
    }
    const admitted = (await admin.call(
      '_agnes/v1/packages.inspect',
      command('journal-retry'),
      authority,
    )) as {
      operationId: string
    }
    if (phase === 'after') expect(admitted.operationId).toBe(committedId)
    expect(await operation(admin, profile, admitted.operationId)).toMatchObject({ state: 'completed' })
    const restarted = service()
    const repeated = await restarted.call('_agnes/v1/packages.inspect', command('journal-retry'), authority)
    expect(repeated).toMatchObject({ operationId: admitted.operationId })
  },
)

it('installs an actual local package, returns a durable idempotent receipt, and does not invent runtime actual state', async () => {
  const admin = service()
  const inspected = (await admin.call('_agnes/v1/packages.inspect', command('inspect-a'), authority)) as {
    operationId: string
    profile: string
  }
  const preview = await operation(admin, profile, inspected.operationId)
  expect(preview.state).toBe('completed')
  expect(preview.preview?.source).toEqual(source)
  const integrity = preview.preview?.integrity
  if (!integrity) throw new Error('inspection did not return integrity')

  const installParams = { ...command('install-a'), expectedIntegrity: integrity }
  const accepted = (await admin.call('_agnes/v1/packages.install', installParams, authority)) as {
    operationId: string
    profile: string
  }
  expect(await admin.call('_agnes/v1/packages.install', installParams, authority)).toEqual(accepted)
  await expect(
    admin.call(
      '_agnes/v1/packages.install',
      { ...installParams, expectedIntegrity: `sha256-${'1'.repeat(64)}` },
      authority,
    ),
  ).rejects.toMatchObject({ data: { reason: 'PACKAGE_COMMAND_ID_CONFLICT' } })

  const installed = await operation(admin, profile, accepted.operationId)
  expect(installed).toMatchObject({
    state: 'completed',
    packageId: 'acme/pkg-a',
    cancellable: false,
    retryable: false,
    installed: { desired: 'installed-disabled', actual: 'unavailable', rollbackTarget: null },
  })
  await expect(
    admin.call(
      '_agnes/v1/packages.operation.get',
      { profile, operationId: accepted.operationId },
      { ...authority, principalId: 'unix:other-owner', clientId: 'other-client' },
    ),
  ).rejects.toMatchObject({ data: { reason: 'PACKAGE_OPERATION_UNAVAILABLE' } })
  expect(existsSync(packageDir(root, profile, 'acme/pkg-a'))).toBe(true)
  expect(await admin.call('_agnes/v1/packages.list', { profile }, authority)).toMatchObject({
    packages: [expect.objectContaining({ id: 'acme/pkg-a', actual: 'unavailable' })],
  })
  const generations = {
    generations: [],
    plugins: [
      {
        id: 'acme/pkg-a',
        state: 'draining' as const,
        boundSessions: 2,
        drainingSessions: 2,
        historicalSessions: 0,
      },
    ],
  }
  const publication = {
    operation: 'models' as const,
    ok: false,
    recovery: 'retry-same-input' as const,
    containers: [
      { compositionHash: 'reader', status: 'applied' as const },
      { compositionHash: 'writer', status: 'failed' as const, error: '/private/credential-secret' },
    ],
  }
  const migration = {
    previousGenerationId: '11111111-1111-4111-8111-111111111111',
    generationId: '22222222-2222-4222-8222-222222222222',
    changed: true,
  }
  const migrate = vi.fn(async (_profile: string, key: string, principalId: string) => {
    if (principalId !== authority.principalId) throw Object.assign(new Error('denied'), { code: -32003 })
    if (key === 'open') throw { code: 'E_COMMAND', message: 'E_GENERATION_SESSION_OPEN: private details' }
    return migration
  })
  const status = service({
    activation: {
      actual: async () => 'unavailable',
      reconcile: async () => ({ actual: 'unavailable' }),
      generations: async () => generations,
      publicationStatus: async () => ({ publication }),
      migrateSession: migrate,
    },
  })
  expect(await status.call('_agnes/v1/plugins.generations', { profile }, authority)).toEqual(generations)
  expect(await status.call('_agnes/v1/plugins.publicationStatus', { profile }, authority)).toEqual({
    publication: {
      ...publication,
      containers: [
        publication.containers[0],
        { compositionHash: 'writer', status: 'failed', error: 'Publication failed; retry the same input.' },
      ],
    },
  })
  const params = { profile, clientId, commandId: 'migrate-1', sessionId: 'closed' }
  await expect(status.call('_agnes/v1/sessions.migrate', params, authority)).resolves.toEqual(migration)
  await expect(
    status.call('_agnes/v1/sessions.migrate', params, { ...authority, permissions: ['packages.read'] }),
  ).rejects.toMatchObject({ data: { method: '_agnes/v1/sessions.migrate' } })
  await expect(
    status.call('_agnes/v1/sessions.migrate', { ...params, clientId: 'spoof' }, authority),
  ).rejects.toMatchObject({
    data: { reason: 'package command client does not match authenticated connection' },
  })
  await expect(
    status.call('_agnes/v1/sessions.migrate', { ...params, sessionId: 'open' }, authority),
  ).rejects.toMatchObject({ data: { reason: 'E_GENERATION_SESSION_OPEN' } })
  expect(migrate).toHaveBeenCalledWith(profile, 'closed', authority.principalId, undefined)

  expect(await status.call('_agnes/v1/packages.list', { profile }, authority)).toMatchObject({
    generations,
    packages: [expect.objectContaining({ draining: true, boundSessions: 2, drainingSessions: 2 })],
  })
})

it('refreshes the client-module roster after every successful package lifecycle transition', async () => {
  const events: ClientModulesChanged[] = []
  const admin = service({
    clientModules: recordingClientModules(events),
    activation: {
      actual: async () => 'not-running',
      reconcile: async () => ({ actual: 'not-running' }),
    },
  })
  const preview = await manager.inspect(profileDir, source)
  const run = async (method: Parameters<typeof admin.call>[0], params: Record<string, unknown>) => {
    const receipt = (await admin.call(method, params, authority)) as { operationId: string }
    expect(await operation(admin, profile, receipt.operationId)).toMatchObject({ state: 'completed' })
  }

  await run('_agnes/v1/packages.install', {
    ...command('notify-install'),
    expectedIntegrity: preview.integrity,
  })
  let row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('installed row is missing')
  await run('_agnes/v1/packages.trust', {
    profile,
    clientId,
    commandId: 'notify-trust',
    id: row.id,
    expectedIntegrity: row.entry.integrity,
    capabilityHash: row.capabilityHash,
  })
  await run('_agnes/v1/packages.enable', {
    profile,
    clientId,
    commandId: 'notify-enable',
    id: row.id,
  })

  const packageFile = join(root, 'candidate', 'package.json')
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as Record<string, unknown>
  writeFileSync(packageFile, JSON.stringify({ ...packageJson, version: '2.0.0' }))
  const updated = await manager.inspect(profileDir, source)
  await run('_agnes/v1/packages.update', {
    ...command('notify-update'),
    id: row.id,
    expectedIntegrity: updated.integrity,
  })
  row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('updated row is missing')
  await run('_agnes/v1/packages.disable', {
    profile,
    clientId,
    commandId: 'notify-disable',
    id: row.id,
  })
  await run('_agnes/v1/packages.remove', {
    profile,
    clientId,
    commandId: 'notify-remove',
    id: row.id,
  })

  await vi.waitFor(() =>
    expect(events.map(({ reason, packageId }) => ({ reason, packageId }))).toEqual([
      { reason: 'inventory', packageId: 'acme/pkg-a' },
      { reason: 'trust', packageId: 'acme/pkg-a' },
      { reason: 'activation', packageId: 'acme/pkg-a' },
      { reason: 'inventory', packageId: 'acme/pkg-a' },
      { reason: 'activation', packageId: 'acme/pkg-a' },
      { reason: 'inventory', packageId: 'acme/pkg-a' },
    ]),
  )
})

it('untrusts a package through the admin plane and refreshes its roster authority', async () => {
  const events: ClientModulesChanged[] = []
  const admin = service({
    clientModules: recordingClientModules(events),
    activation: {
      actual: async () => 'running',
      reconcile: async () => ({ actual: 'not-running' }),
    },
  })
  const run = async (method: Parameters<typeof admin.call>[0], params: Record<string, unknown>) => {
    console.log('DEBUG_RUN_UNTRUST', method, params)
    const receipt = (await admin.call(method, params, authority)) as { operationId: string }
    expect(await operation(admin, profile, receipt.operationId)).toMatchObject({ state: 'completed' })
  }
  const preview = await manager.inspect(profileDir, source)
  await run('_agnes/v1/packages.install', {
    ...command('untrust-install'),
    expectedIntegrity: preview.integrity,
  })
  let row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('installed row is missing')
  await run('_agnes/v1/packages.trust', {
    profile,
    clientId,
    commandId: 'untrust-trust',
    id: row.id,
    expectedIntegrity: row.entry.integrity,
    capabilityHash: row.capabilityHash,
  })
  await run('_agnes/v1/packages.enable', { profile, clientId, commandId: 'untrust-enable', id: row.id })
  row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('trusted row is missing')
  await run('_agnes/v1/packages.untrust', {
    profile,
    clientId,
    commandId: 'untrust-revoke',
    id: row.id,
    expectedIntegrity: row.entry.integrity,
    capabilityHash: row.capabilityHash,
  })

  expect((await manager.inventory(profileDir)).packages[0]).toMatchObject({ trusted: false, enabled: false })
  expect(events.at(-1)).toMatchObject({ reason: 'trust', packageId: 'acme/pkg-a' })
})

it('trusts a package without enabling or activating it', async () => {
  const reconciled: string[] = []
  const admin = service({
    activation: {
      actual: async () => 'running',
      reconcile: async (input) => {
        reconciled.push(input.operation)
        return { actual: 'running' }
      },
    },
  })
  const preview = await manager.inspect(profileDir, source)
  const install = (await admin.call(
    '_agnes/v1/packages.install',
    { ...command('trust-activates-install'), expectedIntegrity: preview.integrity },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, profile, install.operationId)).toMatchObject({ state: 'completed' })
  const row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('installed row is missing')
  expect(row.enabled).toBe(false)

  const trust = (await admin.call(
    '_agnes/v1/packages.trust',
    {
      profile,
      clientId,
      commandId: 'trust-activates-trust',
      id: row.id,
      expectedIntegrity: row.entry.integrity,
      capabilityHash: row.capabilityHash,
    },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, profile, trust.operationId)).toMatchObject({ state: 'completed' })
  expect((await manager.inventory(profileDir)).packages[0]).toMatchObject({ trusted: true, enabled: false })
  expect(reconciled).toEqual([])
})

it('keeps a manager rejection terminal after its final queued progress update', async () => {
  const initial = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: initial.integrity })
  const packageFile = join(root, 'candidate', 'package.json')
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as Record<string, unknown>
  writeFileSync(packageFile, JSON.stringify({ ...packageJson, version: '1.1.0' }))
  const preview = await manager.inspect(profileDir, source)
  const admin = service()
  const duplicate = (await admin.call(
    '_agnes/v1/packages.install',
    { ...command('duplicate-install-after-progress'), expectedIntegrity: preview.integrity },
    authority,
  )) as { operationId: string }

  expect(await operation(admin, profile, duplicate.operationId)).toMatchObject({
    state: 'failed',
    cancellable: false,
    error: { code: 'E_PACKAGE_STATE' },
  })
})

it('requires the complete dynamic authority for composite update and rollback requests', async () => {
  const admin = service()
  const activation = {
    expectedInstalledIntegrity: `sha256-${'1'.repeat(64)}`,
    expectedActiveIntegrity: null,
    trust: {
      integrity: `sha256-${'2'.repeat(64)}`,
      capabilityHash: '3'.repeat(64),
    },
  }
  await expect(
    admin.call(
      '_agnes/v1/packages.update',
      {
        ...command('composite-update'),
        id: 'acme/pkg-a',
        expectedIntegrity: activation.trust.integrity,
        activation,
        dependents: [
          { id: 'acme/dependent', source, expectedIntegrity: activation.trust.integrity, activation },
        ],
      },
      { ...authority, permissions: ['packages.install'] },
    ),
  ).rejects.toMatchObject({ code: -32006 })
  await expect(
    admin.call(
      '_agnes/v1/packages.rollback',
      {
        profile,
        clientId,
        commandId: 'composite-rollback',
        id: 'acme/pkg-a',
        expectedTargetIntegrity: activation.trust.integrity,
        activation,
      },
      { ...authority, permissions: ['packages.remove', 'packages.trust'] },
    ),
  ).rejects.toMatchObject({ code: -32006 })
})

it('fails a composite update on a stale installed baseline before changing desired state', async () => {
  const admin = service()
  const targetIntegrity = `sha256-${'2'.repeat(64)}`
  const accepted = (await admin.call(
    '_agnes/v1/packages.update',
    {
      ...command('stale-composite-update'),
      id: 'acme/pkg-a',
      expectedIntegrity: targetIntegrity,
      activation: {
        expectedInstalledIntegrity: `sha256-${'1'.repeat(64)}`,
        expectedActiveIntegrity: null,
        trust: { integrity: targetIntegrity, capabilityHash: '3'.repeat(64) },
      },
    },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, profile, accepted.operationId)).toMatchObject({
    state: 'failed',
    packageId: 'acme/pkg-a',
    retryable: true,
    error: { code: 'E_PACKAGE_PREVIEW_STALE' },
  })
  expect((await manager.inventory(profileDir)).packages).toEqual([])
})

it('fails a composite update on a stale active baseline before changing desired state', async () => {
  const first = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: first.integrity })
  const installed = (await manager.inventory(profileDir)).packages[0]
  if (!installed) throw new Error('setup install is missing')
  const packageFile = join(root, 'candidate', 'package.json')
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as Record<string, unknown>
  writeFileSync(packageFile, JSON.stringify({ ...packageJson, version: '2.0.0' }))
  const target = await manager.inspect(profileDir, source)
  const admin = service({
    activation: {
      actual: async () => 'not-running',
      reconcile: async () => ({ actual: 'not-running' }),
    },
  })
  const accepted = (await admin.call(
    '_agnes/v1/packages.update',
    {
      ...command('stale-active-update'),
      id: installed.id,
      expectedIntegrity: target.integrity,
      activation: {
        expectedInstalledIntegrity: installed.entry.integrity,
        expectedActiveIntegrity: installed.entry.integrity,
        trust: { integrity: target.integrity, capabilityHash: target.capabilityHash ?? '' },
      },
    },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, profile, accepted.operationId)).toMatchObject({
    state: 'failed',
    error: { code: 'E_PACKAGE_PREVIEW_STALE' },
  })
  expect((await manager.inventory(profileDir)).packages[0]?.entry.integrity).toBe(installed.entry.integrity)
})

it.each([false, true])(
  'fails an enable on a stale installed baseline even when the package is already enabled (enabled=%s)',
  async (alreadyEnabled) => {
    const preview = await manager.inspect(profileDir, source)
    await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
    const row = (await manager.inventory(profileDir)).packages[0]
    if (!row) throw new Error('setup install is missing')
    await manager.trust(profileDir, row.id, {
      integrity: row.entry.integrity,
      capabilityHash: row.capabilityHash,
    })
    if (alreadyEnabled) await manager.setEnabled(profileDir, row.id, true)
    const admin = service()
    const accepted = (await admin.call(
      '_agnes/v1/packages.enable',
      {
        profile,
        clientId,
        commandId: 'stale-enable',
        id: row.id,
        expectedInstalledIntegrity: `sha256-${'1'.repeat(64)}`,
      },
      authority,
    )) as { operationId: string }
    expect(await operation(admin, profile, accepted.operationId)).toMatchObject({
      state: 'failed',
      retryable: true,
      error: { code: 'E_PACKAGE_PREVIEW_STALE' },
    })
    expect((await manager.inventory(profileDir)).packages[0]?.enabled).toBe(alreadyEnabled)
  },
)

it('keeps update and rollback trust, desired state, and activation under one command identity', async () => {
  const first = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: first.integrity })
  const initial = (await manager.inventory(profileDir)).packages[0]
  if (!initial) throw new Error('setup install is missing')
  await manager.trust(profileDir, initial.id, {
    integrity: initial.entry.integrity,
    capabilityHash: initial.capabilityHash,
  })
  await manager.setEnabled(profileDir, initial.id, true)

  const packageFile = join(root, 'candidate', 'package.json')
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as Record<string, unknown>
  writeFileSync(packageFile, JSON.stringify({ ...packageJson, version: '2.0.0' }))
  const target = await manager.inspect(profileDir, source)
  let activeIntegrity: string | null = initial.entry.integrity
  const admin = service({
    activation: {
      actual: async () => ({
        actual: 'running',
        ...(activeIntegrity === null ? {} : { actualIntegrity: activeIntegrity }),
      }),
      reconcile: async () => {
        const current = (await manager.inventory(profileDir)).packages[0]
        activeIntegrity = current?.entry.integrity ?? null
        return {
          actual: current?.enabled ? 'running' : 'not-running',
          ...(current
            ? { actualVersion: current.entry.version, actualIntegrity: current.entry.integrity }
            : {}),
        }
      },
    },
  })
  const updateParams = {
    ...command('composite-lifecycle'),
    id: initial.id,
    expectedIntegrity: target.integrity,
    activation: {
      expectedInstalledIntegrity: initial.entry.integrity,
      expectedActiveIntegrity: initial.entry.integrity,
      trust: { integrity: target.integrity, capabilityHash: target.capabilityHash ?? '' },
    },
  }
  const accepted = (await admin.call('_agnes/v1/packages.update', updateParams, authority)) as {
    operationId: string
  }
  expect(await admin.call('_agnes/v1/packages.update', updateParams, authority)).toEqual(accepted)
  expect(await operation(admin, profile, accepted.operationId)).toMatchObject({
    state: 'completed',
    installed: {
      integrity: target.integrity,
      trusted: true,
      desired: 'enabled',
      actual: 'running',
      actualIntegrity: target.integrity,
    },
  })

  const rollbackParams = {
    profile,
    clientId,
    commandId: 'composite-rollback-success',
    id: initial.id,
    expectedTargetIntegrity: initial.entry.integrity,
    activation: {
      expectedInstalledIntegrity: target.integrity,
      expectedActiveIntegrity: target.integrity,
      trust: { integrity: initial.entry.integrity, capabilityHash: initial.capabilityHash },
    },
  }
  const rollback = (await admin.call('_agnes/v1/packages.rollback', rollbackParams, authority)) as {
    operationId: string
  }
  expect(await operation(admin, profile, rollback.operationId)).toMatchObject({
    state: 'completed',
    installed: {
      integrity: initial.entry.integrity,
      trusted: true,
      desired: 'enabled',
      actual: 'running',
      actualIntegrity: initial.entry.integrity,
    },
  })
})

it('namespaces equal command ids by authenticated page client and rejects changed payload per page', async () => {
  const admin = service()
  const secondClient = 'daemon-second-page'
  const secondAuthority = { ...authority, clientId: secondClient }
  const first = (await admin.call(
    '_agnes/v1/packages.inspect',
    command('shared-page-command'),
    authority,
  )) as { operationId: string }
  const second = (await admin.call(
    '_agnes/v1/packages.inspect',
    { profile, clientId: secondClient, commandId: 'shared-page-command', source },
    secondAuthority,
  )) as { operationId: string }
  expect(second.operationId).not.toBe(first.operationId)
  expect(await operation(admin, profile, first.operationId)).toMatchObject({ state: 'completed' })
  expect(await operation(admin, profile, second.operationId, secondAuthority)).toMatchObject({
    state: 'completed',
  })
  await expect(
    admin.call(
      '_agnes/v1/packages.inspect',
      {
        profile,
        clientId: secondClient,
        commandId: 'shared-page-command',
        source: parseSource('file:./different'),
      },
      secondAuthority,
    ),
  ).rejects.toMatchObject({ data: { reason: 'PACKAGE_COMMAND_ID_CONFLICT' } })
})

it('fails closed without runtime facts, preserves real blockers, and drains ordinary calls', async () => {
  const preview = await manager.inspect(profileDir, source)
  const noFactsManager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => now,
  })
  await noFactsManager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const row = (await noFactsManager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('setup install is missing')
  await noFactsManager.trust(profileDir, row.id, {
    integrity: row.entry.integrity,
    capabilityHash: row.capabilityHash,
  })
  await noFactsManager.setEnabled(profileDir, row.id, true)
  const actual = {
    actual: async () => ({ actual: 'running' as const, actualIntegrity: row.entry.integrity }),
    reconcile: async () => ({ actual: 'not-running' as const }),
  }
  const unavailable = service({ manager: noFactsManager, activation: actual })
  const refused = (await unavailable.call(
    '_agnes/v1/packages.disable',
    { profile, clientId, commandId: 'no-reference-authority', id: row.id },
    authority,
  )) as { operationId: string }
  expect(await operation(unavailable, profile, refused.operationId)).toMatchObject({
    state: 'failed',
    error: {
      code: 'E_PACKAGE_BLOCKED',
      blockers: [{ code: 'generation', references: ['reference-authority-unavailable'] }],
    },
  })

  const blockedManager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => now,
    references: createPackageReferences(async () => ({
      dependencies: [],
      profile: [],
      deployments: ['customer:surface.json'],
      runtime: [{ kind: 'drainable', reference: 'session:ordinary-call' }],
    })),
  })
  const blocked = service({ manager: blockedManager, activation: actual })
  const realBlocker = (await blocked.call(
    '_agnes/v1/packages.disable',
    { profile, clientId, commandId: 'real-reference-blocker', id: row.id },
    authority,
  )) as { operationId: string }
  expect(await operation(blocked, profile, realBlocker.operationId)).toMatchObject({
    state: 'failed',
    error: { code: 'E_PACKAGE_BLOCKED', blockers: [{ code: 'deployment' }] },
  })

  const drainableManager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => now,
    references: createPackageReferences(async () => ({
      dependencies: [],
      profile: [],
      deployments: [],
      runtime: [{ kind: 'drainable', reference: 'session:ordinary-call' }],
    })),
  })
  const drainable = service({ manager: drainableManager, activation: actual })
  const accepted = (await drainable.call(
    '_agnes/v1/packages.disable',
    { profile, clientId, commandId: 'drain-runtime-reference', id: row.id },
    authority,
  )) as { operationId: string }
  expect(await operation(drainable, profile, accepted.operationId)).toMatchObject({
    state: 'completed',
    installed: { desired: 'installed-disabled', actual: 'not-running' },
  })
})

it('removes a package that failed to start once nothing runs it, and refuses while something may', async () => {
  const preview = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('setup install is missing')
  const remove = vi.fn(manager.remove.bind(manager))
  let stopped: boolean | undefined = false
  const admin = service({
    manager: { ...manager, remove } as PackageManager,
    activation: {
      actual: async () => ({ actual: 'failed', actualReason: 'apply' }),
      ...(stopped === undefined ? {} : { stopped: async () => stopped === true }),
      reconcile: async () => ({ actual: 'failed' }),
    },
  })
  const attempt = async (commandId: string) => {
    const receipt = (await admin.call(
      '_agnes/v1/packages.remove',
      { profile, clientId, commandId, id: row.id },
      authority,
    )) as { operationId: string }
    return operation(admin, profile, receipt.operationId)
  }

  expect(await attempt('remove-failed-running')).toMatchObject({
    state: 'failed',
    error: { code: 'E_PACKAGE_STATE' },
  })
  expect(remove).not.toHaveBeenCalled()

  stopped = true
  expect(await attempt('remove-failed-stopped')).toMatchObject({ state: 'completed' })
  expect(remove).toHaveBeenCalledTimes(1)
})

it('keeps the package installed when preparing its removal fails, such as when its grants cannot be revoked', async () => {
  const preview = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('setup install is missing')
  const remove = vi.fn(manager.remove.bind(manager))
  const admin = service({
    manager: { ...manager, remove } as PackageManager,
    activation: {
      actual: async () => ({ actual: 'not-running' }),
      prepareRemoval: async () => {
        throw new Error('E_PACKAGE_STATE: managed session grants and records could not be released')
      },
      reconcile: async () => ({ actual: 'not-running' }),
    },
  })
  const receipt = (await admin.call(
    '_agnes/v1/packages.remove',
    { profile, clientId, commandId: 'remove-grants-stuck', id: row.id },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, profile, receipt.operationId)).toMatchObject({
    state: 'failed',
    error: { code: 'E_PACKAGE_STATE' },
  })
  expect(remove).not.toHaveBeenCalled()
  expect((await manager.inventory(profileDir)).packages[0]?.id).toBe(row.id)
})

it('refuses to remove a failed package when the adapter cannot say whether it is stopped', async () => {
  const preview = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('setup install is missing')
  const remove = vi.fn(manager.remove.bind(manager))
  const admin = service({
    manager: { ...manager, remove } as PackageManager,
    activation: {
      actual: async () => ({ actual: 'failed' }),
      reconcile: async () => ({ actual: 'failed' }),
    },
  })
  const receipt = (await admin.call(
    '_agnes/v1/packages.remove',
    { profile, clientId, commandId: 'remove-unknown', id: row.id },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, profile, receipt.operationId)).toMatchObject({ state: 'failed' })
  expect(remove).not.toHaveBeenCalled()
})

it.each([false, true])(
  'requires actual stopped state and cleared candidate references before remove (cleanup: %s)',
  async (cleanupPending) => {
    const preview = await manager.inspect(profileDir, source)
    await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
    const row = (await manager.inventory(profileDir)).packages[0]
    if (!row) throw new Error('setup install is missing')
    const remove = vi.fn(manager.remove.bind(manager))
    await manager.trust(profileDir, row.id, {
      integrity: row.entry.integrity,
      capabilityHash: row.capabilityHash,
    })
    await manager.setEnabled(profileDir, row.id, true)
    const running = service({
      manager: { ...manager, remove } as PackageManager,
      activation: {
        actual: async () => ({
          actual: cleanupPending ? 'not-running' : 'running',
          actualIntegrity: row.entry.integrity,
          cleanupPending,
        }),
        reconcile: async () => ({ actual: 'running' }),
      },
    })
    const unsafe = (await running.call(
      '_agnes/v1/packages.remove',
      { profile, clientId, commandId: 'remove-running', id: row.id },
      authority,
    )) as { operationId: string }
    expect(await operation(running, profile, unsafe.operationId)).toMatchObject({
      state: 'failed',
      error: {
        code: 'E_PACKAGE_STATE',
        blockers: [
          {
            code: 'generation',
            references: [row.id, cleanupPending ? 'cleanup-pending' : 'package-running'],
          },
        ],
        fixHint: expect.stringMatching(/Disable the package first/),
      },
    })
    expect(remove).not.toHaveBeenCalled()

    expect((await manager.inventory(profileDir)).packages[0]?.enabled).toBe(true)

    const candidateManager = createPackageManager({
      dataDir: root,
      cwd: root,
      agnesVersion: '0.1.0',
      now: () => now,
      references: createPackageReferences(async () => ({
        dependencies: [],
        profile: [],
        deployments: [],
        runtime: [{ kind: 'candidate', reference: 'candidate:pending' }],
      })),
    })
    const candidate = service({
      manager: candidateManager,
      activation: {
        actual: async () => 'not-running',
        reconcile: async () => ({ actual: 'not-running' }),
      },
    })
    const blocked = (await candidate.call(
      '_agnes/v1/packages.remove',
      { profile, clientId, commandId: 'remove-candidate', id: row.id },
      authority,
    )) as { operationId: string }
    expect(await operation(candidate, profile, blocked.operationId)).toMatchObject({
      state: 'failed',
      error: {
        code: 'E_PACKAGE_BLOCKED',
        blockers: [{ code: 'generation', references: ['candidate:pending'] }],
      },
    })
    expect((await candidateManager.inventory(profileDir)).packages[0]?.id).toBe(row.id)

    const residue = service({
      manager: {
        ...manager,
        remove: async () => {
          throw new PackageError('E_EXT_LOAD', 'private resource detail', {
            detail: { reason: 'residue', residue: ['private resource detail'] },
          })
        },
      },
      activation: { actual: async () => 'not-running', reconcile: async () => ({ actual: 'not-running' }) },
    })
    const retained = (await residue.call(
      '_agnes/v1/packages.remove',
      { profile, clientId, commandId: 'remove-residue', id: row.id },
      authority,
    )) as { operationId: string }
    const refusal = await operation(residue, profile, retained.operationId)
    expect(refusal).toMatchObject({
      state: 'failed',
      error: {
        code: 'E_PACKAGE_STATE',
        blockers: [{ code: 'generation', references: ['live-extension-resources'] }],
        fixHint: expect.stringMatching(/Disable the package first.*live extension resources/),
      },
    })
    expect(JSON.stringify(refusal.error)).not.toContain('private resource detail')
  },
)

it('projects only the rollback target whose retained bytes were verified by inventory', async () => {
  const first = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: first.integrity })
  const installed = (await manager.inventory(profileDir)).packages[0]
  if (!installed) throw new Error('setup install is missing')
  await manager.trust(profileDir, installed.id, {
    integrity: installed.entry.integrity,
    capabilityHash: installed.capabilityHash,
  })
  const manifestFile = join(root, 'candidate', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: '1.1.0' }))
  const second = await manager.inspect(profileDir, source)
  await manager.update(profileDir, installed.id, source, { expectedIntegrity: second.integrity })
  const verified = (await manager.inventory(profileDir)).packages[0]?.verifiedRollbackTarget
  if (!verified) throw new Error('verified rollback target is missing')

  const result = (await service().call('_agnes/v1/packages.list', { profile }, authority)) as {
    packages: Array<{ rollbackTarget?: unknown }>
  }
  expect(result.packages[0]?.rollbackTarget).toEqual({
    version: verified.version,
    integrity: verified.integrity,
    capabilityHash: verified.capabilityHash,
  })
  expect(result.packages[0]?.rollbackTarget).not.toHaveProperty('treeIntegrity')
})

it('replays a received install after a process crash without treating desired state as committed before the manager writes it', async () => {
  const preview = await manager.inspect(profileDir, source)
  const params = { ...command('crash-replay'), expectedIntegrity: preview.integrity }
  const operationId = 'pkg-crash-replay'
  const store = new FilePackageOperationStore(join(root, 'daemon', 'package-operations'))
  await store.admit({
    operation: {
      operationId,
      profile,
      operation: 'install',
      state: 'received',
      progress: 0,
      startedAt: now,
      updatedAt: now,
    },
    identity: { principalId: authority.principalId, clientId, commandId: 'crash-replay', installer: 'agent' },
    payloadHash: createHash('sha256')
      .update(
        jcs({
          method: '_agnes/v1/packages.install',
          payload: { profile, source, expectedIntegrity: preview.integrity },
        }),
        'utf8',
      )
      .digest('hex'),
    request: { kind: 'install', params },
  })

  // A daemon started for another profile of the same home shares this journal but not this scope. It
  // leaves the record queued for its owner instead of failing it on the scope refusal.
  const foreignEvents: PackageOperation[] = []
  const foreign = createPackageAdminService({
    manager,
    profileDirectory: scopedPackageProfileDirectory({
      profile: secondProfile,
      profileDir: profileDirectory(secondProfile),
      profilesRoot: join(root, 'profiles'),
    }),
    operations: new FilePackageOperationStore(join(root, 'daemon', 'package-operations')),
    clientModules: recordingClientModules([]),
    clock: () => now,
  })
  foreign.subscribe((value) => foreignEvents.push(value))
  await foreign.recover()
  for (let attempt = 0; attempt < 20 && foreignEvents.length === 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(foreignEvents).toEqual([])
  expect(
    (
      await new FilePackageOperationStore(join(root, 'daemon', 'package-operations')).get(
        profile,
        operationId,
      )
    )?.operation.state,
  ).toBe('received')

  // A new service instance is the post-crash process. The operation record was fsync-written before
  // the first process could enter PackageManager, and recovery now drives the real file install.
  const clientModuleEvents: ClientModulesChanged[] = []
  const restarted = service({
    operations: new FilePackageOperationStore(join(root, 'daemon', 'package-operations')),
    clientModules: recordingClientModules(clientModuleEvents),
  })
  expect(await operation(restarted, profile, operationId)).toMatchObject({ state: 'completed' })
  expect(existsSync(packageDir(root, profile, 'acme/pkg-a'))).toBe(true)
  expect(await manager.provenance(profileDir, 'acme/pkg-a')).toMatchObject({ installer: 'agent' })
  await expect(restarted.call('_agnes/v1/packages.install', params, authority)).rejects.toMatchObject({
    data: { reason: 'PACKAGE_COMMAND_ID_CONFLICT' },
  })
  expect(clientModuleEvents).toMatchObject([{ profile, reason: 'inventory', packageId: 'acme/pkg-a' }])
})

it('projects manager diagnostics with fixed safe text instead of package-provided messages or local paths', async () => {
  const preview = await manager.inspect(profileDir, source)
  const warningManager = {
    ...manager,
    inspect: async () => ({
      ...preview,
      warnings: [{ code: 'unlicensed' as const, safeMessage: `leaked local path: ${root}` }],
    }),
  } as PackageManager
  const warnings = service({ manager: warningManager })
  const inspected = (await warnings.call(
    '_agnes/v1/packages.inspect',
    command('safe-warning'),
    authority,
  )) as {
    operationId: string
  }
  const warningOperation = await operation(warnings, profile, inspected.operationId)
  expect(warningOperation.preview?.warnings).toEqual([
    { code: 'unlicensed', safeMessage: 'Package license information is unavailable.' },
  ])
  // The requested source location is deliberate admin review data; diagnostics cannot leak paths.
  expect(warningOperation.preview?.provenance.resolvedLocation).toBe(preview.provenance.resolvedLocation)
  const { resolvedLocation: _location, ...evidence } = warningOperation.preview!.provenance
  expect(
    JSON.stringify({ ...warningOperation, preview: { ...warningOperation.preview, provenance: evidence } }),
  ).not.toContain(root)

  const failure = new Error(`unavailable source at ${root}`)
  Object.assign(failure, { code: 'E_PACKAGE_SOURCE' })
  const failingManager = { ...manager, inspect: async () => Promise.reject(failure) } as PackageManager
  const failing = service({ manager: failingManager })
  const failedReceipt = (await failing.call(
    '_agnes/v1/packages.inspect',
    command('safe-error'),
    authority,
  )) as {
    operationId: string
  }
  const failed = await operation(failing, profile, failedReceipt.operationId)
  expect(failed).toMatchObject({
    state: 'failed',
    error: { code: 'E_PACKAGE_SOURCE', safeMessage: 'The package source could not be accepted.' },
  })
  expect(JSON.stringify(failed)).not.toContain(root)

  for (const [reason, sourceFailure] of [
    ['package-json-missing', 'manifest-missing'],
    ['package-json', 'manifest-invalid'],
    ['static-declaration-required', 'not-plugin'],
    ['git-ref', 'git-ref'],
    ['git-fetch', 'git-fetch'],
  ] as const) {
    const sourceError = new PackageError('E_DEP_MISSING', `private source at ${root}`, {
      detail: { reason },
    })
    const refused = service({
      manager: {
        ...manager,
        inspect: async () => {
          throw sourceError
        },
      },
    })
    const receipt = (await refused.call('_agnes/v1/packages.inspect', command(reason), authority)) as {
      operationId: string
    }
    const result = await operation(refused, profile, receipt.operationId)
    expect(result).toMatchObject({ state: 'failed', error: { code: 'E_PACKAGE_SOURCE', sourceFailure } })
    expect(JSON.stringify(result)).not.toContain(root)
  }

  // Profile lock contention is a retryable refusal with its own safe text, for effects and reads alike.
  const busy = () =>
    new PackageError('E_LOCK_MISMATCH', `could not acquire the package lock under ${root}`, {
      code: 'E_PACKAGE_BUSY',
      detail: { reason: 'busy', lockPath: join(profileDir, '.agnes-lock.lock') },
    })
  const contended = service({
    manager: { ...manager, install: async () => Promise.reject(busy()) } as PackageManager,
  })
  const busyReceipt = (await contended.call(
    '_agnes/v1/packages.install',
    { ...command('busy-install'), expectedIntegrity: preview.integrity },
    authority,
  )) as { operationId: string }
  const refused = await operation(contended, profile, busyReceipt.operationId)
  expect(refused).toMatchObject({
    state: 'failed',
    retryable: true,
    error: {
      code: 'E_PACKAGE_BUSY',
      safeMessage: 'Another package operation is using this profile. Try again shortly.',
    },
  })
  expect(JSON.stringify(refused)).not.toContain(root)
  const busyReads = service({
    manager: { ...manager, inventory: async () => Promise.reject(busy()) } as PackageManager,
  })
  await expect(busyReads.call('_agnes/v1/packages.list', { profile }, authority)).rejects.toMatchObject({
    data: { reason: 'E_PACKAGE_BUSY' },
  })
})

it('does not report cancellation after PackageManager committed desired state while activation aborts', async () => {
  const preview = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const before = (await manager.inventory(profileDir)).packages.find((entry) => entry.id === 'acme/pkg-a')
  if (!before) throw new Error('setup install is missing')
  await manager.trust(profileDir, 'acme/pkg-a', {
    integrity: before.entry.integrity,
    capabilityHash: before.capabilityHash,
  })

  let reconciliationStarted!: () => void
  const started = new Promise<void>((resolve) => {
    reconciliationStarted = resolve
  })
  const clientModuleEvents: ClientModulesChanged[] = []
  const admin = createPackageAdminService({
    manager,
    profileDirectory: async (requested) => {
      if (requested !== profile) throw new Error('profile scope violation')
      return profileDir
    },
    operations: new FilePackageOperationStore(join(root, 'daemon', 'package-operations')),
    activation: {
      actual: async () => 'unavailable',
      reconcile: async ({ signal }) => {
        reconciliationStarted()
        await new Promise<void>((_, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return { actual: 'unavailable' }
      },
    },
    clientModules: recordingClientModules(clientModuleEvents),
    clock: () => now,
  })
  const enabled = (await admin.call(
    '_agnes/v1/packages.enable',
    { profile, clientId, commandId: 'abort-after-commit', id: 'acme/pkg-a' },
    authority,
  )) as { operationId: string }
  await started
  await admin.call(
    '_agnes/v1/packages.operation.cancel',
    { profile, clientId, commandId: 'cancel-after-commit', operationId: enabled.operationId },
    authority,
  )
  expect(await operation(admin as ReturnType<typeof service>, profile, enabled.operationId)).toMatchObject({
    state: 'completed',
    installed: { desired: 'enabled' },
  })
  expect(
    (await manager.inventory(profileDir)).packages.find((entry) => entry.id === 'acme/pkg-a')?.enabled,
  ).toBe(true)
  expect(clientModuleEvents).toMatchObject([{ profile, reason: 'activation', packageId: 'acme/pkg-a' }])
})

it('keeps a cancellation reported before the run starts its effect, and never runs the manager call', async () => {
  const preview = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('setup install is missing')
  await manager.trust(profileDir, row.id, {
    integrity: row.entry.integrity,
    capabilityHash: row.capabilityHash,
  })
  await manager.setEnabled(profileDir, row.id, true)

  // Hold the disable inside its applied() check: the first inventory read after manager recovery.
  let reached!: () => void
  const deciding = new Promise<void>((resolve) => {
    reached = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  const effects: string[] = []
  const gated = {
    ...manager,
    inventory: async (...args: Parameters<PackageManager['inventory']>) => {
      if (!held) {
        held = true
        reached()
        await gate
      }
      return manager.inventory(...args)
    },
    setEnabled: async (...args: Parameters<PackageManager['setEnabled']>) => {
      effects.push(`setEnabled:${args[2]}`)
      return manager.setEnabled(...args)
    },
  } as PackageManager
  const admin = service({ manager: gated })
  await admin.recover()
  const disabled = (await admin.call(
    '_agnes/v1/packages.disable',
    { profile, clientId, commandId: 'cancel-while-deciding', id: row.id },
    authority,
  )) as { operationId: string }
  const states: string[] = []
  admin.subscribe((value) => {
    if (value.operationId === disabled.operationId) states.push(value.state)
  })
  await deciding
  await admin.call(
    '_agnes/v1/packages.operation.cancel',
    { profile, clientId, commandId: 'cancel-deciding', operationId: disabled.operationId },
    authority,
  )
  expect(await operation(admin, profile, disabled.operationId)).toMatchObject({ state: 'cancelled' })
  const reported = states.length
  release()

  // Effects run in order per profile: once a later inspect settles, the cancelled run has ended.
  const barrier = (await admin.call('_agnes/v1/packages.inspect', command('after-cancel'), authority)) as {
    operationId: string
  }
  expect(await operation(admin, profile, barrier.operationId)).toMatchObject({ state: 'completed' })
  expect(await operation(admin, profile, disabled.operationId)).toMatchObject({
    state: 'cancelled',
    error: { code: 'E_PACKAGE_CANCELLED' },
  })
  expect(states.slice(reported).filter((state) => state !== 'cancelled')).toEqual([])
  expect(effects).toEqual([])
  expect((await manager.inventory(profileDir)).packages[0]?.enabled).toBe(true)
})

it('keeps committed desired state and projects safe activation and unload-blocker failures', async () => {
  const preview = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const installed = (await manager.inventory(profileDir)).packages.find((entry) => entry.id === 'acme/pkg-a')
  if (!installed) throw new Error('setup install is missing')
  await manager.trust(profileDir, 'acme/pkg-a', {
    integrity: installed.entry.integrity,
    capabilityHash: installed.capabilityHash,
  })
  const clientModuleEvents: ClientModulesChanged[] = []
  const activation = createPackageAdminService({
    manager,
    profileDirectory: async () => profileDir,
    operations: new FilePackageOperationStore(join(root, 'daemon', 'package-operations')),
    activation: {
      actual: async () => 'not-running',
      reconcile: async () => ({
        actual: 'failed',
        actualVersion: installed.entry.version,
        actualIntegrity: installed.entry.integrity,
        actualReason: `raw runtime detail ${root}`,
        cleanupPending: true,
        draining: true,
        error: { code: 'E_PACKAGE_STATE', safeMessage: `raw runtime detail ${root}`, blockers: [] },
      }),
    },
    clientModules: recordingClientModules(clientModuleEvents),
    clock: () => now,
  })
  const enabled = (await activation.call(
    '_agnes/v1/packages.enable',
    { profile, clientId, commandId: 'activation-fails', id: 'acme/pkg-a' },
    authority,
  )) as { operationId: string }
  expect(
    await operation(activation as ReturnType<typeof service>, profile, enabled.operationId),
  ).toMatchObject({
    state: 'failed',
    installed: {
      desired: 'enabled',
      actual: 'failed',
      actualVersion: installed.entry.version,
      actualIntegrity: installed.entry.integrity,
      actualReason: 'Runtime activation failed.',
      cleanupPending: true,
      draining: true,
    },
    error: { code: 'E_PACKAGE_STATE', safeMessage: 'The package operation cannot run in the current state.' },
  })
  expect(
    (await manager.inventory(profileDir)).packages.find((entry) => entry.id === 'acme/pkg-a')?.enabled,
  ).toBe(true)
  expect(clientModuleEvents).toMatchObject([{ profile, reason: 'activation', packageId: 'acme/pkg-a' }])

  const blocked = Object.assign(new Error(`reference ${root}`), {
    code: 'E_PACKAGE_BLOCKED',
    detail: { blockers: [{ code: 'generation', references: [root, 'session/current'] }] },
  })
  const unload = service({
    manager: { ...manager, remove: async () => Promise.reject(blocked) } as PackageManager,
    activation: {
      actual: async () => 'not-running',
      reconcile: async () => ({ actual: 'not-running' }),
    },
  })
  const removed = (await unload.call(
    '_agnes/v1/packages.remove',
    { profile, clientId, commandId: 'unload-blocked', id: 'acme/pkg-a' },
    authority,
  )) as { operationId: string }
  expect(await operation(unload, profile, removed.operationId)).toMatchObject({
    state: 'failed',
    error: {
      code: 'E_PACKAGE_BLOCKED',
      blockers: [{ code: 'generation', references: ['redacted', 'session/current'] }],
    },
  })
})

it('contains a corrupt operation journal without an unhandled boot rejection and refuses effects deterministically', async () => {
  const operationsDir = join(root, 'daemon', 'package-operations')
  mkdirSync(operationsDir, { recursive: true })
  writeFileSync(join(operationsDir, 'operations.json'), '{ definitely-not-json')
  const corrupt = service({ operations: new FilePackageOperationStore(operationsDir) })

  expect(await corrupt.call('_agnes/v1/packages.catalog.list', { profile }, authority)).toEqual({
    items: [],
    nextCursor: null,
  })
  await expect(corrupt.call('_agnes/v1/packages.list', { profile }, authority)).rejects.toMatchObject({
    data: { reason: 'E_PACKAGE_INTEGRITY' },
  })
  await expect(
    corrupt.call('_agnes/v1/packages.inspect', command('corrupt-journal'), authority),
  ).rejects.toMatchObject({
    data: { reason: 'E_PACKAGE_INTEGRITY' },
  })
})

it('serializes effects per profile, allows another profile to proceed, and lets cancellation bypass queued work', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const starts: string[] = []
  const slowManager = {
    ...manager,
    inspect: async (...args: Parameters<PackageManager['inspect']>) => {
      starts.push(basename(args[0]))
      await gate
      return manager.inspect(...args)
    },
  } as PackageManager
  const admin = service({ manager: slowManager })

  const first = (await admin.call('_agnes/v1/packages.inspect', command('same-first'), authority)) as {
    operationId: string
  }
  await waitFor(() => starts.includes(profile))
  // Reads do not join the profile's effect tail while a write is waiting for its source.
  await expect(admin.call('_agnes/v1/packages.list', { profile }, authority)).resolves.toEqual({
    packages: [],
  })
  const queued = (await admin.call('_agnes/v1/packages.inspect', command('same-second'), authority)) as {
    operationId: string
  }
  const other = (await admin.call(
    '_agnes/v1/packages.inspect',
    command('other-profile', secondProfile),
    authority,
  )) as {
    operationId: string
  }
  await waitFor(() => starts.includes(secondProfile))
  expect(starts).toEqual(expect.arrayContaining([profile, secondProfile]))
  expect(starts).not.toContain(`${profile}:second`)

  await admin.call(
    '_agnes/v1/packages.operation.cancel',
    { profile, clientId, commandId: 'cancel-queued', operationId: queued.operationId },
    authority,
  )
  expect(await operation(admin, profile, queued.operationId)).toMatchObject({ state: 'cancelled' })
  // Cancelling an unknown operation is refused before it records anything in the journal.
  await expect(
    admin.call(
      '_agnes/v1/packages.operation.cancel',
      { profile, clientId, commandId: 'cancel-unknown', operationId: 'pkg-not-an-operation' },
      authority,
    ),
  ).rejects.toMatchObject({ data: { reason: 'PACKAGE_OPERATION_UNAVAILABLE' } })
  const journal = JSON.parse(
    readFileSync(join(root, 'daemon', 'package-operations', 'operations.json'), 'utf8'),
  )
  expect(
    journal.cancels.map((entry: { identity: { commandId: string } }) => entry.identity.commandId),
  ).toEqual(['cancel-queued'])
  release()
  expect(await operation(admin, profile, first.operationId)).toMatchObject({ state: 'completed' })
  expect(await operation(admin, secondProfile, other.operationId)).toMatchObject({ state: 'completed' })
  expect(starts).toHaveLength(2)
})

it('gives localWeb only browser rosters, enrolls client-module notices, and binds effect clientId on unix', async () => {
  const host = await openTestHost()
  try {
    const admin = service()
    const localWeb = host.endpoint({
      auth: { config: { transport: 'ws', localWeb: true }, nonces: { consume: () => true }, clock: () => 0 },
      packageAdmin: { service: admin },
    })
    localWeb.conn.initialized = true
    localWeb.conn.authKind = 'local'
    localWeb.conn.credentialKind = 'local'
    // These reads are the exact loopback Web grant, not general package administration.
    expect(
      await localWeb.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/skins.list', params: { profile } }),
    ).toMatchObject({ result: { skins: [] } })
    expect(localWeb.conn.clientModuleNotices).toBe(false)
    expect(
      await localWeb.handle({
        jsonrpc: '2.0',
        id: 11,
        method: '_agnes/v1/clientModules.uiEntries',
        params: { profile },
      }),
    ).toMatchObject({ result: { entries: [] } })
    expect(localWeb.conn.clientModuleNotices).toBe(true)
    expect(
      await localWeb.handle({
        jsonrpc: '2.0',
        id: 2,
        method: '_agnes/v1/clientModules.list',
        params: { profile },
      }),
    ).toMatchObject({ result: { modules: [], statuses: [] } })
    // Enrollment happens only after the authorized roster call succeeds, so packages_changed can
    // be broadcast to browser roster consumers without widening it to every local/JWT connection.
    expect(localWeb.conn.clientModuleNotices).toBe(true)
    // ... and nothing else in the namespace. Every one of these declares the same `packages.read`
    // permission, so only the method allowlist can tell them apart from the roster read.
    for (const [id, method, params] of [
      [
        3,
        '_agnes/v1/skins.read',
        { profile, format: 'selected-v1', path: `/skins/${'a'.repeat(64)}/x/skin.css` },
      ],
      [4, '_agnes/v1/clientModules.read', { profile, path: '/plugins/x/y/index.js', purpose: 'document' }],
      [5, '_agnes/v1/packages.list', { profile }],
      [6, '_agnes/v1/packages.catalog.list', { profile }],
      [7, '_agnes/v1/packages.pins.inspect', { profile }],
      [
        8,
        '_agnes/v1/skins.select',
        { profile, clientId, commandId: 'denied-skin', expectedRevision: 0, choice: { kind: 'none' } },
      ],
      [9, '_agnes/v1/clientModules.frontendPublication', { profile }],
      [
        10,
        '_agnes/v1/packages.docs.get',
        { profile, id: 'fixture', expectedIntegrity: `sha256-${'a'.repeat(64)}`, locale: 'en' },
      ],
    ] as const)
      expect(await localWeb.handle({ jsonrpc: '2.0', id, method, params }), method).toMatchObject({
        error: { data: { code: 'CAPABILITY_DENIED' } },
      })
    // A write whose params are exactly the declared keys, so authority is the only gate left.
    expect(
      await localWeb.handle({
        jsonrpc: '2.0',
        id: 8,
        method: '_agnes/v1/packages.disable',
        params: { profile, clientId, commandId: 'web-disable', id: 'acme/pkg-a' },
      }),
    ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    await localWeb.close()

    const remote = host.endpoint({
      auth: { config: { transport: 'ws' }, nonces: { consume: () => true }, clock: () => 0 },
      packageAdmin: { service: admin },
    })
    remote.conn.initialized = true
    remote.conn.authKind = 'jwt'
    remote.conn.credentialKind = 'jwt'
    expect(
      await remote.handle({
        jsonrpc: '2.0',
        id: 12,
        method: '_agnes/v1/clientModules.uiEntries',
        params: { profile },
      }),
    ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    expect(remote.conn.clientModuleNotices).toBe(false)
    await remote.close()

    const unix = host.endpoint({ packageAdmin: { service: admin } })
    const initialized = await unix.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        _meta: { 'ai.agnes.harness': { clientId } },
      },
    })
    expect(initialized).toMatchObject({ result: { protocolVersion: 1 } })
    expect(
      await unix.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/packages.inspect',
        params: { ...command('spoof-client'), clientId: 'another-client' },
      }),
    ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    await unix.close()
  } finally {
    await host.close()
  }
})

it('packages.pins.inspect/release dispatch to the bound runtimePins adapter', async () => {
  const orphan: RuntimePinDescriptor = {
    pinId: 'act-orphan',
    purpose: 'candidate',
    packageId: '@acme/pkg',
    version: '1.0.0',
    snapshotId: `sha256-${'c'.repeat(64)}`,
    operationId: 'op-1',
  }
  let released: string[] = []
  const runtimePins: RuntimePinsAdapter = {
    async inspect(requestedProfile) {
      expect(requestedProfile).toBe(profile)
      return { orphans: [orphan] }
    },
    async release(_requestedProfile, pinIds) {
      released = [...pinIds]
      return { results: pinIds.map((pinId) => ({ pinId, outcome: 'released' as const })) }
    },
  }
  const admin = service({ runtimePins })

  const inspectResult = (await admin.call('_agnes/v1/packages.pins.inspect', { profile }, authority)) as {
    orphans: RuntimePinDescriptor[]
  }
  expect(inspectResult.orphans).toEqual([orphan])

  const releaseResult = (await admin.call(
    '_agnes/v1/packages.pins.release',
    { profile, clientId, commandId: 'release-pins', pinIds: ['act-orphan'] },
    authority,
  )) as { results: RuntimePinReleaseResult[] }
  expect(releaseResult.results).toEqual([{ pinId: 'act-orphan', outcome: 'released' }])
  expect(released).toEqual(['act-orphan'])
})

it('rejects packages.pins.inspect/release with E_PACKAGE_STATE when no runtimePins adapter is bound', async () => {
  const admin = service()
  await expect(admin.call('_agnes/v1/packages.pins.inspect', { profile }, authority)).rejects.toMatchObject({
    data: { reason: 'E_PACKAGE_STATE' },
  })
  await expect(
    admin.call(
      '_agnes/v1/packages.pins.release',
      { profile, clientId, commandId: 'release-unbound', pinIds: ['act-orphan'] },
      authority,
    ),
  ).rejects.toMatchObject({ data: { reason: 'E_PACKAGE_STATE' } })
})

it('binds packages.pins.release clientId to the authenticated connection like other effect methods', async () => {
  const runtimePins: RuntimePinsAdapter = {
    async inspect() {
      return { orphans: [] }
    },
    async release(_requestedProfile, pinIds) {
      return { results: pinIds.map((pinId) => ({ pinId, outcome: 'released' as const })) }
    },
  }
  const admin = service({ runtimePins })
  await expect(
    admin.call(
      '_agnes/v1/packages.pins.release',
      { profile, clientId: 'another-client', commandId: 'spoof-release', pinIds: ['act-orphan'] },
      authority,
    ),
  ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
})

it('packages.trustWorkspace dispatches to the manager and returns its hash', async () => {
  const calls: Array<{ profileDir: string; deployDir: string }> = []
  const clientModuleEvents: ClientModulesChanged[] = []
  const trustWorkspace = async (profileDir: string, deployDir: string) => {
    calls.push({ profileDir, deployDir })
    return { hash: `sha256-${'f'.repeat(64)}` }
  }
  const admin = service({
    manager: { ...manager, trustWorkspace } as PackageManager,
    clientModules: recordingClientModules(clientModuleEvents),
  })

  const result = (await admin.call(
    '_agnes/v1/packages.trustWorkspace',
    { profile, clientId, commandId: 'trust-workspace-1', deployDir: '/deploy/xinwei' },
    authority,
  )) as { hash: string }

  expect(result).toEqual({ hash: `sha256-${'f'.repeat(64)}` })
  expect(calls).toEqual([{ profileDir: profileDirectory(profile), deployDir: '/deploy/xinwei' }])
  expect(clientModuleEvents).toMatchObject([{ profile, reason: 'trust' }])
})

it('binds packages.trustWorkspace clientId to the authenticated connection like other effect methods', async () => {
  const admin = service({
    manager: {
      ...manager,
      trustWorkspace: async () => ({ hash: `sha256-${'f'.repeat(64)}` }),
    } as PackageManager,
  })
  await expect(
    admin.call(
      '_agnes/v1/packages.trustWorkspace',
      {
        profile,
        clientId: 'another-client',
        commandId: 'spoof-trust-workspace',
        deployDir: '/deploy/xinwei',
      },
      authority,
    ),
  ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
})

it('surfaces a PackageAdminError the runtimePins adapter itself returns for pins.inspect/release', async () => {
  const runtimePins: RuntimePinsAdapter = {
    async inspect() {
      return { error: { code: 'E_PACKAGE_INTEGRITY', safeMessage: 'x', blockers: [] } }
    },
    async release() {
      return { error: { code: 'E_PACKAGE_SOURCE', safeMessage: 'x', blockers: [] } }
    },
  }
  const admin = service({ runtimePins })
  await expect(admin.call('_agnes/v1/packages.pins.inspect', { profile }, authority)).rejects.toMatchObject({
    data: { reason: 'E_PACKAGE_INTEGRITY' },
  })
  await expect(
    admin.call(
      '_agnes/v1/packages.pins.release',
      { profile, clientId, commandId: 'release-adapter-error', pinIds: ['act-orphan'] },
      authority,
    ),
  ).rejects.toMatchObject({ data: { reason: 'E_PACKAGE_SOURCE' } })
})

it('canonicalizes a temporary profiles root while preserving profile and symlink boundaries', async () => {
  const resolver = scopedPackageProfileDirectory({
    profile,
    profileDir,
    profilesRoot: join(root, 'profiles'),
  })
  expect(await resolver(profile)).toContain(join('profiles', profile))
  await expect(resolver(secondProfile)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
})

it('bootstraps a fresh daemon profile through PackageManager snapshotPolicy before serving real package install', async () => {
  let packageAdmin: PackageAdminService | undefined
  await runAgnesd(
    { home: root, workspace: root, dataDir: join(root, 'daemon-data'), profile },
    {
      startProduction: async (options) => {
        packageAdmin = options.packageAdmin?.service
        return {
          socketPath: join(root, 'daemon-data', 'daemon', 'test.sock'),
          owner: { pid: process.pid, generation: 1 },
          reclaimNow: async () => undefined,
          evictIdleNow: async () => undefined,
          close: async () => undefined,
        } as never
      },
      publishDiscovery: (async () => undefined) as never,
    },
  )
  if (!packageAdmin) throw new Error('PackageAdmin was not composed')
  const bootstrapped = readLock(join(root, 'profiles', profile), { profile, agnesVersion: '0.0.0' })
  expect(bootstrapped.resolvedProfileHash).toMatch(/^sha256-[a-f0-9]{64}$/)
  expect(Object.keys(bootstrapped.seams).length).toBeGreaterThan(0)

  const inspection = packageAdmin.call(
    '_agnes/v1/packages.inspect',
    command('fresh-daemon-inspect'),
    authority,
  )
  await expect(inspection).resolves.toMatchObject({ operationId: expect.any(String) })
  const inspected = (await inspection) as {
    operationId: string
  }
  const preview = await operation(packageAdmin as ReturnType<typeof service>, profile, inspected.operationId)
  if (!preview.preview?.integrity) throw new Error('fresh daemon inspection did not complete')
  const accepted = (await packageAdmin.call(
    '_agnes/v1/packages.install',
    { ...command('fresh-daemon-install'), expectedIntegrity: preview.preview.integrity },
    authority,
  )) as { operationId: string }
  expect(
    await operation(packageAdmin as ReturnType<typeof service>, profile, accepted.operationId),
  ).toMatchObject({
    state: 'completed',
  })
  expect(existsSync(packageDir(join(root, 'daemon-data'), profile, 'acme/pkg-a'))).toBe(true)
})

it('runAgnesd wires bindRuntimePins to the same deferred-proxy service it already constructed', async () => {
  // defaultPackageAdmin.service is built synchronously, before startSupervisor ever calls
  // bindRuntimePins with the real adapter (mirrors the existing bindActivation/deferredActivation
  // indirection). Drive the packageRuntime.bindRuntimePins hook directly -- as startSupervisor does
  // once runtime.initialize() resolves -- and confirm the already-constructed service now reflects
  // the bound adapter instead of staying permanently stuck on its unbound fallback (which would
  // happen if runAgnesd forgot to pass `runtimePins: deferredRuntimePins` into
  // createPackageAdminService, since object spreads capture values at construction time, not live
  // references).
  let packageAdmin: PackageAdminService | undefined
  let boundRuntimePins: ((adapter: RuntimePinsAdapter) => void) | undefined
  const orphan: RuntimePinDescriptor = {
    pinId: 'act-bound',
    purpose: 'candidate',
    packageId: '@acme/pkg',
    version: '1.0.0',
    snapshotId: `sha256-${'d'.repeat(64)}`,
    operationId: 'op-2',
  }
  await runAgnesd(
    { home: root, workspace: root, dataDir: join(root, 'bind-daemon-data'), profile },
    {
      startProduction: async (options) => {
        packageAdmin = options.packageAdmin?.service
        boundRuntimePins = options.packageRuntime?.bindRuntimePins
        return {
          socketPath: join(root, 'bind-daemon-data', 'daemon', 'test.sock'),
          owner: { pid: process.pid, generation: 1 },
          reclaimNow: async () => undefined,
          evictIdleNow: async () => undefined,
          close: async () => undefined,
        } as never
      },
      publishDiscovery: (async () => undefined) as never,
    },
  )
  if (!packageAdmin) throw new Error('PackageAdmin was not composed')
  if (!boundRuntimePins) throw new Error('packageRuntime.bindRuntimePins was not supplied')

  await expect(
    packageAdmin.call('_agnes/v1/packages.pins.inspect', { profile }, authority),
  ).rejects.toMatchObject({ data: { reason: 'E_PACKAGE_STATE' } })

  boundRuntimePins({
    async inspect() {
      return { orphans: [orphan] }
    },
    async release(_requestedProfile, pinIds) {
      return { results: pinIds.map((pinId) => ({ pinId, outcome: 'released' as const })) }
    },
  })

  expect(await packageAdmin.call('_agnes/v1/packages.pins.inspect', { profile }, authority)).toEqual({
    orphans: [orphan],
  })
})

it('preserves an existing corrupt lock and serves it as read-only recovery instead of overwriting it at boot', async () => {
  const corruptProfileDir = join(root, 'profiles', profile)
  mkdirSync(corruptProfileDir, { recursive: true })
  const lock = join(corruptProfileDir, 'agnes-lock.json')
  const corrupt = '{ damaged-lock'
  writeFileSync(lock, corrupt)
  let packageAdmin: PackageAdminService | undefined
  await runAgnesd(
    { home: root, workspace: root, dataDir: join(root, 'corrupt-daemon-data'), profile },
    {
      startProduction: async (options) => {
        packageAdmin = options.packageAdmin?.service
        return {
          socketPath: join(root, 'corrupt-daemon-data', 'daemon', 'test.sock'),
          owner: { pid: process.pid, generation: 1 },
          reclaimNow: async () => undefined,
          evictIdleNow: async () => undefined,
          close: async () => undefined,
        } as never
      },
      publishDiscovery: (async () => undefined) as never,
    },
  )
  expect(readFileSync(lock, 'utf8')).toBe(corrupt)
  if (!packageAdmin) throw new Error('PackageAdmin was not composed')
  await expect(packageAdmin.call('_agnes/v1/packages.list', { profile }, authority)).rejects.toMatchObject({
    data: { reason: 'E_PACKAGE_INTEGRITY' },
  })
})

it('reports the host default with no selected skin or persisted override', async () => {
  await expect(service().call('_agnes/v1/skins.list', { profile }, authority)).resolves.toEqual({
    profile,
    revision: 0,
    choice: { kind: 'application' },
    skins: [],
    selected: null,
  })
})

async function listSkins(admin: PackageAdminService): Promise<SkinListResult> {
  return (await admin.call('_agnes/v1/skins.list', { profile: secondProfile }, authority)) as SkinListResult
}

async function selectSkin(admin: PackageAdminService, expectedRevision: number, choice: SkinChoice) {
  return admin.call(
    '_agnes/v1/skins.select',
    {
      profile: secondProfile,
      clientId,
      commandId: `choose-${expectedRevision}`,
      expectedRevision,
      choice,
    },
    authority,
  )
}

async function readSkin(
  admin: PackageAdminService,
  path: string,
  targetProfile = secondProfile,
): Promise<SkinReadResult> {
  return (await admin.call(
    '_agnes/v1/skins.read',
    {
      profile: targetProfile,
      path,
      format: 'selected-v1',
    },
    authority,
  )) as SkinReadResult
}

function candidate(roster: SkinListResult, id: string) {
  const row = roster.skins.find((skin) => skin.id === id)
  if (!row) throw new Error(`missing ${id} skin`)
  return row
}

it('lists enabled presets as metadata and uses an adopted application skin only in automatic mode', async () => {
  const admin = await installedSkinPresets(true)
  const roster = await listSkins(admin)
  expect(roster.selected).toBeNull()
  expect(roster.skins.map((skin) => skin.id).sort()).toEqual(['aurora', 'high-contrast', 'midnight', 'paper'])
  for (const skin of roster.skins) {
    expect(skin).toEqual({
      id: skin.id,
      name: expect.any(String),
      packageId: '@agnes-examples/skins-builtin',
      version: expect.any(String),
      bindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  }

  const preview = (await admin.call(
    '_agnes/v1/applications.preview',
    {
      profile: secondProfile,
      packageId: '@agnes-examples/skins-builtin',
    },
    authority,
  )) as ApplicationPreview
  await admin.call(
    '_agnes/v1/applications.adopt',
    {
      profile: secondProfile,
      clientId,
      commandId: 'adopt-skin-app',
      packageId: preview.packageId,
      expectedRevision: 0,
      consentDigest: preview.consentDigest,
    },
    authority,
  )
  const contrast = candidate(roster, 'high-contrast')
  const contrastPath = `/skins/${contrast.bindingDigest}/high-contrast/skin.css`
  expect((await listSkins(admin)).selected).toMatchObject({
    id: 'high-contrast',
    kind: 'application',
    cssUrl: contrastPath,
    tokens: { '--agnes-bg-page': { light: '#ffffff', dark: '#000000' } },
  })
  expect(await readSkin(admin, contrastPath)).toMatchObject({ found: true })
  await selectSkin(admin, 0, { kind: 'none' })
  expect((await listSkins(admin)).selected).toBeNull()
  expect(await readSkin(admin, contrastPath)).toEqual({ found: false })
  await selectSkin(admin, 1, { kind: 'application' })
  expect((await listSkins(admin)).selected?.kind).toBe('application')
  await selectSkin(admin, 2, { kind: 'skin', bindingDigest: candidate(roster, 'aurora').bindingDigest })
  await admin.call(
    '_agnes/v1/applications.clear',
    {
      profile: secondProfile,
      clientId,
      commandId: 'clear-skin-app',
      expectedRevision: 1,
    },
    authority,
  )
  expect((await listSkins(admin)).selected).toMatchObject({ id: 'aurora', kind: 'manual' })
}, 30_000)

/** Install a real example and qualify its backend contribution in the selected profile. */
async function installedSkinPresets(withApplication = false): Promise<PackageAdminService> {
  cpSync(join(examples, 'skins-builtin', 'v1'), join(root, 'skins-builtin'), { recursive: true })
  if (withApplication) {
    const packageJson = join(root, 'skins-builtin', 'package.json')
    const manifest = JSON.parse(readFileSync(packageJson, 'utf8'))
    manifest.agnes.application = { id: 'skin-presets', presentation: { skin: 'high-contrast' } }
    writeFileSync(packageJson, JSON.stringify(manifest))
  }
  const tree = new CompositeTargetStore(sqliteTables().table('composite'), secondProfile)
  const admin = service({ pluginTree: tree, workerGeneration: () => 1 })
  const source = parseSource('file:./skins-builtin')
  const inspected = (await admin.call(
    '_agnes/v1/packages.inspect',
    { profile: secondProfile, clientId, commandId: 'read-inspect', source },
    authority,
  )) as { operationId: string }
  const preview = await operation(admin, secondProfile, inspected.operationId)
  const integrity = preview.preview?.integrity
  if (!integrity) throw new Error('inspection did not return integrity')
  const accepted = (await admin.call(
    '_agnes/v1/packages.install',
    { profile: secondProfile, clientId, commandId: 'read-install', source, expectedIntegrity: integrity },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, secondProfile, accepted.operationId)).toMatchObject({ state: 'completed' })
  const listed = (await admin.call('_agnes/v1/packages.list', { profile: secondProfile }, authority)) as {
    packages: { id: string; integrity: string; capabilityHash: string }[]
  }
  const row = listed.packages.find((entry) => entry.id === '@agnes-examples/skins-builtin')
  if (!row) throw new Error('the installed package is missing from packages.list')
  const trust = (await admin.call(
    '_agnes/v1/packages.trust',
    {
      profile: secondProfile,
      clientId,
      commandId: 'read-trust',
      id: row.id,
      expectedIntegrity: row.integrity,
      capabilityHash: row.capabilityHash,
    },
    authority,
  )) as { operationId: string }
  await operation(admin, secondProfile, trust.operationId)
  const enable = (await admin.call(
    '_agnes/v1/packages.enable',
    { profile: secondProfile, clientId, commandId: 'read-enable', id: row.id },
    authority,
  )) as { operationId: string }
  await operation(admin, secondProfile, enable.operationId)
  await qualifyInstalledSkin(tree)
  return admin
}

const skinAssetsDir = (): string =>
  join(
    packageDir(root, secondProfile, '@agnes-examples/skins-builtin'),
    'extensions/main/skins/aurora/assets',
  )

it('serves exact selected CSS and assets; stale revision, bare IDs and changed files cannot grant access', async () => {
  const admin = await installedSkinPresets()
  const roster = await listSkins(admin)
  const aurora = candidate(roster, 'aurora')
  const paper = candidate(roster, 'paper')
  const base = `/skins/${aurora.bindingDigest}/aurora/`
  const cssPath = `${base}skin.css`
  const assetPath = `${base}assets/hero.jpg`
  expect(await readSkin(admin, cssPath)).toEqual({ found: false })
  await expect(
    admin.call(
      '_agnes/v1/skins.select',
      {
        profile: secondProfile,
        clientId,
        expectedRevision: 0,
        commandId: 'bare-skin',
        choice: { kind: 'skin', id: 'aurora' },
      },
      authority,
    ),
  ).rejects.toMatchObject({ code: -32602 })
  await expect(selectSkin(admin, 0, { kind: 'skin', bindingDigest: '0'.repeat(64) })).rejects.toMatchObject({
    data: { reason: 'SKIN_CHOICE_STALE' },
  })
  await expect(
    selectSkin(admin, 0, { kind: 'skin', bindingDigest: aurora.bindingDigest }),
  ).resolves.toMatchObject({
    revision: 1,
  })
  await expect(selectSkin(admin, 0, { kind: 'none' })).rejects.toMatchObject({
    data: { reason: 'CONFIG_REVISION_CONFLICT' },
  })
  expect((await listSkins(admin)).selected).toMatchObject({
    id: 'aurora',
    kind: 'manual',
    cssUrl: cssPath,
    css: expect.stringContaining('url(\"assets/'),
  })
  const proof = vi.spyOn(packageManager, 'hashDirectoryAsync')
  try {
    const result = await readSkin(admin, cssPath)
    if (!result.found) throw new Error('selected stylesheet was not served')
    const served = Buffer.from(result.base64, 'base64')
    const relativeCss = 'extensions/main/skins/aurora/skin.css'
    expect(
      proof.mock.calls.some(([, options]) => {
        const captured = options?.verifyFiles?.get(relativeCss)
        return captured !== undefined && options?.exclude?.length === 0 && served.equals(captured)
      }),
    ).toBe(true)
  } finally {
    proof.mockRestore()
  }
  expect(await readSkin(admin, assetPath)).toEqual({
    found: true,
    base64: readFileSync(join(skinAssetsDir(), 'hero.jpg')).toString('base64'),
  })
  for (const path of [
    `/skins/${paper.bindingDigest}/paper/skin.css`,
    '/skins/aurora/skin.css',
    `${base}assets/../skin.css`,
    `${base}assets/missing.png`,
  ])
    expect(await readSkin(admin, path)).toEqual({ found: false })
  expect(await readSkin(admin, cssPath, 'other')).toEqual({ found: false })
  await expect(
    admin.call('_agnes/v1/skins.read', { profile: secondProfile, path: cssPath }, authority),
  ).rejects.toMatchObject({ code: -32602 })

  const pin = (await manager.listRuntimePins(profileDirectory(secondProfile))).find(
    ({ purpose, snapshot }) => purpose === 'active' && snapshot.packageId === aurora.packageId,
  )
  if (!pin) throw new Error('active skin pin missing')
  const file = join(pin.snapshot.directory, 'extensions/main/skins/aurora/assets/hero.jpg')
  const oldBytes = readFileSync(file)
  writeFileSync(file, Buffer.alloc(SKIN_MAX_ASSET_BYTES + 1))
  expect(await readSkin(admin, assetPath)).toEqual({ found: false })
  writeFileSync(file, oldBytes)

  const disabled = (await admin.call(
    '_agnes/v1/packages.disable',
    {
      profile: secondProfile,
      clientId,
      commandId: 'read-disable',
      id: aurora.packageId,
    },
    authority,
  )) as { operationId: string }
  await operation(admin, secondProfile, disabled.operationId)
  expect(await readSkin(admin, cssPath)).toEqual({ found: false })
  expect((await listSkins(admin)).selected).toBeNull()
}, 30_000)

it('rejects non-skin paths at the private read protocol', async () => {
  for (const path of ['/etc/passwd', 'skins/aurora/skin.css'])
    await expect(readSkin(service(), path)).rejects.toMatchObject({ code: -32602 })
})

it('refreshes discovery source bytes before an explicit local reload activation', async () => {
  const home = join(root, 'plugins'),
    workspace = join(root, 'workspace-plugins')
  mkdirSync(home)
  cpSync(join(root, 'candidate'), join(home, 'example'), { recursive: true })
  const local = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    localPlugins: { home, workspace },
    references: async () => [],
    now: () => now,
  })
  await local.refreshLocalPlugins(profileDir)
  const previous = (await local.inventory(profileDir)).packages[0]!
  writeFileSync(join(home, 'example', 'revision.txt'), 'edited bytes')
  const admin = service({
    manager: local,
    activation: {
      actual: async () => {
        const row = (await local.inventory(profileDir)).packages[0]!
        return { actual: 'running', actualIntegrity: row.entry.integrity }
      },
      reconcile: async () => {
        const row = (await local.inventory(profileDir)).packages[0]!
        return { actual: 'running', actualIntegrity: row.entry.integrity }
      },
    },
  })
  const receipt = (await admin.call(
    '_agnes/v1/packages.enable',
    {
      profile,
      id: previous.id,
      clientId,
      commandId: 'local-reload',
    },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, profile, receipt.operationId)).toMatchObject({
    state: 'completed',
    installed: { actual: 'running' },
  })
  const next = (await local.inventory(profileDir)).packages[0]!
  expect(next.entry.integrity).not.toBe(previous.entry.integrity)
  expect(next.enabled).toBe(true)
  expect(next.trusted).toBe(true)
})
