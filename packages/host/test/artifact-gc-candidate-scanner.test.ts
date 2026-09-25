import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanComputerUseArtifactCandidates } from '../src/artifact-gc-candidate-scanner.js'
import { computerUseMarkerPath } from '../src/computer-use-marker.js'
import { createPrivateArtifactStore, writeComputerUseTombstoneLocked } from '../src/private-artifact-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(bytes: Uint8Array, createdAtMs = 1234) {
  const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-cu-gc-')))
  roots.push(dataDir)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const artifactDirectory = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2))
  const metadataDirectory = join(dataDir, 'artifacts', 'computer-use-meta', sha256.slice(0, 2))
  const store = createPrivateArtifactStore(dataDir, process.platform === 'win32' ? 'win32' : 'darwin')
  await store.put(sha256, bytes)
  await store.putComputerUseMetadata(
    sha256,
    new TextEncoder().encode(
      `${JSON.stringify({ schemaVersion: 1, sha256, size: bytes.byteLength, createdAtMs }, null, 2)}\n`,
    ),
  )
  const tombstone = (createdAtMs: number) =>
    writeComputerUseTombstoneLocked(dataDir, process.platform === 'win32' ? 'win32' : 'darwin', {
      sha256,
      size: bytes.byteLength,
      createdAtMs,
      collectedAtMs: 1,
    })
  return { dataDir, sha256, artifactDirectory, metadataDirectory, tombstone }
}

describe('Computer Use artifact GC candidate scanner', () => {
  it('returns only write-time-classified screenshots with recomputed content identity', async () => {
    const row = await fixture(new TextEncoder().encode('screenshot'))
    await writeFile(join(row.artifactDirectory, 'f'.repeat(64)), 'ordinary artifact without metadata')
    await expect(scanComputerUseArtifactCandidates(row.dataDir)).resolves.toEqual([
      {
        sha256: row.sha256,
        contentSha256: row.sha256,
        path: `${row.dataDir}/artifacts/sha256/${row.sha256.slice(0, 2)}/${row.sha256}`,
        bytes: 10,
        createdAtMs: 1234,
      },
    ])
  })

  it('fails the whole scan for metadata drift, unknown entries, or changed bytes', async () => {
    const metadata = await fixture(new TextEncoder().encode('one'))
    await writeFile(join(metadata.metadataDirectory, `${metadata.sha256}.json`), '{}\n')
    await expect(scanComputerUseArtifactCandidates(metadata.dataDir)).rejects.toThrow(/metadata/)

    const content = await fixture(new TextEncoder().encode('two'))
    await writeFile(join(content.artifactDirectory, content.sha256), 'changed')
    await expect(scanComputerUseArtifactCandidates(content.dataDir)).rejects.toThrow(/identity/)

    const tree = await fixture(new TextEncoder().encode('three'))
    await writeFile(join(tree.metadataDirectory, 'unexpected.txt'), 'x')
    await expect(scanComputerUseArtifactCandidates(tree.dataDir)).rejects.toThrow(/unsafe entry/)
  })

  it('refuses a classification tree that was not created by the private Host writer', async () => {
    const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-cu-gc-broad-')))
    roots.push(dataDir)
    const sha256 = 'a'.repeat(64)
    const metadataDirectory = join(dataDir, 'artifacts', 'computer-use-meta', 'aa')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(metadataDirectory, { recursive: true }))
    await writeFile(
      join(metadataDirectory, `${sha256}.json`),
      `${JSON.stringify({ schemaVersion: 1, sha256, size: 1, createdAtMs: 0 }, null, 2)}\n`,
    )
    if (process.platform === 'win32') {
      // A plain directory under the user's temporary folder inherits an owner-only DACL on Windows,
      // so it is private there; grant Everyone read to make the tree genuinely broad.
      const systemRoot = process.env.SystemRoot
      if (!systemRoot) throw new Error('SystemRoot missing')
      execFileSync(
        join(systemRoot, 'System32', 'icacls.exe'),
        [join(dataDir, 'artifacts', 'computer-use-meta'), '/grant', '*S-1-1-0:R'],
        { windowsHide: true },
      )
    }
    await expect(scanComputerUseArtifactCandidates(dataDir)).rejects.toThrow(/private|denied|access/i)
  })

  it('dates tombstone-plus-bytes by the later of the tombstone and the file time', async () => {
    const row = await fixture(new TextEncoder().encode('republished'))
    await row.tombstone(0)
    const [candidate] = await scanComputerUseArtifactCandidates(row.dataDir)
    expect(candidate?.createdAtMs).toBeGreaterThan(Date.now() - 60_000)
    const future = Date.now() + 3_600_000
    await row.tombstone(future)
    await expect(scanComputerUseArtifactCandidates(row.dataDir)).resolves.toMatchObject([
      { createdAtMs: future },
    ])
  })

  it('rejects a version 2 marker whose keys are out of order', async () => {
    const row = await fixture(new TextEncoder().encode('reordered'))
    const path = computerUseMarkerPath(row.dataDir, row.sha256)
    await writeFile(
      path,
      `${JSON.stringify({ schemaVersion: 2, sha256: row.sha256, createdAtMs: 0, size: 9, collectedAtMs: 1 }, null, 2)}\n`,
    )
    await expect(scanComputerUseArtifactCandidates(row.dataDir)).rejects.toThrow(/metadata/)
  })

  it('removes both kinds of crashed marker-write temporaries and still refuses other names', async () => {
    const row = await fixture(new TextEncoder().encode('temporaries'))
    const posix = join(row.metadataDirectory, `.${randomUUID()}.tmp`)
    const windows = join(row.metadataDirectory, `${row.sha256}.json.${randomUUID()}.tmp`)
    for (const path of [posix, windows]) {
      await writeFile(path, 'partial', { mode: 0o600 })
      await chmod(path, 0o600)
    }
    await expect(scanComputerUseArtifactCandidates(row.dataDir)).resolves.toHaveLength(1)
    expect(existsSync(posix) || existsSync(windows)).toBe(false)
    expect(await readdir(row.metadataDirectory)).toEqual([`${row.sha256}.json`])
    await writeFile(join(row.metadataDirectory, `${row.sha256}.json.tmp`), 'x', { mode: 0o600 })
    await expect(scanComputerUseArtifactCandidates(row.dataDir)).rejects.toThrow(/unsafe entry/)
  })

  it('does not read the marker of a digest whose bytes are gone', async () => {
    const row = await fixture(new TextEncoder().encode('reclaimed'))
    await unlink(join(row.artifactDirectory, row.sha256))
    // Unparseable on purpose: reading it would fail the scan.
    await writeFile(computerUseMarkerPath(row.dataDir, row.sha256), 'not json', { mode: 0o600 })
    await expect(scanComputerUseArtifactCandidates(row.dataDir)).resolves.toEqual([])
  })
})
