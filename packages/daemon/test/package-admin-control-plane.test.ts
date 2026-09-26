import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activeRuntimePinId,
  createPackageManager,
  emptyLock,
  type PackageManager,
  packageDir,
  parseSource,
  readLock,
  SKIN_MAX_ASSET_BYTES,
  writeLock,
} from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import {
  jcs,
  type PackageOperation,
  type RuntimePinDescriptor,
  type RuntimePinReleaseResult,
} from '@agnes/protocol'
import * as systemNode from '@agnes/system-node'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
import { openTestHost } from './host.js'
import { sqliteTables } from './sqlite-tables.js'

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
const seams = [
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
]

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
    seams: Object.fromEntries(seams.map((seam) => [seam, '@agnes/base'])),
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
  const target = encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id: rowId,
          plugin: `${row.id}@${integrity}/main`,
          snapshotDigest: integrity,
          exportName: 'main',
          entryRevision: integrity,
          extrasRevision: 'none',
          mountRevision: 'skin-test:v1',
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: 'a'.repeat(64),
      compositeRevision: 'b'.repeat(64),
    }),
  )
  tree.publishDesired(target)
  if (
    !tree.qualifyConverged(1, target, {
      hash: target.identity.treeHash,
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

  expect(events.map(({ reason, packageId }) => ({ reason, packageId }))).toEqual([
    { reason: 'inventory', packageId: 'acme/pkg-a' },
    { reason: 'trust', packageId: 'acme/pkg-a' },
    { reason: 'activation', packageId: 'acme/pkg-a' },
    { reason: 'inventory', packageId: 'acme/pkg-a' },
    { reason: 'activation', packageId: 'acme/pkg-a' },
    { reason: 'inventory', packageId: 'acme/pkg-a' },
  ])
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

it('requires actual stopped state and cleared candidate references before remove', async () => {
  const preview = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const row = (await manager.inventory(profileDir)).packages[0]
  if (!row) throw new Error('setup install is missing')
  const remove = vi.fn(manager.remove.bind(manager))
  const running = service({
    manager: { ...manager, remove } as PackageManager,
    activation: {
      actual: async () => ({ actual: 'running', actualIntegrity: row.entry.integrity }),
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
    error: { code: 'E_PACKAGE_STATE' },
  })
  expect(remove).not.toHaveBeenCalled()

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
})

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
    identity: { principalId: authority.principalId, clientId, commandId: 'crash-replay' },
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

  // A new service instance is the post-crash process. The operation record was fsync-written before
  // the first process could enter PackageManager, and recovery now drives the real file install.
  const clientModuleEvents: ClientModulesChanged[] = []
  const restarted = service({
    operations: new FilePackageOperationStore(join(root, 'daemon', 'package-operations')),
    clientModules: recordingClientModules(clientModuleEvents),
  })
  expect(await operation(restarted, profile, operationId)).toMatchObject({ state: 'completed' })
  expect(existsSync(packageDir(root, profile, 'acme/pkg-a'))).toBe(true)
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
  expect(JSON.stringify(warningOperation)).not.toContain(root)

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
    // The workbench needs the roster to render its skin picker, and the loopback Web credential is
    // the only one it has. It is granted that single read (design §23.3) ...
    expect(
      await localWeb.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/skins.list', params: { profile } }),
    ).toMatchObject({ result: { skins: [] } })
    expect(localWeb.conn.clientModuleNotices).toBe(false)
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
      [3, '_agnes/v1/skins.read', { profile, path: '/skins/x/skin.css' }],
      [4, '_agnes/v1/clientModules.read', { profile, path: '/plugins/x/y/index.js' }],
      [5, '_agnes/v1/packages.list', { profile }],
      [6, '_agnes/v1/packages.catalog.list', { profile }],
      [7, '_agnes/v1/packages.pins.inspect', { profile }],
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

// skins.list is registered automatically from PACKAGE_ADMIN_METHODS, so this pins the half that is
// hand-written: the dispatch branch and its projection. The roster's own rules (enabled/trusted
// filter, cross-package id uniqueness, shadowing) are pinned in package-manager's suite.
it('projects a skin roster for the profile, hashed so a client can detect change', async () => {
  const result = (await service().call('_agnes/v1/skins.list', { profile }, authority)) as {
    revision: string
    skins: unknown[]
    shadowed: string[]
  }
  expect(result.skins).toEqual([])
  expect(result.shadowed).toEqual([])
  expect(result.revision).toMatch(/^sha256-[a-f0-9]{64}$/)
  // Content-derived, so two reads of an unchanged profile agree; a client re-applies only on change.
  const again = (await service().call('_agnes/v1/skins.list', { profile }, authority)) as {
    revision: string
  }
  expect(again.revision).toBe(result.revision)
})

// S18/S19: the whole pipeline against a real install rather than a hand-built inventory. The
// package comes from the shipped example family, so this also pins that the examples on disk still
// satisfy the install-time limits (stylesheet cap, asset extension allowlist, asset byte caps).
it('installs the shipped skin example and projects all four presets with their inline stylesheets', async () => {
  // A `file:` source must be a contained `./` path resolved against the manager's cwd, so the example
  // is copied in rather than referenced where it lives. That is the same shape a user's install takes.
  cpSync(join(examples, 'skins-builtin', 'v1'), join(root, 'skins-builtin'), { recursive: true })
  const skinSource = parseSource('file:./skins-builtin')
  const tree = new CompositeTargetStore(sqliteTables().table('composite'), secondProfile)
  const admin = service({ pluginTree: tree, workerGeneration: () => 1 })

  const inspected = (await admin.call(
    '_agnes/v1/packages.inspect',
    { profile: secondProfile, clientId, commandId: 'skin-inspect', source: skinSource },
    authority,
  )) as { operationId: string }
  const preview = await operation(admin, secondProfile, inspected.operationId)
  expect(preview.state).toBe('completed')
  expect(preview.preview?.source).toEqual(skinSource)
  const integrity = preview.preview?.integrity
  if (!integrity) throw new Error('inspection did not return integrity')

  const accepted = (await admin.call(
    '_agnes/v1/packages.install',
    {
      profile: secondProfile,
      clientId,
      commandId: 'skin-install',
      source: skinSource,
      expectedIntegrity: integrity,
    },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, secondProfile, accepted.operationId)).toMatchObject({
    state: 'completed',
    packageId: '@agnes-examples/skins-builtin',
    installed: { desired: 'installed-disabled' },
  })

  // An install lands disabled and untrusted, and the roster only projects enabled, trusted packages,
  // so the presets must stay invisible until both steps run.
  await expect(
    admin.call('_agnes/v1/skins.list', { profile: secondProfile }, authority),
  ).resolves.toMatchObject({ skins: [] })

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
      commandId: 'skin-trust',
      id: row.id,
      expectedIntegrity: row.integrity,
      capabilityHash: row.capabilityHash,
    },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, secondProfile, trust.operationId)).toMatchObject({ state: 'completed' })

  const enable = (await admin.call(
    '_agnes/v1/packages.enable',
    { profile: secondProfile, clientId, commandId: 'skin-enable', id: row.id },
    authority,
  )) as { operationId: string }
  expect(await operation(admin, secondProfile, enable.operationId)).toMatchObject({ state: 'completed' })
  await qualifyInstalledSkin(tree)

  const roster = (await admin.call('_agnes/v1/skins.list', { profile: secondProfile }, authority)) as {
    revision: string
    skins: {
      id: string
      name: string
      packageName: string
      cssUrl: string
      css?: string
      assetBase?: string
      tokens?: Record<string, { light: string; dark: string }>
    }[]
    shadowed: string[]
  }
  expect(roster.shadowed).toEqual([])
  expect(roster.revision).toMatch(/^sha256-[a-f0-9]{64}$/)
  // Declaration order inside the package, not a re-sort: the manifest stays the rendering order.
  expect(roster.skins.map((skin) => skin.id)).toEqual(['high-contrast', 'midnight', 'paper', 'aurora'])
  for (const skin of roster.skins) {
    expect(skin.packageName).toBe('@agnes-examples/skins-builtin')
    expect(skin.cssUrl).toBe(`/skins/${skin.id}/skin.css`)
    // The stylesheet is inlined so a skin that ships no assets needs no second request. A packaged
    // distribution reads it from `embeddedSkins`; a source checkout reads the file, as here.
    expect(skin.css).toContain('[data-agnes-region')
  }
  // Only aurora ships an `assets/` directory, and it is the one preset a background image needs.
  expect(roster.skins.filter((skin) => skin.assetBase !== undefined).map((skin) => skin.id)).toEqual([
    'aurora',
  ])
  expect(roster.skins.find((skin) => skin.id === 'aurora')?.assetBase).toBe('/skins/aurora/assets/')
  // The inlined text is projected, not raw: the client applies it with `replaceSync`, whose base URL
  // is the document, so a relative `url()` would resolve against the page root and 404 (design §21).
  const auroraCss = roster.skins.find((skin) => skin.id === 'aurora')?.css ?? ''
  expect(auroraCss).toMatch(/url\("\/skins\/aurora\/assets\/[a-z0-9._-]+"\)/)
  expect(auroraCss).not.toContain('url("assets/')
  // The file on disk keeps the author's relative reference — only the projection is rewritten.
  const auroraOnDisk = readFileSync(
    join(
      packageDir(root, secondProfile, '@agnes-examples/skins-builtin'),
      'extensions/main/skins/aurora/skin.css',
    ),
    'utf8',
  )
  expect(auroraOnDisk).toMatch(/url\("assets\/[a-z0-9._-]+"\)/)
  // `cssUrl` and the rewrite must agree on the route, or the two application paths would diverge.
  expect(roster.skins.find((skin) => skin.id === 'aurora')?.cssUrl).toBe('/skins/aurora/skin.css')
  // Tokens ride the same manifest, and the picker needs them for the pre-paint token pass.
  expect(roster.skins.find((skin) => skin.id === 'high-contrast')?.tokens).toMatchObject({
    '--agnes-bg-page': { light: '#ffffff', dark: '#000000' },
  })
  // A skin that declares no tokens still projects `css`; `tokens` is omitted rather than empty.
  expect(roster.skins.find((skin) => skin.id === 'aurora')?.tokens).toBeUndefined()

  // The revision is content-derived, so an unchanged roster is stable across reads.
  const repeated = (await admin.call('_agnes/v1/skins.list', { profile: secondProfile }, authority)) as {
    revision: string
  }
  expect(repeated.revision).toBe(roster.revision)
}, 30_000)

/**
 * Bring the shipped skin example to the state `skins.read` answers for: installed, trusted and
 * enabled on `secondProfile` (the only non-primary profile scope the service resolves).
 */
async function installedSkinPresets(): Promise<ReturnType<typeof service>> {
  cpSync(join(examples, 'skins-builtin', 'v1'), join(root, 'skins-builtin'), { recursive: true })
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

it('hands out one file as bytes, and only for the enabled, trusted roster', async () => {
  const admin = await installedSkinPresets()
  const read = async (path: string) =>
    (await admin.call('_agnes/v1/skins.read', { profile: secondProfile, path }, authority)) as {
      found: boolean
      base64?: string
    }

  // The stylesheet and the asset both come back, and the asset is byte-identical to what is
  // installed — no re-encoding beyond the base64 transport itself.
  const css = await read('/skins/aurora/skin.css')
  expect(css.found).toBe(true)
  expect(Buffer.from(css.base64 ?? '', 'base64').toString('utf8')).toContain('[data-agnes-region="app"]')
  const png = await read('/skins/aurora/assets/hero.jpg')
  const onDisk = readFileSync(join(skinAssetsDir(), 'hero.jpg'))
  expect(Buffer.from(png.base64 ?? '', 'base64').equals(onDisk)).toBe(true)

  // Every negative answer is the same answer: a miss, a skin with no assets, an unknown id, a
  // traversal attempt and a missing file are indistinguishable to the caller (design §22.3).
  for (const path of [
    '/skins/paper/assets/aurora.png',
    '/skins/nope/skin.css',
    '/skins/aurora/assets/../skin.css',
    '/skins/aurora/assets/missing.png',
  ])
    expect(await read(path), path).toEqual({ found: false })

  // Disabling the package revokes the bytes too: the roster is the whole authority.
  await expect(
    admin.call('_agnes/v1/skins.read', { profile: secondProfile, path: '/skins/aurora/skin.css' }, authority),
  ).resolves.toMatchObject({ found: true })
  const disabled = (await admin.call(
    '_agnes/v1/packages.disable',
    { profile: secondProfile, clientId, commandId: 'read-disable', id: '@agnes-examples/skins-builtin' },
    authority,
  )) as { operationId: string }
  await operation(admin, secondProfile, disabled.operationId)
  expect(await read('/skins/aurora/skin.css')).toEqual({ found: false })
}, 30_000)

it('rejects a path that is not a skin route before dispatch', async () => {
  const admin = await installedSkinPresets()
  // The parameter schema owns this boundary: the handler never sees a filesystem path.
  await expect(
    admin.call('_agnes/v1/skins.read', { profile: secondProfile, path: '/etc/passwd' }, authority),
  ).rejects.toMatchObject({ code: -32602 })
  await expect(
    admin.call('_agnes/v1/skins.read', { profile: secondProfile, path: 'skins/aurora/skin.css' }, authority),
  ).rejects.toMatchObject({ code: -32602 })
})

it('refuses an out-of-scope profile instead of reading another scope', async () => {
  const admin = await installedSkinPresets()
  await expect(
    admin.call('_agnes/v1/skins.read', { profile: 'other', path: '/skins/aurora/skin.css' }, authority),
  ).rejects.toMatchObject({ data: { code: 'SEMANTIC_REJECTED' } })
})

it('fails the whole read closed when an installed file was swapped after install', async () => {
  const admin = await installedSkinPresets()
  // The read channel's own size cap is defence in depth; the primary control turned out to be
  // stronger and is what this pins: `inventory()` re-verifies the installed tree against the lock, so
  // a file grown (or replaced) on disk refuses the read outright instead of streaming past the cap.
  writeFileSync(join(skinAssetsDir(), 'aurora.png'), Buffer.alloc(SKIN_MAX_ASSET_BYTES + 1))
  await expect(
    admin.call(
      '_agnes/v1/skins.read',
      { profile: secondProfile, path: '/skins/aurora/assets/aurora.png' },
      authority,
    ),
  ).rejects.toMatchObject({ data: { reason: 'E_PACKAGE_INTEGRITY' } })
})
