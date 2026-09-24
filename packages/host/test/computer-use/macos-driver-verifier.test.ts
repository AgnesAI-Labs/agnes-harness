import { expect, it, vi } from 'vitest'
import fixedLock from '../../src/computer-use/computer-use-driver-lock.json' with { type: 'json' }
import type { ComputerUseDriverLock } from '../../src/computer-use/driver-lock.js'
import { verifyMacOSComputerUseDriver } from '../../src/computer-use/macos-driver-verifier.js'

const entries = [
  'CuaDriver.app',
  'CuaDriver.app/Contents',
  'CuaDriver.app/Contents/CodeResources',
  'CuaDriver.app/Contents/Info.plist',
  'CuaDriver.app/Contents/MacOS',
  'CuaDriver.app/Contents/MacOS/cua-cursor-theme',
  'CuaDriver.app/Contents/MacOS/cua-driver',
  'CuaDriver.app/Contents/Resources',
  'CuaDriver.app/Contents/Resources/AppIcon.icns',
  'CuaDriver.app/Contents/_CodeSignature',
  'CuaDriver.app/Contents/_CodeSignature/CodeResources',
  'CuaDriver.app/Contents/embedded.provisionprofile',
  'cua-cursor-theme',
  'cua-driver',
  'cua_driver_abi.h',
  'cua_driver_node_runtime.node',
  'libcua_driver_sdk.dylib',
]

function fixture(overrides: { details?: string; gatekeeper?: string; arch?: string } = {}) {
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    if (args.includes('-dv'))
      return {
        stdout: '',
        stderr:
          overrides.details ??
          'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7\nAuthority=Developer ID Application: Cua AI, Inc. (YCK386LBJ7)\n',
      }
    if (command.endsWith('spctl'))
      return { stdout: '', stderr: overrides.gatekeeper ?? 'accepted\nsource=Notarized Developer ID\n' }
    if (command.endsWith('lipo')) return { stdout: overrides.arch ?? 'x86_64 arm64\n', stderr: '' }
    if (args.includes('--version')) return { stdout: 'cua-driver 0.28.1\n', stderr: '' }
    return { stdout: '', stderr: '' }
  })
  return {
    run,
    listEntries: async () => entries,
    nodeRuntimeSha256: async () => '554603370c5c5994dfc0d56def917c57fd6d7d479887fe486016eec00197c9c6',
  }
}

it('verifies the locked Developer ID app, every signed Mach-O, universal arches and version', async () => {
  const dependencies = fixture()
  await expect(
    verifyMacOSComputerUseDriver('/private/driver', fixedLock as ComputerUseDriverLock, dependencies),
  ).resolves.toMatchObject({
    executablePath: expect.stringContaining('cua-driver'),
    appPath: expect.stringContaining('CuaDriver.app'),
    version: '0.28.1',
    bundleId: 'com.trycua.driver',
    teamId: 'YCK386LBJ7',
  })
  expect(dependencies.run).toHaveBeenCalledWith('/usr/bin/xcrun', [
    'stapler',
    'validate',
    expect.stringContaining('CuaDriver.app'),
  ])
  expect(dependencies.run).not.toHaveBeenCalledWith('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--verbose=2',
    expect.stringContaining('cua_driver_node_runtime.node'),
  ])
  expect(dependencies.run).not.toHaveBeenCalledWith('/usr/bin/lipo', [
    '-archs',
    expect.stringContaining('cua_driver_node_runtime.node'),
  ])
})

it('rejects an unsigned Node runtime exception that is not bound to the exact locked archive', async () => {
  const changedLock = structuredClone(fixedLock) as ComputerUseDriverLock
  const artifact = changedLock.artifacts.find((candidate) => candidate.platform === 'darwin')
  if (!artifact) throw new Error('fixture lacks macOS artifact')
  ;(artifact as { sha256: string }).sha256 = '0'.repeat(64)
  const dependencies = fixture()
  await expect(verifyMacOSComputerUseDriver('/private/driver', changedLock, dependencies)).rejects.toThrow(
    'does not authorize',
  )
  expect(dependencies.run).not.toHaveBeenCalled()
})

it('rejects an installed unsigned Node runtime whose bytes no longer match the reviewed release', async () => {
  await expect(
    verifyMacOSComputerUseDriver('/private/driver', fixedLock as ComputerUseDriverLock, {
      ...fixture(),
      nodeRuntimeSha256: async () => '0'.repeat(64),
    }),
  ).rejects.toThrow('runtime digest')
})

it.each([
  [{ details: 'Identifier=evil\nTeamIdentifier=YCK386LBJ7\n' }, 'signer identity'],
  [{ gatekeeper: 'rejected\n' }, 'notarized'],
  [{ arch: 'arm64\n' }, 'not universal'],
] as const)('fails closed when native evidence is incomplete %#', async (overrides, message) => {
  await expect(
    verifyMacOSComputerUseDriver('/private/driver', fixedLock as ComputerUseDriverLock, fixture(overrides)),
  ).rejects.toThrow(message)
})

it('rejects extra archive contents before executing platform verifiers', async () => {
  const dependencies = fixture()
  await expect(
    verifyMacOSComputerUseDriver('/private/driver', fixedLock as ComputerUseDriverLock, {
      ...dependencies,
      listEntries: async () => [...entries, 'extra'],
    }),
  ).rejects.toThrow('tree')
  expect(dependencies.run).not.toHaveBeenCalled()
})
