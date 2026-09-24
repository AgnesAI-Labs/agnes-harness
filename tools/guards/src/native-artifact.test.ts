import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repoRoot } from './repo.js'

const HOST_NATIVE_DIR = 'packages/host/native'

/**
 * Return true for executable formats, not for a filename or execute bit. The source directory
 * intentionally contains extensionless C sources, so names and modes cannot distinguish the
 * generated helper from source. These signatures cover the native formats our build/packaging
 * routes could introduce without relying on the host `file` utility.
 */
export function isNativeExecutable(contents: Uint8Array): boolean {
  if (contents.length < 4) return false
  const magic = contents.subarray(0, 4)
  const equals = (...bytes: number[]) => bytes.every((byte, index) => magic[index] === byte)
  const peOffset =
    contents.length >= 0x40
      ? (contents[0x3c] ?? 0) |
        ((contents[0x3d] ?? 0) << 8) |
        ((contents[0x3e] ?? 0) << 16) |
        ((contents[0x3f] ?? 0) << 24)
      : -1
  const isPe =
    equals(0x4d, 0x5a) &&
    peOffset >= 0 &&
    peOffset + 4 <= contents.length &&
    contents[peOffset] === 0x50 &&
    contents[peOffset + 1] === 0x45 &&
    contents[peOffset + 2] === 0 &&
    contents[peOffset + 3] === 0
  return (
    equals(0x7f, 0x45, 0x4c, 0x46) || // ELF
    isPe ||
    equals(0xfe, 0xed, 0xfa, 0xce) || // Mach-O 32-bit, big-endian
    equals(0xce, 0xfa, 0xed, 0xfe) || // Mach-O 32-bit, little-endian
    equals(0xfe, 0xed, 0xfa, 0xcf) || // Mach-O 64-bit, big-endian
    equals(0xcf, 0xfa, 0xed, 0xfe) || // Mach-O 64-bit, little-endian
    equals(0xca, 0xfe, 0xba, 0xbe) || // universal Mach-O, big-endian
    equals(0xbe, 0xba, 0xfe, 0xca) || // universal Mach-O, little-endian
    equals(0xca, 0xfe, 0xba, 0xbf) || // universal Mach-O 64-bit, big-endian
    equals(0xbf, 0xba, 0xfe, 0xca) // universal Mach-O 64-bit, little-endian
  )
}

/** Read the index, rather than disk or status: this catches `git add --force` for ignored files. */
export function trackedNativeArtifacts(root: string): string[] {
  const paths = execFileSync('git', ['ls-files', '-z', '--', HOST_NATIVE_DIR], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  return paths.filter((path) => {
    const contents = execFileSync('git', ['show', `:${path}`], { cwd: root })
    return isNativeExecutable(contents)
  })
}

describe('host native source directory contains no tracked generated executables', () => {
  it('rejects no indexed native artifact', () => {
    const offenders = trackedNativeArtifacts(repoRoot())
    expect(offenders, `remove generated helpers from the index: ${offenders.join(', ')}`).toEqual([])
  })
})

const temporaryRepos: string[] = []

function temporaryRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'agnes-native-artifact-guard-'))
  temporaryRepos.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

function stage(root: string, path: string, force = false): void {
  execFileSync('git', ['add', ...(force ? ['--force'] : []), '--', path], { cwd: root })
}

afterEach(() => {
  for (const root of temporaryRepos.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('native artifact index guard', () => {
  it('allows tracked C source and a script in the restricted source directory', () => {
    const root = temporaryRepo()
    const native = join(root, HOST_NATIVE_DIR)
    mkdirSync(native, { recursive: true })
    writeFileSync(join(native, 'macos-process-identity.c'), 'int main(void) { return 0; }\n')
    writeFileSync(join(native, 'build-helper'), '#!/bin/sh\necho source helper\n')
    chmodSync(join(native, 'build-helper'), 0o755)
    stage(root, HOST_NATIVE_DIR)
    expect(trackedNativeArtifacts(root)).toEqual([])
  })

  it('rejects an ignored Mach-O helper force-added to the index', () => {
    const root = temporaryRepo()
    const relative = `${HOST_NATIVE_DIR}/macos-process-identity`
    writeFileSync(join(root, '.gitignore'), `${relative}\n`)
    mkdirSync(join(root, HOST_NATIVE_DIR), { recursive: true })
    writeFileSync(join(root, relative), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
    stage(root, relative, true)
    expect(trackedNativeArtifacts(root)).toEqual([relative])
  })

  it.each([
    ['ELF', Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])],
    ['PE', peSignature()],
    ['Mach-O arm64', Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe])],
  ])('recognizes %s signatures without a platform command', (_name, bytes) => {
    expect(isNativeExecutable(bytes)).toBe(true)
  })

  it('does not mistake an incomplete DOS header for PE', () => {
    expect(isNativeExecutable(Uint8Array.from([0x4d, 0x5a, 0, 0]))).toBe(false)
  })
})

function peSignature(): Uint8Array {
  const contents = new Uint8Array(0x44)
  contents.set([0x4d, 0x5a], 0)
  contents[0x3c] = 0x40
  contents.set([0x50, 0x45, 0, 0], 0x40)
  return contents
}
