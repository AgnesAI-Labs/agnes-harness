import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  defaultVerifyIntegrity,
  defaultVerifyIntegrityAsync,
  fetchSource,
  hashDirectory,
  type LockEntry,
  packageDir,
  parseSource,
  verifiedDirectoryDigest,
  withPackageVerification,
} from '../src/index.js'

const race = vi.hoisted(() => ({ replace: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
      fs.copyFileSync(...args)
      if (race.replace) fs.writeFileSync(join(dirname(String(args[0])), 'index.js'), 'changed after copy')
    },
  }
})
const roots: string[] = []
afterEach(() => {
  race.replace = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-integrity-'))
  roots.push(root)
  return root
}
it.each([false, true])('rechecks installed bytes and registry identity (async=%s)', async (asyncRead) => {
  const root = temp()
  const directory = packageDir(root, 'local-dev', 'acme/verified')
  mkdirSync(directory, { recursive: true })
  const manifest = join(directory, 'package.json')
  const entryFile = join(directory, 'index.js')
  writeFileSync(manifest, JSON.stringify({ name: 'acme/verified', version: '1.0.0' }))
  writeFileSync(entryFile, 'original')
  const entry: LockEntry = {
    version: '1.0.0',
    source: { type: 'file', ref: 'file:fixture' },
    integrity: hashDirectory(directory),
    treeIntegrity: hashDirectory(directory, { exclude: [] }),
    trust: 'trusted',
    license: 'MIT',
    apiRange: '^5.0.0',
    dependencies: {},
    previous: null,
    state: { installed: new Date(0).toISOString(), trusted: new Date(0).toISOString(), enabled: true },
  }
  const verify = (asyncRead ? defaultVerifyIntegrityAsync : defaultVerifyIntegrity)(root, 'local-dev')
  await verify('acme/verified', entry)
  writeFileSync(entryFile, 'tampered')
  await expect(Promise.resolve().then(() => verify('acme/verified', entry))).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
    detail: { reason: 'integrity' },
  })
  writeFileSync(entryFile, 'original')
  await verify('acme/verified', entry)
  writeFileSync(manifest, JSON.stringify({ name: 'acme/impostor', version: '1.0.0' }))
  await expect(
    Promise.resolve().then(() =>
      verify('acme/verified', {
        ...entry,
        source: { type: 'npm', ref: 'npm:acme/verified@1.0.0' },
        releasedAt: new Date(0).toISOString(),
        treeIntegrity: hashDirectory(directory, { exclude: [] }),
      }),
    ),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
})
it('detects real source replacement after copy instead of trusting a preflight digest', async () => {
  const root = temp(),
    source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'acme/race', version: '1.0.0' }))
  writeFileSync(join(source, 'index.js'), 'initial')
  await withPackageVerification(async () => {
    const digest = hashDirectory(source)
    verifiedDirectoryDigest(source, {
      version: '1.0.0',
      integrity: digest,
      treeIntegrity: digest,
      capabilityHash: 'fixture',
    })
    race.replace = true
    await expect(
      fetchSource(parseSource('file:./source'), join(root, 'target'), { cwd: root }),
    ).rejects.toMatchObject({ detail: { reason: 'source-changed' } })
  })
})
it.runIf(process.platform !== 'win32')('rejects a real FIFO without opening it for hashing', () => {
  const root = temp()
  execFileSync('mkfifo', [join(root, 'fifo')])
  expect(() => hashDirectory(root)).toThrow('special entry')
})
