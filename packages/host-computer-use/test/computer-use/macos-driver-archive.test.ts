import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import fixed from '../../src/computer-use/computer-use-driver-lock.json' with { type: 'json' }
import type { ComputerUseDriverLock } from '../../src/computer-use/driver-lock.js'
import { extractLockedMacOSComputerUseDriver } from '../../src/computer-use/macos-driver-archive.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const relative = [
  '',
  'cua-driver',
  'CuaDriver.app/',
  'cua_driver_node_runtime.node',
  'cua_driver_abi.h',
  'cua-cursor-theme',
  'libcua_driver_sdk.dylib',
  'CuaDriver.app/Contents/',
  'CuaDriver.app/Contents/CodeResources',
  'CuaDriver.app/Contents/_CodeSignature/',
  'CuaDriver.app/Contents/MacOS/',
  'CuaDriver.app/Contents/Resources/',
  'CuaDriver.app/Contents/embedded.provisionprofile',
  'CuaDriver.app/Contents/Info.plist',
  'CuaDriver.app/Contents/Resources/AppIcon.icns',
  'CuaDriver.app/Contents/MacOS/cua-driver',
  'CuaDriver.app/Contents/MacOS/cua-cursor-theme',
  'CuaDriver.app/Contents/_CodeSignature/CodeResources',
] as const

function lock(bytes: Uint8Array): ComputerUseDriverLock {
  const value = structuredClone(fixed) as ComputerUseDriverLock
  const artifact = value.artifacts.find((candidate) => candidate.platform === 'darwin') as {
    size: number
    sha256: string
  }
  artifact.size = bytes.byteLength
  artifact.sha256 = createHash('sha256').update(bytes).digest('hex')
  return value
}

function writeTree(destination: string, prefix: string): void {
  const root = join(destination, prefix)
  for (const name of relative.slice(1)) {
    const path = join(root, ...name.replace(/\/$/u, '').split('/'))
    if (name.endsWith('/')) mkdirSync(path, { recursive: true })
    else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, name)
    }
  }
}

function listing(prefix: string) {
  const names = relative.map((name) => `${prefix}/${name}`)
  return {
    names,
    verbose: names.map((name) => `${name.endsWith('/') ? 'd' : '-'}rwx------ 0 owner group 0 date ${name}`),
  }
}

it('accepts only the exact locked member set and returns a verified private staging tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-archive-'))
  roots.push(root)
  const bytes = new TextEncoder().encode('locked archive')
  const prefix = 'cua-driver-rs-0.28.1-darwin-universal'
  const verify = vi.fn(async (directory: string) => ({
    executablePath: join(directory, 'cua-driver'),
    version: '0.28.1',
    bundleId: 'com.trycua.driver',
    teamId: 'YCK386LBJ7',
    authority: 'Developer ID Application: Cua AI, Inc. (YCK386LBJ7)',
    appPath: join(directory, 'CuaDriver.app'),
  }))
  const result = await extractLockedMacOSComputerUseDriver({
    archiveBytes: bytes,
    stagingParent: root,
    lock: lock(bytes),
    dependencies: {
      inspect: async () => listing(prefix),
      extract: async (_archive, destination) => writeTree(destination, prefix),
      verify,
    },
  })
  expect(result.verified).toMatchObject({ version: '0.28.1', teamId: 'YCK386LBJ7' })
  expect(verify).toHaveBeenCalledOnce()
  await result.release()
})

it.each([
  ['path', (value: ReturnType<typeof listing>) => ({ ...value, names: [...value.names, '../escape'] })],
  [
    'type',
    (value: ReturnType<typeof listing>) => ({
      ...value,
      verbose: value.verbose.map((line, index) => (index === 1 ? `l${line.slice(1)}` : line)),
    }),
  ],
] as const)('rejects an unsafe archive %s before extraction', async (_name, mutate) => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-archive-'))
  roots.push(root)
  const bytes = new TextEncoder().encode('locked archive')
  const prefix = 'cua-driver-rs-0.28.1-darwin-universal'
  const extract = vi.fn()
  await expect(
    extractLockedMacOSComputerUseDriver({
      archiveBytes: bytes,
      stagingParent: root,
      lock: lock(bytes),
      dependencies: { inspect: async () => mutate(listing(prefix)), extract },
    }),
  ).rejects.toThrow('archive')
  expect(extract).not.toHaveBeenCalled()
})

it('rejects bytes that differ from the locked digest before inspecting tar metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-mac-archive-'))
  roots.push(root)
  const inspect = vi.fn()
  await expect(
    extractLockedMacOSComputerUseDriver({
      archiveBytes: new TextEncoder().encode('changed'),
      stagingParent: root,
      lock: lock(new TextEncoder().encode('locked')),
      dependencies: { inspect },
    }),
  ).rejects.toThrow(/size|digest/u)
  expect(inspect).not.toHaveBeenCalled()
})
