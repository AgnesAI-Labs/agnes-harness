import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSqliteStorage,
  type RuntimeProfileManifest,
  readLock,
  dataDir as resolveDataDir,
  writeLock,
} from '@agnes/host'
import { createPackageManager, parseSource } from '@agnes/package-manager'
import { parse, stringify } from 'yaml'
import { rebuildDesiredFromInventory } from '../../daemon/src/composite-desired.js'
import { CompositeTargetStore } from '../../daemon/src/storage/composite-target-store.js'

/**
 * Installs a test-owned preset package and publishes its desired runtime target before boot.
 * This is package fixture trust only: managed MCP still requires the public create/trust/enable flow.
 * Call before starting the isolated daemon. The caller owns daemon shutdown and directory removal.
 */
export async function setupMcpLegacySentinel(input: { home: string; workspace: string; nodePath: string }) {
  const profile = 'local-dev'
  const id = '@test/legacy-preset'
  const preset = 'mcp-sentinel'
  const profileDir = join(input.home, 'profiles', profile)
  const profilePath = join(profileDir, 'profile.yaml')
  const packageDirectory = join(input.workspace, 'legacy-preset')
  const startsPath = join(input.workspace, 'legacy-starts.jsonl')
  const scriptPath = join(packageDirectory, 'legacy-sentinel.mjs')
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 })
  await writeFile(
    scriptPath,
    `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(startsPath)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid }) + '\\n')\n`,
  )
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: id,
      version: '0.0.1',
      type: 'module',
      license: 'MIT',
      exports: './index.js',
      agnes: { plugins: [{ id: 'ext:test/legacy-preset', export: 'default' }] },
    }),
  )
  await writeFile(
    join(packageDirectory, 'index.js'),
    `export const presets = ${JSON.stringify({
      [preset]: {
        name: preset,
        extends: 'standard',
        mcp: {
          defer: true,
          servers: [{ id: 'legacy', transport: 'stdio', cmd: [input.nodePath, scriptPath] }],
        },
      },
    })}\nexport default function legacyPresetFixture() {}\n`,
  )

  // Preserve the existing local-dev overlay; only append our test package and select its preset.
  const existing = await readFile(profilePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  const overlay = (existing ? parse(existing) : { name: profile }) as RuntimeProfileManifest
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay))
    throw new Error('legacy fixture requires a profile mapping')
  const packages = overlay.packages ?? []
  if (packages.some((entry) => entry.id === id)) throw new Error('legacy fixture already installed')
  await writeFile(
    profilePath,
    stringify({
      ...overlay,
      packages: [...packages, { id, source: 'file:./legacy-preset' }],
      presets: {
        ...overlay.presets,
        default: preset,
        allowed: [
          ...new Set([
            ...(overlay.presets?.allowed ?? ['standard', 'claw', 'channel', 'minimal-rl']),
            preset,
          ]),
        ],
      },
    }),
  )
  const lock = readLock(profileDir, { profile, agnesVersion: '0.0.0' })
  const timestamp = new Date().toISOString()
  writeLock(profileDir, {
    ...lock,
    resolvedProfileHash: lock.resolvedProfileHash ?? `sha256-${'0'.repeat(64)}`,
    generatedAt: timestamp,
    seams: Object.keys(lock.seams).length
      ? lock.seams
      : {
          approval: '@agnes/base',
          checkpoint: '@agnes/base',
          ledger: '@agnes/base',
          sandbox: '@agnes/base',
          verifier: '@agnes/base',
          repair: '@agnes/base',
          artifacts: '@agnes/base',
          principals: '@agnes/base',
          platform: '@agnes/host',
          harness: '@agnes/base',
        },
    policySnapshot: lock.policySnapshot.capabilityCeiling.length
      ? lock.policySnapshot
      : {
          capabilityCeiling: [
            'tools',
            'hooks',
            'slots',
            'events',
            'resources',
            'network',
            'tools.invoke',
            'artifacts',
            'subagent',
          ],
          workspacePackages: 'require-project-trust',
        },
  })
  // Install the fixture through the same verified inventory used by production. The legacy
  // behavior under test is the preset MCP entry, not an obsolete package manifest or forged lock.
  const dataDir = resolveDataDir(input.home)
  const manager = createPackageManager({ dataDir, cwd: input.workspace, agnesVersion: '0.0.0' })
  const source = parseSource('file:./legacy-preset')
  const preview = await manager.inspect(profileDir, source)
  if (preview.blockers.length || !preview.capabilityHash) throw new Error('Invalid legacy preset fixture')
  await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  await manager.trust(profileDir, id, {
    integrity: preview.integrity,
    capabilityHash: preview.capabilityHash,
  })
  await manager.setEnabled(profileDir, id, true, { expectedInstalledIntegrity: preview.integrity })
  const storage = createSqliteStorage({
    file: join(dataDir, 'sessions.db'),
    tablesDir: join(dataDir, 'tables'),
  })
  try {
    const table = storage.tables('@agnes/daemon').table('composite_runtime')
    const tree = new CompositeTargetStore(
      {
        exec: (sql, params = []) => {
          if (params.length) table.run(sql, params)
          else table.exec(sql)
        },
        get: (sql, params = []) => table.get(sql, params),
        all: (sql, params = []) => table.all(sql, params),
        transaction: (fn) => table.transaction(fn),
      },
      profile,
    )
    const target = rebuildDesiredFromInventory({
      previous: undefined,
      inventory: await manager.inventory(profileDir),
      packageId: id,
      operation: 'enable',
    })
    if (!target) throw new Error('Missing legacy preset fixture target')
    tree.publishDesired(target)
  } finally {
    await storage.close()
  }
  return { preset, startsPath, scriptPath, packageDirectory }
}
