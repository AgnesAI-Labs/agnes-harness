import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createPrivateDirectorySync } from '../src/index.js'

it('fails closed with an older native artifact without directory publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-old-directory-native-'))
  const source = join(root, 'source'),
    target = join(root, 'target')
  createPrivateDirectorySync(source)
  const actual = createRequire(import.meta.url)('@agnes/system-node/native')
  const old = Object.fromEntries(Object.getOwnPropertyNames(actual).map((key) => [key, actual[key]]))
  delete old.renameDirectoryNoReplace
  vi.resetModules()
  vi.doMock('node:module', () => ({ createRequire: () => () => old }))
  try {
    const { renameDirectoryNoReplaceSync } = await import('../src/index.js')
    expect(() => renameDirectoryNoReplaceSync(source, target)).toThrow(
      expect.objectContaining({ code: 'E_SYSTEM_NATIVE_UNAVAILABLE' }),
    )
    expect(existsSync(source)).toBe(true)
    expect(existsSync(target)).toBe(false)
  } finally {
    vi.doUnmock('node:module')
    vi.resetModules()
    rmSync(root, { recursive: true, force: true })
  }
})

it('names the native GLIBC cause without leaking the loader path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-glibc-load-'))
  const source = join(root, 'source')
  createPrivateDirectorySync(source)
  vi.resetModules()
  vi.doMock('node:module', () => ({
    createRequire: () => () => {
      throw new Error("/private/secret-loader-path: version `GLIBC_2.33' not found")
    },
  }))
  try {
    const { renameDirectoryNoReplaceSync } = await import('../src/index.js')
    expect(() => renameDirectoryNoReplaceSync(source, join(root, 'target'))).toThrow(
      expect.objectContaining({
        code: 'E_SYSTEM_NATIVE_UNAVAILABLE',
        message: 'system-node native addon failed to load: GLIBC_2.33 not found',
        detail: { reason: 'native-glibc-incompatible' },
      }),
    )
    expect(existsSync(source)).toBe(true)
  } finally {
    vi.doUnmock('node:module')
    vi.resetModules()
    rmSync(root, { recursive: true, force: true })
  }
})
