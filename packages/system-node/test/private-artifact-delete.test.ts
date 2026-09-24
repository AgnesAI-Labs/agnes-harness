import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPrivateFileSync,
  macOSDeletePrivateArtifactSync,
  windowsDeletePrivateArtifactSync,
  windowsEnsurePrivateDirectorySync,
} from '../src/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe.skipIf(process.platform !== 'darwin')('macOS private artifact openat deletion', () => {
  it('hashes and unlinks a revalidated private single-link file below the configured temporary root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agnes-artifact-delete-'))
    roots.push(parent)
    const storeRoot = join(parent, 'private', 'artifacts', 'sha256')
    const bytes = Buffer.from('macOS content-addressed artifact')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const relative = `${digest.slice(0, 2)}/${digest}`
    const target = join(storeRoot, digest.slice(0, 2), digest)
    mkdirSync(join(storeRoot, digest.slice(0, 2)), { recursive: true, mode: 0o700 })
    const fd = createPrivateFileSync(target)
    writeFileSync(fd, bytes)
    closeSync(fd)

    expect(macOSDeletePrivateArtifactSync(storeRoot, relative, digest)).toBe(bytes.length)
    expect(existsSync(target)).toBe(false)
  })

  it('accepts a /tmp system-alias root constructed from its private canonical directory', () => {
    const canonicalParent = mkdtempSync('/private/tmp/agnes-artifact-delete-')
    roots.push(canonicalParent)
    const aliasParent = join('/tmp', basename(canonicalParent))
    expect(lstatSync('/tmp').isSymbolicLink()).toBe(true)
    const storeRoot = join(aliasParent, 'private', 'artifacts', 'sha256')
    const bytes = Buffer.from('artifact below the /tmp system alias')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const relative = `${digest.slice(0, 2)}/${digest}`
    const target = join(canonicalParent, 'private', 'artifacts', 'sha256', digest.slice(0, 2), digest)
    mkdirSync(join(canonicalParent, 'private', 'artifacts', 'sha256', digest.slice(0, 2)), {
      recursive: true,
      mode: 0o700,
    })
    const fd = createPrivateFileSync(target)
    writeFileSync(fd, bytes)
    closeSync(fd)

    expect(macOSDeletePrivateArtifactSync(storeRoot, relative, digest)).toBe(bytes.length)
    expect(existsSync(target)).toBe(false)
  })

  it('accepts the same private directory when its canonical path is passed directly', () => {
    const canonicalParent = mkdtempSync('/private/tmp/agnes-artifact-delete-')
    roots.push(canonicalParent)
    const storeRoot = join(canonicalParent, 'private', 'artifacts', 'sha256')
    const bytes = Buffer.from('artifact below the canonical private temporary root')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const relative = `${digest.slice(0, 2)}/${digest}`
    const target = join(storeRoot, digest.slice(0, 2), digest)
    mkdirSync(join(storeRoot, digest.slice(0, 2)), { recursive: true, mode: 0o700 })
    const fd = createPrivateFileSync(target)
    writeFileSync(fd, bytes)
    closeSync(fd)

    expect(macOSDeletePrivateArtifactSync(storeRoot, relative, digest)).toBe(bytes.length)
    expect(existsSync(target)).toBe(false)
  })

  it('requires a complete alias component before normalizing /var', () => {
    const source = readFileSync(new URL('../native/macos.c', import.meta.url), 'utf8')
    expect(source).toContain("(path[alias_length] != '\\0' && path[alias_length] != '/')")
  })

  it('refuses a store root reached through an intermediate symlink', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agnes-artifact-delete-'))
    roots.push(parent)
    const actualParent = join(parent, 'actual')
    const storeRoot = join(actualParent, 'artifacts', 'sha256')
    const bytes = Buffer.from('artifact behind an intermediate link')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const relative = `${digest.slice(0, 2)}/${digest}`
    const target = join(storeRoot, digest.slice(0, 2), digest)
    mkdirSync(join(storeRoot, digest.slice(0, 2)), { recursive: true, mode: 0o700 })
    const fd = createPrivateFileSync(target)
    writeFileSync(fd, bytes)
    closeSync(fd)
    const alias = join(parent, 'alias')
    symlinkSync(actualParent, alias, 'dir')

    expect(() =>
      macOSDeletePrivateArtifactSync(join(alias, 'artifacts', 'sha256'), relative, digest),
    ).toThrow()
    expect(existsSync(target)).toBe(true)
  })

  it('refuses a symbolic-link artifact target without touching its referent', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agnes-artifact-delete-'))
    roots.push(parent)
    const storeRoot = join(parent, 'private', 'artifacts', 'sha256')
    const bytes = Buffer.from('artifact symlink must remain a link')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const relative = `${digest.slice(0, 2)}/${digest}`
    const target = join(storeRoot, digest.slice(0, 2), digest)
    const referent = join(parent, 'referent')
    mkdirSync(join(storeRoot, digest.slice(0, 2)), { recursive: true, mode: 0o700 })
    writeFileSync(referent, bytes)
    symlinkSync(referent, target, 'file')

    expect(() => macOSDeletePrivateArtifactSync(storeRoot, relative, digest)).toThrow()
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(existsSync(referent)).toBe(true)
  })

  it('refuses a digest mismatch and leaves the artifact in place', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agnes-artifact-delete-'))
    roots.push(parent)
    const storeRoot = join(parent, 'private', 'artifacts', 'sha256')
    const bytes = Buffer.from('artifact digest mismatch stays intact')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const claimed = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`
    const relative = `${claimed.slice(0, 2)}/${claimed}`
    const target = join(storeRoot, claimed.slice(0, 2), claimed)
    mkdirSync(join(storeRoot, claimed.slice(0, 2)), { recursive: true, mode: 0o700 })
    const fd = createPrivateFileSync(target)
    writeFileSync(fd, bytes)
    closeSync(fd)

    expect(() => macOSDeletePrivateArtifactSync(storeRoot, relative, claimed)).toThrow()
    expect(existsSync(target)).toBe(true)
  })

  it('refuses a hard-linked artifact and leaves both names in place', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agnes-artifact-delete-'))
    roots.push(parent)
    const storeRoot = join(parent, 'private', 'artifacts', 'sha256')
    const bytes = Buffer.from('artifact hard links are not private')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const relative = `${digest.slice(0, 2)}/${digest}`
    const target = join(storeRoot, digest.slice(0, 2), digest)
    const sibling = join(parent, 'hard-link')
    mkdirSync(join(storeRoot, digest.slice(0, 2)), { recursive: true, mode: 0o700 })
    const fd = createPrivateFileSync(target)
    writeFileSync(fd, bytes)
    closeSync(fd)
    linkSync(target, sibling)

    expect(() => macOSDeletePrivateArtifactSync(storeRoot, relative, digest)).toThrow()
    expect(existsSync(target)).toBe(true)
    expect(existsSync(sibling)).toBe(true)
  })
})

describe.skipIf(process.platform !== 'win32')('Windows private artifact handle deletion', () => {
  it('hashes and deletes the same private single-link handle beneath the store root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agnes-artifact-delete-'))
    roots.push(parent)
    const storeRoot = join(parent, 'private', 'artifacts', 'sha256')
    const bytes = Buffer.from('content-addressed artifact')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const relative = `${digest.slice(0, 2)}/${digest}`
    const target = join(storeRoot, digest.slice(0, 2), digest)
    windowsEnsurePrivateDirectorySync(join(storeRoot, digest.slice(0, 2)))
    const fd = createPrivateFileSync(target)
    writeFileSync(fd, bytes)
    closeSync(fd)

    expect(windowsDeletePrivateArtifactSync(storeRoot, relative, digest)).toBe(bytes.length)
    expect(existsSync(target)).toBe(false)
  })

  it('refuses a mismatched digest and leaves the bytes in place', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agnes-artifact-delete-'))
    roots.push(parent)
    const storeRoot = join(parent, 'private', 'artifacts', 'sha256')
    const bytes = Buffer.from('kept artifact')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const claimed = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`
    const relative = `${claimed.slice(0, 2)}/${claimed}`
    const target = join(storeRoot, claimed.slice(0, 2), claimed)
    windowsEnsurePrivateDirectorySync(join(storeRoot, claimed.slice(0, 2)))
    const fd = createPrivateFileSync(target)
    writeFileSync(fd, bytes)
    closeSync(fd)

    expect(() => windowsDeletePrivateArtifactSync(storeRoot, relative, claimed)).toThrow()
    expect(existsSync(target)).toBe(true)
  })
})
