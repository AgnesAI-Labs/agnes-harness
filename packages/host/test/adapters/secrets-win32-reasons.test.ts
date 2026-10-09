import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPrivateDaclSync, windowsReadPrivateTextSync } from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readWindowsSecret } from '../../src/adapters/secrets-win32.js'
import type { HostError } from '../../src/errors.js'

// The native calls are stubbed so the decision logic runs on every platform; the Windows-only file
// next to this one exercises the real access lists.
vi.mock('@agnes/system-node', async (original) => ({
  ...(await original<typeof import('@agnes/system-node')>()),
  hasPrivateDaclSync: vi.fn(),
  windowsReadPrivateTextSync: vi.fn(),
}))

const ref = 'secret://teacher/default'
let root: string
let store: string
const namespace = () => join(store, 'teacher')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-secret-reasons-'))
  store = join(root, 'secrets')
  mkdirSync(namespace(), { recursive: true })
  // Reset, not just cleared: a queued one-time answer must not leak into the next test.
  vi.mocked(hasPrivateDaclSync).mockReset().mockReturnValue(true)
  vi.mocked(windowsReadPrivateTextSync).mockReset().mockReturnValue('the-key')
})
afterEach(() => {
  vi.clearAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const refusal = (): HostError => {
  try {
    readWindowsSecret(store, 'teacher', 'default', ref)
  } catch (error) {
    return error as HostError
  }
  throw new Error('the secret was read')
}

describe('a refused Windows secret read says what was refused', () => {
  it('reads a secret when both directories are private', () => {
    expect(readWindowsSecret(store, 'teacher', 'default', ref)).toBe('the-key')
    expect(vi.mocked(hasPrivateDaclSync).mock.calls.map(([path]) => path)).toEqual([store, namespace()])
  })

  it.each([
    ['store', [false, true]],
    ['namespace', [true, false]],
  ] as const)('names the %s when it is the directory that is not private', (part, answers) => {
    vi.mocked(hasPrivateDaclSync).mockReturnValueOnce(answers[0]).mockReturnValueOnce(answers[1])
    const error = refusal()
    expect(error.code).toBe('E_SECRET_UNRESOLVED')
    expect(error.detail).toEqual({ ref, kind: 'file', reason: 'private-file', part, check: 'not-private' })
    // The message says what the rule is, including the part an access list alone does not show.
    expect(error.message).toContain('inheritance turned off')
    expect(error.message).toContain('/inheritance:r')
  })

  it('stops at the first directory that fails and does not read the file', () => {
    vi.mocked(hasPrivateDaclSync).mockReturnValue(false)
    expect(refusal().detail).toMatchObject({ part: 'store' })
    expect(hasPrivateDaclSync).toHaveBeenCalledTimes(1)
    expect(windowsReadPrivateTextSync).not.toHaveBeenCalled()
  })

  it('names a namespace that is a file rather than a directory', () => {
    rmSync(namespace(), { recursive: true })
    writeFileSync(namespace(), 'not a directory')
    expect(refusal().detail).toEqual({
      ref,
      kind: 'file',
      reason: 'private-file',
      part: 'namespace',
      check: 'not-directory',
    })
  })

  it.runIf(process.platform !== 'win32')('names a namespace that is a symbolic link', () => {
    rmSync(namespace(), { recursive: true })
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, namespace())
    expect(refusal().detail).toMatchObject({ part: 'namespace', check: 'symlink' })
    expect(hasPrivateDaclSync).toHaveBeenCalledTimes(1)
  })

  it('does not call a failing native check a missing secret, and says only that it was refused', () => {
    vi.mocked(hasPrivateDaclSync).mockImplementation(() => {
      throw Object.assign(new Error('native detail that must not be repeated'), { code: 'EIO' })
    })
    const error = refusal()
    expect(error.detail).toEqual({ ref, kind: 'file', reason: 'private-file', part: 'store' })
    expect(error.message).not.toContain('native detail')
  })

  it('names the secret file when reading it is refused, and treats a missing one as a miss', () => {
    vi.mocked(windowsReadPrivateTextSync).mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: 'EACCES' })
    })
    expect(refusal().detail).toEqual({ ref, kind: 'file', reason: 'private-file', part: 'file' })
    vi.mocked(windowsReadPrivateTextSync).mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' })
    })
    expect(refusal().detail).toEqual({ ref, kind: 'file' })
  })

  it('treats a missing store or namespace as a miss, which another store may answer', () => {
    rmSync(namespace(), { recursive: true })
    expect(refusal().detail).toEqual({ ref, kind: 'file' })
    vi.mocked(hasPrivateDaclSync).mockClear()
    rmSync(store, { recursive: true })
    expect(refusal().detail).toEqual({ ref, kind: 'file' })
    expect(hasPrivateDaclSync).not.toHaveBeenCalled()
  })
})
