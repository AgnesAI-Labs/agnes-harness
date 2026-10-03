import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  volume: { filesystem: 'NTFS', driveType: 3, readOnly: false },
  failure: null as Error | null,
  available: true,
}))
vi.mock('node:module', () => ({
  createRequire: () => () =>
    new Proxy(
      { abiVersion: 1 },
      {
        get(target, name) {
          if (name === 'abiVersion') return target.abiVersion
          if (name === 'volumeInfo')
            return state.available
              ? () => {
                  if (state.failure) throw state.failure
                  return state.volume
                }
              : undefined
          return () => undefined
        },
      },
    ),
}))
vi.mock('node:path', async (original) => {
  const path = await original<typeof import('node:path')>()
  return { ...path, ...path.win32 }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  state.failure = null
  state.available = true
})

async function leaf() {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  vi.resetModules()
  return import('../src/index.js')
}

it('returns actual volume facts and propagates probe and missing-native errors', async () => {
  const { windowsVolumeInfoSync } = await leaf()
  for (const volume of [
    { filesystem: 'NTFS', driveType: 3, readOnly: false },
    { filesystem: 'ReFS', driveType: 3, readOnly: false },
    { filesystem: 'NTFS', driveType: 4, readOnly: false },
    { filesystem: 'FAT32', driveType: 2, readOnly: true },
  ]) {
    state.volume = volume
    expect(windowsVolumeInfoSync('C:\\local\\中文')).toEqual(volume)
  }
  state.failure = new Error('Volume lookup denied')
  expect(() => windowsVolumeInfoSync('C:\\local')).toThrow(state.failure)
  state.failure = null
  state.available = false
  expect(() => windowsVolumeInfoSync('C:\\local')).toThrow(
    expect.objectContaining({ code: 'E_SYSTEM_NATIVE_UNAVAILABLE' }),
  )
})

it.each([
  'relative',
  'C:relative',
  '\\local',
  '\\\\server\\share\\local',
  '\\\\?\\UNC\\server\\share\\local',
  '\\\\?\\C:\\local',
  '\\\\.\\C:\\local',
  'C:\\local:stream',
  'C:\\bad\0path',
])('refuses UNC, device namespaces and malformed drive paths: %s', async (path) => {
  const { windowsVolumeInfoSync } = await leaf()
  expect(() => windowsVolumeInfoSync(path)).toThrow(expect.objectContaining({ code: 'EINVAL' }))
})
