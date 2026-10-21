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
} from '@agnes/package-manager'

/** A real installed/trusted/pinned plugin; no hand-built boot authority. */
export async function createWorkerByteFixture() {
  const home = mkdtempSync(join(tmpdir(), 'agh-worker-bytes-')),
    profileDir = join(home, 'profiles/local-dev')
  mkdirSync(profileDir, { recursive: true })
  const lock = emptyLock('local-dev', '0.0.0')
  lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
  lock.seams = Object.fromEntries(
    ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
      name,
      { provider: 'local' },
    ]),
  )
  writeLock(profileDir, lock)
  const verification = new PackageByteVerification({ profileDir, roots: [home] })
  const reader = () =>
    createPackageManager({
      dataDir: home,
      cwd: home,
      agnesVersion: '0.0.0',
      references: async () => [],
      byteVerification: verification,
    })
  const close = async () => {
    await verification.close()
    rmSync(home, { recursive: true, force: true })
  }
  try {
    const dir = join(home, 'source')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@synthetic/load-0',
        version: '1.0.0',
        license: 'MIT',
        exports: './index.mjs',
        agnes: { plugins: [{ export: 'main', default: true, apiRange: '^4.0.0' }] },
      }),
    )
    writeFileSync(
      join(dir, 'index.mjs'),
      `import {appendFileSync} from 'node:fs'; if(process.env.AGH_VERIFICATION_TRACE) appendFileSync(process.env.AGH_VERIFICATION_TRACE, JSON.stringify({phase:'plugin-import',pid:process.pid})+'\\n'); export const main = {apply() {appendFileSync(${JSON.stringify(join(home, 'applied.txt'))}, 'applied\\n')}}\n`,
    )
    const manager = reader(),
      source = parseSource('file:./source'),
      preview = await manager.inspect(profileDir, source)
    await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
    const row = (await manager.inventory(profileDir)).packages[0]!
    await manager.trust(profileDir, row.id, {
      integrity: row.entry.integrity,
      capabilityHash: row.capabilityHash,
    })
    await manager.enable(profileDir, row.id, true)
    const pinId = activeRuntimePinId({ packageId: row.id, integrity: row.entry.integrity })
    await manager.pinRuntimeSnapshot(profileDir, {
      pinId,
      operationId: pinId,
      purpose: 'active',
      packageId: row.id,
      selector: {
        kind: 'installed',
        expectedIntegrity: row.entry.integrity,
        expectedTreeIntegrity: row.entry.treeIntegrity!,
      },
    })
    return { home, profileDir, verification, reader, close }
  } catch (error) {
    await close()
    throw error
  }
}
