import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeRuntimePinId,
  createPackageManager,
  emptyLock,
  PackageByteVerification,
  parseSource,
  writeLock,
} from '../../packages/package-manager/src/index.js'
import type { dataset } from './metrics.js'

/** Uses install/trust/pin, never hand-constructed snapshot authority or the user's home. */
export async function createFixture(size: Pick<typeof dataset, 'packages' | 'files' | 'bytesPerFile'>) {
  const home = mkdtempSync(join(tmpdir(), 'agh-package-load-'))
  const profileDir = join(home, 'profiles', 'local-dev')
  const verification = new PackageByteVerification({ profileDir, roots: [home] })
  const reader = () =>
    createPackageManager({
      byteVerification: verification,
      dataDir: home,
      cwd: home,
      agnesVersion: '0.1.0',
      references: async () => [],
    })
  const close = async () => {
    await verification.close()
    rmSync(home, { recursive: true, force: true })
  }
  try {
    mkdirSync(profileDir, { recursive: true })
    writeLock(profileDir, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
          name,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: { capabilityCeiling: ['ui'], workspacePackages: 'require-project-trust' },
    })
    const manager = reader()
    for (let index = 0; index < size.packages; index++) {
      const id = `@synthetic/load-${index}`
      const dir = join(home, 'sources', String(index))
      mkdirSync(join(dir, 'lib'), { recursive: true })
      mkdirSync(join(dir, 'client'))
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: id,
          version: '1.0.0',
          license: 'MIT',
          exports: './index.mjs',
          agnes: {
            plugins: [{ export: 'main', apiRange: '^4.0.0', capabilities: { ui: true } }],
            clientDescriptors: [{ rowId: `ext:${id}/main`, path: './client/agnes.client.json' }],
          },
        }),
      )
      writeFileSync(join(dir, 'index.mjs'), 'export const main = () => {}\n')
      writeFileSync(join(dir, 'client/index.js'), 'export const main = () => {}\n'.padEnd(32 * 1024))
      writeFileSync(join(dir, 'client/index.css'), '.load { color: blue }\n'.padEnd(32 * 1024))
      writeFileSync(
        join(dir, 'client/agnes.client.json'),
        JSON.stringify({
          client: { entry: './index.js', styles: ['./index.css'], services: [], projections: [] },
        }),
      )
      for (let file = 0; file < size.files; file++)
        writeFileSync(join(dir, 'lib', `${file}.txt`), Buffer.alloc(size.bytesPerFile, 97))
      const source = parseSource(`file:./sources/${index}`)
      const preview = await manager.inspect(profileDir, source)
      await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
      const row = (await manager.inventory(profileDir)).packages.find((pkg) => pkg.id === id)
      if (!row?.entry.treeIntegrity) throw new Error('synthetic installation failed')
      await manager.trust(profileDir, id, {
        integrity: row.entry.integrity,
        capabilityHash: row.capabilityHash,
      })
      const pinId = activeRuntimePinId({ packageId: id, integrity: row.entry.integrity })
      await manager.pinRuntimeSnapshot(profileDir, {
        pinId,
        operationId: pinId,
        packageId: id,
        purpose: 'active',
        selector: {
          kind: 'installed',
          expectedIntegrity: row.entry.integrity,
          expectedTreeIntegrity: row.entry.treeIntegrity,
        },
      })
    }
    return { home, profileDir, reader, close, verification }
  } catch (error) {
    await close()
    throw error
  }
}
