import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { validateLockedPackageArchive } from '../src/computer-use/locked-package-archive.js'

type TarEntry = { path: string; bytes?: Uint8Array; mode?: number; type?: number }
const encoder = new TextEncoder()

function writeText(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value)
  if (bytes.byteLength > length) throw new Error('test tar field overflow')
  target.set(bytes, offset)
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeText(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function updateChecksum(header: Uint8Array): void {
  header.fill(0x20, 148, 156)
  let checksum = 0
  for (const value of header) checksum += value
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
}

function tar(entries: TarEntry[], trailing = new Uint8Array()): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    const bytes = entry.bytes ?? new Uint8Array()
    const header = new Uint8Array(512)
    writeText(header, 0, 100, entry.path)
    writeOctal(header, 100, 8, entry.mode ?? (entry.type === 0x35 ? 0o755 : 0o600))
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, bytes.byteLength)
    writeOctal(header, 136, 12, 0)
    header[156] = entry.type ?? 0x30
    writeText(header, 257, 6, 'ustar')
    writeText(header, 263, 2, '00')
    updateChecksum(header)
    chunks.push(header, bytes)
    const padding = (512 - (bytes.byteLength % 512)) % 512
    if (padding) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(1024), trailing)
  return Buffer.concat(chunks)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function manifest(
  archive: Uint8Array,
  files: Array<{ path: string; bytes: Uint8Array }>,
): Record<string, unknown> {
  const entries = files
    .map((file) => ({ path: file.path, sha256: digest(file.bytes), size: file.bytes.byteLength }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const aggregate = createHash('sha256')
  for (const file of entries) aggregate.update(`${file.path}\0${file.sha256}\0${file.size}\n`)
  return {
    schemaVersion: 1,
    packageId: 'computer-use-skill',
    version: '1.0.0',
    packageSha256: aggregate.digest('hex'),
    provenance: {
      source: 'https://example.test/releases/computer-use-skill.tar.gz',
      revision: 'a'.repeat(40),
      artifactSha256: digest(archive),
    },
    signature: {
      algorithm: 'ed25519',
      keyId: 'fixture-key-not-trusted',
      value: Buffer.alloc(64).toString('base64'),
    },
    compatibility: {
      agnesApiVersions: ['v1'],
      platforms: ['darwin-arm64'],
      osVersions: ['test-only'],
    },
    files: entries,
  }
}

function validate(
  entries: TarEntry[],
  options: { archive?: Uint8Array; manifestFiles?: Array<{ path: string; bytes: Uint8Array }> } = {},
) {
  const archive = options.archive ?? tar(entries)
  const manifestFiles =
    options.manifestFiles ??
    entries
      .filter((entry) => (entry.type ?? 0x30) === 0x30)
      .map((entry) => ({ path: entry.path, bytes: entry.bytes ?? new Uint8Array() }))
  return validateLockedPackageArchive({ archiveBytes: archive, manifest: manifest(archive, manifestFiles) })
}

describe('locked Computer Use Skill archive validation', () => {
  it('returns immutable, explicitly untrusted bytes and entries without filesystem extraction', () => {
    const skill = encoder.encode('# Computer Use\n')
    const guide = encoder.encode('Use only the wrapped computer_use tool.\n')
    const archive = tar([
      { path: 'skill/', type: 0x35 },
      { path: 'skill/SKILL.md', bytes: skill },
      { path: 'skill/references/', type: 0x35 },
      { path: 'skill/references/safety.md', bytes: guide },
    ])
    const result = validateLockedPackageArchive({
      archiveBytes: archive,
      manifest: manifest(archive, [
        { path: 'skill/SKILL.md', bytes: skill },
        { path: 'skill/references/safety.md', bytes: guide },
      ]),
    })

    expect(result.trust).toBe('validated-untrusted-archive')
    expect(result.sourceArchiveBytes).toEqual({
      encoding: 'base64',
      value: Buffer.from(archive).toString('base64'),
      byteLength: archive.byteLength,
      sha256: digest(archive),
    })
    expect(result.files.map((file) => file.path)).toEqual(['skill/SKILL.md', 'skill/references/safety.md'])
    expect(Buffer.from(result.files[0]?.content.value ?? '', 'base64')).toEqual(Buffer.from(skill))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.manifest)).toBe(true)
    expect(Object.isFrozen(result.manifest.files)).toBe(true)
    expect(Object.isFrozen(result.files)).toBe(true)
    expect(Object.isFrozen(result.files[0]?.content)).toBe(true)
  })

  it('deep-copies inputs and exposes no mutable byte buffers across validation', () => {
    const skill = encoder.encode('# immutable\n')
    const archive = tar([{ path: 'skill/SKILL.md', bytes: skill }])
    const detached = manifest(archive, [{ path: 'skill/SKILL.md', bytes: skill }])
    const result = validateLockedPackageArchive({ archiveBytes: archive, manifest: detached })
    const originalArchive = result.sourceArchiveBytes.value
    const originalFile = result.files[0]?.content.value

    archive.fill(0)
    skill.fill(0)
    ;(detached.provenance as Record<string, unknown>).artifactSha256 = '0'.repeat(64)
    const detachedFile = (detached.files as Array<Record<string, unknown>>)[0]
    if (!detachedFile) throw new Error('missing test manifest file')
    detachedFile.sha256 = '0'.repeat(64)

    expect(result.sourceArchiveBytes.value).toBe(originalArchive)
    expect(result.files[0]?.content.value).toBe(originalFile)
    expect(result.manifest.provenance.artifactSha256).toBe(result.sourceArchiveBytes.sha256)
    expect(() => {
      ;(result.files as unknown[]).push('mutated')
    }).toThrow()
  })

  it('accepts bounded gzip while binding the original compressed bytes', () => {
    const skill = encoder.encode('# compressed\n')
    const archive = gzipSync(tar([{ path: 'skill/SKILL.md', bytes: skill }]))
    const result = validateLockedPackageArchive({
      archiveBytes: archive,
      manifest: manifest(archive, [{ path: 'skill/SKILL.md', bytes: skill }]),
    })
    expect(result.sourceArchiveBytes.sha256).toBe(digest(archive))
    expect(Buffer.from(result.files[0]?.content.value ?? '', 'base64')).toEqual(Buffer.from(skill))
  })

  it('rejects artifact and per-file content digest mismatches', () => {
    const expected = encoder.encode('# expected\n')
    const changed = encoder.encode('# changed!\n')
    const archive = tar([{ path: 'skill/SKILL.md', bytes: changed }])
    const wrongArtifact = manifest(archive, [{ path: 'skill/SKILL.md', bytes: changed }])
    ;(wrongArtifact.provenance as Record<string, unknown>).artifactSha256 = '0'.repeat(64)
    expect(() => validateLockedPackageArchive({ archiveBytes: archive, manifest: wrongArtifact })).toThrow(
      'digest does not match detached manifest provenance',
    )
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: archive,
        manifest: manifest(archive, [{ path: 'skill/SKILL.md', bytes: expected }]),
      }),
    ).toThrow('entry digest does not match')
  })

  it.each([
    ['traversal', '../skill/SKILL.md', 0x30],
    ['absolute path', '/skill/SKILL.md', 0x30],
    ['backslash', 'skill\\SKILL.md', 0x30],
    ['symlink', 'skill/SKILL.md', 0x32],
    ['hardlink', 'skill/SKILL.md', 0x31],
    ['device', 'skill/SKILL.md', 0x33],
  ])('rejects %s entries', (_label, path, type) => {
    const skill = encoder.encode('# unsafe\n')
    const archive = tar([{ path, type, bytes: skill }])
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: archive,
        manifest: manifest(archive, [{ path: 'skill/SKILL.md', bytes: skill }]),
      }),
    ).toThrow(/escapes the skill root|link or special/)
  })

  it('rejects executable files, duplicate case folds and file-directory conflicts', () => {
    const skill = encoder.encode('# unsafe\n')
    expect(() => validate([{ path: 'skill/SKILL.md', bytes: skill, mode: 0o700 }])).toThrow('executable')
    const collision = tar([
      { path: 'skill/SKILL.md', bytes: skill },
      { path: 'skill/skill.md', bytes: skill },
    ])
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: collision,
        manifest: manifest(collision, [{ path: 'skill/SKILL.md', bytes: skill }]),
      }),
    ).toThrow('case-colliding')
    const conflict = tar([
      { path: 'skill/references', bytes: skill },
      { path: 'skill/references/guide.md', bytes: skill },
    ])
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: conflict,
        manifest: manifest(conflict, [{ path: 'skill/SKILL.md', bytes: skill }]),
      }),
    ).toThrow('file and directory path conflict')
  })

  it('rejects oversized files, bad checksums, hidden padding, trailing data and gzip bombs', () => {
    const oversized = new Uint8Array(192 * 1024 + 1)
    const oversizedArchive = tar([{ path: 'skill/SKILL.md', bytes: oversized }])
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: oversizedArchive,
        manifest: manifest(oversizedArchive, [
          { path: 'skill/SKILL.md', bytes: encoder.encode('# expected\n') },
        ]),
      }),
    ).toThrow('file size limit')
    const skill = encoder.encode('# checksum\n')
    const corrupt = tar([{ path: 'skill/SKILL.md', bytes: skill }])
    corrupt[0] = (corrupt[0] ?? 0) ^ 1
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: corrupt,
        manifest: manifest(corrupt, [{ path: 'skill/SKILL.md', bytes: skill }]),
      }),
    ).toThrow('checksum mismatch')
    const hiddenPadding = tar([{ path: 'skill/SKILL.md', bytes: skill }])
    hiddenPadding[512 + skill.byteLength] = 1
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: hiddenPadding,
        manifest: manifest(hiddenPadding, [{ path: 'skill/SKILL.md', bytes: skill }]),
      }),
    ).toThrow('non-zero padding')
    const trailing = tar([{ path: 'skill/SKILL.md', bytes: skill }], encoder.encode('not padding'))
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: trailing,
        manifest: manifest(trailing, [{ path: 'skill/SKILL.md', bytes: skill }]),
      }),
    ).toThrow('data after its end markers')
    const bomb = gzipSync(new Uint8Array(2 * 1024 * 1024 + 1))
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: bomb,
        manifest: manifest(bomb, [{ path: 'skill/SKILL.md', bytes: skill }]),
      }),
    ).toThrow('gzip payload is invalid or exceeds')
  })

  it('fails closed before parsing when cancelled', () => {
    const skill = encoder.encode('# cancelled\n')
    const archive = tar([{ path: 'skill/SKILL.md', bytes: skill }])
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    expect(() =>
      validateLockedPackageArchive({
        archiveBytes: archive,
        manifest: manifest(archive, [{ path: 'skill/SKILL.md', bytes: skill }]),
        signal: controller.signal,
      }),
    ).toThrow('caller cancelled')
  })
})
