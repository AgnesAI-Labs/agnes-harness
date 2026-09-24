import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  deletePrivateArtifactSync,
  privateArtifactDeleteAvailable,
  renameWriteThroughSync,
  windowsWritePrivateFile,
} from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanComputerUseArtifactCandidates } from '../src/artifact-gc-candidate-scanner.js'
import { computerUseMarkerPath } from '../src/computer-use-marker.js'
import {
  createPrivateArtifactStore,
  withComputerUseArtifactMutation,
  writeComputerUseTombstoneLocked,
} from '../src/private-artifact-store.js'

vi.mock('@agnes/system-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/system-node')>()
  return {
    ...actual,
    renameWriteThroughSync: vi.fn(actual.renameWriteThroughSync),
    windowsWritePrivateFile: vi.fn(actual.windowsWritePrivateFile),
  }
})

const platform = process.platform === 'win32' ? 'win32' : 'darwin'

/** Makes every private write whose target is a classification marker fail once armed. */
function failMarkerWrites(): () => void {
  const rename = vi.mocked(renameWriteThroughSync).getMockImplementation()
  const windows = vi.mocked(windowsWritePrivateFile).getMockImplementation()
  vi.mocked(renameWriteThroughSync).mockImplementation((from, to) => {
    if (String(to).endsWith('.json')) throw new Error('injected marker write failure')
    return (rename ?? renameWriteThroughSync)(from, to)
  })
  vi.mocked(windowsWritePrivateFile).mockImplementation(async (target, bytes) => {
    if (String(target).endsWith('.json')) throw new Error('injected marker write failure')
    return (windows ?? windowsWritePrivateFile)(target, bytes)
  })
  return () => {
    vi.mocked(renameWriteThroughSync).mockImplementation(rename ?? renameWriteThroughSync)
    vi.mocked(windowsWritePrivateFile).mockImplementation(windows ?? windowsWritePrivateFile)
  }
}

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!privateArtifactDeleteAvailable())('private artifact store', () => {
  it('writes bytes that the platform same-handle deletion primitive admits', async () => {
    const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-private-cas-')))
    temporary.push(dataDir)
    const bytes = new TextEncoder().encode('private content-addressed bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const store = createPrivateArtifactStore(dataDir, process.platform === 'win32' ? 'win32' : 'darwin')
    await store.put(sha256, bytes)
    const target = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2), sha256)
    expect(existsSync(target)).toBe(true)
    expect(
      deletePrivateArtifactSync(
        join(dataDir, 'artifacts', 'sha256'),
        `${sha256.slice(0, 2)}/${sha256}`,
        sha256,
      ),
    ).toBe(bytes.byteLength)
    expect(existsSync(target)).toBe(false)
  })

  it('rejects an invalid digest before constructing a path', async () => {
    const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-private-cas-')))
    temporary.push(dataDir)
    const store = createPrivateArtifactStore(dataDir, process.platform === 'win32' ? 'win32' : 'darwin')
    await expect(store.put('../escape', new Uint8Array())).rejects.toThrow(/digest/)
    await expect(store.putComputerUseMetadata('../escape', new Uint8Array())).rejects.toThrow(/digest/)
  })

  it('atomically refreshes a private Computer Use classification marker for a reused digest', async () => {
    const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-private-cas-')))
    temporary.push(dataDir)
    const sha256 = 'a'.repeat(64)
    const store = createPrivateArtifactStore(dataDir, process.platform === 'win32' ? 'win32' : 'darwin')
    await store.putComputerUseMetadata(sha256, new TextEncoder().encode('first'))
    await store.putComputerUseMetadata(sha256, new TextEncoder().encode('second'))
    const target = join(dataDir, 'artifacts', 'computer-use-meta', sha256.slice(0, 2), `${sha256}.json`)
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(target, 'utf8'))).toBe('second')
  })

  it('holds an OS-backed data-directory mutation lock and releases it after the operation', async () => {
    const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-private-cas-')))
    temporary.push(dataDir)
    const lock = join(dataDir, 'artifacts', 'computer-use-artifact-mutation-lock.db')
    await withComputerUseArtifactMutation(dataDir, async () => {
      const competing = new DatabaseSync(lock)
      try {
        expect(() => competing.exec('BEGIN IMMEDIATE')).toThrow(/locked/)
      } finally {
        competing.close()
      }
    })
    const after = new DatabaseSync(lock)
    try {
      expect(() => after.exec('BEGIN IMMEDIATE; COMMIT')).not.toThrow()
    } finally {
      after.close()
    }
  })

  it('keeps a reclaim tombstone through a republication that fails before its bytes land', async () => {
    const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-private-cas-')))
    temporary.push(dataDir)
    const bytes = new TextEncoder().encode('reclaimed then captured again')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const marker = () => JSON.parse(readFileSync(computerUseMarkerPath(dataDir, sha256), 'utf8'))
    const v1 = (createdAtMs: number) =>
      new TextEncoder().encode(
        `${JSON.stringify({ schemaVersion: 1, sha256, size: bytes.byteLength, createdAtMs }, null, 2)}\n`,
      )
    await writeComputerUseTombstoneLocked(dataDir, platform, {
      sha256,
      size: bytes.byteLength,
      createdAtMs: 0,
      collectedAtMs: 5,
    })
    const store = createPrivateArtifactStore(dataDir, platform)
    // The seam classifies before it writes bytes; that step must not turn the tombstone into v1.
    await store.putComputerUseMetadata(sha256, v1(7))
    expect(marker()).toMatchObject({ schemaVersion: 2, collectedAtMs: 5 })
    // The bytes land but refreshing the marker fails: tombstone plus bytes, and the scanner
    // dates the screenshot by its file so it gets the full grace period.
    const restore = failMarkerWrites()
    const before = Date.now()
    try {
      await expect(store.put(sha256, bytes)).rejects.toThrow('injected marker write failure')
    } finally {
      restore()
    }
    expect(existsSync(join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2), sha256))).toBe(true)
    expect(marker().schemaVersion).toBe(2)
    const [candidate] = await scanComputerUseArtifactCandidates(dataDir)
    expect(candidate?.createdAtMs).toBeGreaterThanOrEqual(before - 1000)
    // A successful republication ends as an ordinary v1 classification.
    await store.put(sha256, bytes)
    expect(marker()).toMatchObject({ schemaVersion: 1, sha256, size: bytes.byteLength })
    expect(marker().createdAtMs).toBeGreaterThanOrEqual(before)
  })

  it('overwrites a tombstone whose bytes are present with the new classification', async () => {
    const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-private-cas-')))
    temporary.push(dataDir)
    const bytes = new TextEncoder().encode('bytes still present')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const store = createPrivateArtifactStore(dataDir, platform)
    await store.put(sha256, bytes)
    await writeComputerUseTombstoneLocked(dataDir, platform, {
      sha256,
      size: bytes.byteLength,
      createdAtMs: 0,
      collectedAtMs: 5,
    })
    const v1 = `${JSON.stringify({ schemaVersion: 1, sha256, size: bytes.byteLength, createdAtMs: 9 }, null, 2)}\n`
    await store.putComputerUseMetadata(sha256, new TextEncoder().encode(v1))
    expect(readFileSync(computerUseMarkerPath(dataDir, sha256), 'utf8')).toBe(v1)
  })
})
