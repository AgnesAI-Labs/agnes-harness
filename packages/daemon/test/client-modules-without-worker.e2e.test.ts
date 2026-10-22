import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalJson,
  createPlatform,
  DEFAULT_COMPUTER_USE,
  hashInput,
  type ResolvedProfile,
  sha256hex,
} from '@agnes/host'
import {
  capabilityHash,
  createPackageManager,
  emptyLock,
  parseSource,
  readLock,
  writeLock,
} from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import {
  createClientModuleRegistry,
  createPackageAdminService,
  FilePackageOperationStore,
} from '../src/packages/index.js'
import { buildConfig, DEFAULT_LIMITS } from '../src/supervisor/config.js'
import { encodeFrame, JsonlDecoder } from '../src/supervisor/framing.js'
import { startProductionSupervisor } from '../src/supervisor/supervisor.js'

type Rpc = { call(id: number, method: string, params: unknown): Promise<unknown>; close(): void }

async function rpcClient(socketPath: string): Promise<Rpc> {
  const socket = connect(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const decoder = new JsonlDecoder()
  const inbox: Array<{ id?: number; result?: unknown; error?: unknown }> = []
  const waiters: Array<(frame: (typeof inbox)[number]) => void> = []
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.feed(chunk) as typeof inbox) {
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else inbox.push(frame)
    }
  })
  const next = (): Promise<(typeof inbox)[number]> =>
    inbox.length
      ? Promise.resolve(inbox.shift() as (typeof inbox)[number])
      : new Promise((resolve) => waiters.push(resolve))
  return {
    async call(id, method, params) {
      socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
      for (;;) {
        const frame = await next()
        if (frame.id !== id) continue
        if (frame.error !== undefined) throw frame.error
        return frame.result
      }
    },
    close: () => socket.end(),
  }
}

/** A real installed, trusted and enabled UI-only package with one client module. */
async function installClientPackage(dataDir: string, profileDir: string) {
  const manager = createPackageManager({
    dataDir,
    cwd: dataDir,
    agnesVersion: '0.0.0',
    references: async () => [],
  })
  mkdirSync(profileDir, { recursive: true })
  const lock = emptyLock('local-dev', '0.0.0')
  lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
  lock.seams = Object.fromEntries(
    ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((n) => [
      n,
      { provider: 'local' },
    ]),
  )
  lock.policySnapshot.capabilityCeiling = ['ui']
  writeLock(profileDir, lock)
  const id = '@fixture/panel'
  const dir = join(dataDir, 'source-panel')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            id: 'ext:fixture/panel',
            export: 'plugin',
            apiRange: '^5.0.0',
            runtime: 'in-process',
            capabilities: { ui: true },
          },
        ],
        clientDescriptors: [{ rowId: 'ext:fixture/panel', path: './agnes.client.json' }],
      },
    }),
  )
  writeFileSync(join(dir, 'index.mjs'), 'export const plugin = { apply() {} }\n')
  writeFileSync(join(dir, 'client.js'), 'export default { apply() {} }\n')
  writeFileSync(
    join(dir, 'agnes.client.json'),
    JSON.stringify({ client: { entry: './client.js', slots: ['workbench.panel'], services: [] } }),
  )
  const source = parseSource('file:./source-panel')
  const preview = await manager.inspect(profileDir, source)
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  const entry = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[id]!
  await manager.trust(profileDir, id, { integrity: entry.integrity, capabilityHash: capabilityHash(entry) })
  await manager.enable(profileDir, id, true)
  return { manager, id }
}

