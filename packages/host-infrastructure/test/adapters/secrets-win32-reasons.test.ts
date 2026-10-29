import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPrivateDaclSync, windowsReadPrivateTextSync } from '@agnes/system-node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readWindowsSecret } from '../../src/adapters/secrets-win32.js'

vi.mock('@agnes/system-node', async (original) => ({
  ...(await original<typeof import('@agnes/system-node')>()),
  hasPrivateDaclSync: vi.fn(),
  windowsReadPrivateTextSync: vi.fn(),
}))
let root: string
const ref = 'secret://fixture/default'
const read = () => readWindowsSecret(root, 'fixture', 'default', ref)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-secret-reason-'))
  mkdirSync(join(root, 'fixture'))
  vi.mocked(hasPrivateDaclSync).mockReset().mockReturnValue(true)
  vi.mocked(windowsReadPrivateTextSync).mockReset().mockReturnValue('synthetic-value')
})
afterEach(() => rmSync(root, { force: true, recursive: true }))

it.each(['store', 'namespace', 'file'] as const)(
  'names a refused %s without reflecting native errors',
  (part) => {
    if (part === 'file')
      vi.mocked(windowsReadPrivateTextSync).mockImplementation(() => {
        throw new Error('private-native-canary')
      })
    else
      vi.mocked(hasPrivateDaclSync).mockImplementation(
        (path) => path !== (part === 'store' ? root : join(root, 'fixture')),
      )
    expect(read).toThrow(
      expect.objectContaining({
        detail: {
          ref,
          kind: 'file',
          reason: 'private-file',
          part,
          ...(part === 'file' ? {} : { check: 'not-private' }),
        },
      }),
    )
    if (part !== 'file') expect(read).toThrow(/inheritance turned off.*inheritance:r/)
    try {
      read()
    } catch (error) {
      expect(String(error)).not.toContain('private-native-canary')
    }
  },
)
it('distinguishes missing directories and files from permission refusal', () => {
  expect(read()).toBe('synthetic-value')
  vi.mocked(windowsReadPrivateTextSync).mockImplementation(() => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  expect(read).toThrow(expect.objectContaining({ detail: { ref, kind: 'file' } }))
  rmSync(join(root, 'fixture'), { recursive: true })
  expect(read).toThrow(expect.objectContaining({ detail: { ref, kind: 'file' } }))
})
it('explains a namespace that is a file or a symbolic link', () => {
  const namespace = join(root, 'fixture')
  rmSync(namespace, { recursive: true })
  writeFileSync(namespace, 'synthetic-file')
  expect(read).toThrow(
    expect.objectContaining({
      detail: expect.objectContaining({ part: 'namespace', check: 'not-directory' }),
    }),
  )
  rmSync(namespace)
  symlinkSync(root, namespace, process.platform === 'win32' ? 'junction' : 'dir')
  expect(read).toThrow(
    expect.objectContaining({ detail: expect.objectContaining({ part: 'namespace', check: 'symlink' }) }),
  )
})
it.each(['EIO', 'ENOENT'])(
  'keeps a failed ACL check (%s) a refusal without inventing a failed rule',
  (code) => {
    vi.mocked(hasPrivateDaclSync).mockImplementation(() => {
      throw Object.assign(new Error('native-canary'), { code })
    })
    expect(read).toThrow(
      expect.objectContaining({ detail: { ref, kind: 'file', reason: 'private-file', part: 'store' } }),
    )
  },
)