it('answers the roster and the application state while no worker has booted, even while the package lock is held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-modules-no-worker-'))
  // The daemon starts its shared worker at boot. This entry never says hello, so no worker ever
  // reports a loaded tree: every answer below must come from the daemon alone.
  const workerEntry = join(dir, 'worker.mjs')
  writeFileSync(workerEntry, 'setInterval(() => {}, 1 << 30)\n')
  const body = {
    name: 'local-dev',
    dataDir: dir,
    transports: [],
    approvals: { mode: 'manual' },
    computerUse: DEFAULT_COMPUTER_USE,
    presets: { default: 'standard', allowed: ['standard'] },
  } as unknown as Omit<ResolvedProfile, 'hash'>
  const profile = { ...body, hash: `sha256-${sha256hex(canonicalJson(hashInput(body)))}` } as ResolvedProfile
  const profileDir = join(dir, 'profiles', 'local-dev')
  const { manager, id } = await installClientPackage(dir, profileDir)
  // The daemon's own desired tree names the package's browser row and its backend row.
  const revision = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[id]!
    .integrity
  const row = (rowId: string, plugin: string, mountRevision: string) =>
    createPluginRow({
      id: rowId,
      plugin: `${id}@${revision}/${plugin}`,
      snapshotDigest: revision,
      exportName: plugin,
      entryRevision: revision,
      extrasRevision: 'none',
      mountRevision,
      runtime: 'in-process',
    })
  const desired = encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        row(`web:${id}`, 'client', 'host-web-row:v1'),
        row('ext:fixture/panel', 'plugin', 'host-ordinary-row:v1'),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: 'a'.repeat(64),
      compositeRevision: 'b'.repeat(64),
    }),
  )
  const service = createPackageAdminService({
    manager,
    profileDirectory: async () => profileDir,
    operations: new FilePackageOperationStore(join(dir, 'operations')),
    clientModules: createClientModuleRegistry({
      snapshotDirectory: (name) => join(dir, 'client-modules', name),
      runtimeArtifacts: () => ({ desired, lastGood: desired }),
    }),
  })
  const profileFile = join(dir, 'profile.json')
  writeFileSync(profileFile, JSON.stringify(profile))
  const supervisor = await startProductionSupervisor({
    config: {
      ...buildConfig({
        args: { profile: 'local-dev' },
        profile,
        home: dir,
        ipc: createPlatform().snapshot().os === 'win32' ? 'pipe' : 'unix',
      }),
      limits: { ...DEFAULT_LIMITS, jobsTickMs: 60_000 },
    },
    profile,
    profileDir,
    profileFile,
    workerEntry,
    packageAdmin: { service },
    processIdentity: async (pid) =>
      pid === process.pid ? { state: 'alive', startId: 'client-modules-test' } : { state: 'dead' },
  })
  const rpc = await rpcClient(supervisor.socketPath)
  const within = async <T>(label: string, work: Promise<T>): Promise<T> =>
    Promise.race([
      work,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} waited`)), 4000)),
    ])
  try {
    await rpc.call(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    const roster = (await within(
      'list',
      rpc.call(2, '_agnes/v1/clientModules.list', { profile: 'local-dev' }),
    )) as { rows: Array<{ packageId: string; phase: string }> }
    expect(roster.rows.map((row) => [row.packageId, row.phase])).toEqual([[id, 'ready']])
    expect(
      await within('get', rpc.call(3, '_agnes/v1/applications.get', { profile: 'local-dev' })),
    ).toMatchObject({
      status: 'host',
    })
    // Another package operation holds the package lock: display reads do not queue behind it.
    writeFileSync(join(profileDir, '.agnes-lock.lock'), String(process.pid))
    try {
      expect(
        await within(
          'list under lock',
          rpc.call(4, '_agnes/v1/clientModules.list', { profile: 'local-dev' }),
        ),
      ).toMatchObject({ rows: roster.rows })
      expect(
        await within('get under lock', rpc.call(5, '_agnes/v1/applications.get', { profile: 'local-dev' })),
      ).toMatchObject({ status: 'host' })
    } finally {
      rmSync(join(profileDir, '.agnes-lock.lock'), { force: true })
    }
  } finally {
    rpc.close()
    await supervisor.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 90_000)
