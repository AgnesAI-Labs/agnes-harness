import { describe, expect, it, vi } from 'vitest'
import { authorizeMacOSArtifactGcExecution } from '../../../src/index.js'
import { prepareArtifactGcExecutionPrerequisite } from '../src/gc-execution-prerequisite.js'
import {
  type ArtifactGcExecutionLease,
  authorizeWindowsArtifactGcExecution,
  executeArtifactGc,
} from '../src/gc-executor.js'
import { artifactStorePath } from '../src/reachability.js'

const sha256 = 'b'.repeat(64)
const dataDir = process.platform === 'win32' ? 'C:\\agnes-data' : '/var/lib/agnes'
const prerequisite = prepareArtifactGcExecutionPrerequisite({
  dataDir,
  reachabilitySnapshot: { epoch: 'epoch-1', hash: 'c'.repeat(64) },
  plan: {
    mode: 'dry-run',
    blocked: false,
    issues: [],
    kept: [],
    eligibleForDeletion: [{ sha256, path: artifactStorePath(dataDir, sha256), reachableFrom: [] }],
  },
})
const permit = authorizeWindowsArtifactGcExecution(prerequisite, true)

describe('artifact GC physical executor', () => {
  it('deletes only while the owner holds the exact reachability snapshot lease', async () => {
    const physicalDelete = vi.fn(() => 42)
    const snapshots: unknown[] = []
    const lease = {
      async withCurrentSnapshot<T>(snapshot: unknown, run: () => Promise<T>): Promise<T> {
        snapshots.push(snapshot)
        return run()
      },
    }

    await expect(executeArtifactGc(permit, lease, physicalDelete)).resolves.toEqual({
      planHash: prerequisite.planHash,
      deleted: [{ sha256, bytes: 42 }],
    })
    expect(snapshots).toEqual([prerequisite.reachabilitySnapshot])
    expect(physicalDelete).toHaveBeenCalledWith(
      expect.stringMatching(/artifacts[\\/]sha256$/),
      `bb/${sha256}`,
      sha256,
    )
  })

  it('does not touch disk when the reachability snapshot is stale', async () => {
    const physicalDelete = vi.fn(() => 42)
    const stale = new Error('stale roots')
    await expect(
      executeArtifactGc(
        permit,
        {
          withCurrentSnapshot: async () => {
            throw stale
          },
        },
        physicalDelete,
      ),
    ).rejects.toBe(stale)
    expect(physicalDelete).not.toHaveBeenCalled()
  })

  it('stops immediately on a changed path or invalid native receipt', async () => {
    const lease = { withCurrentSnapshot: async <T>(_snapshot: unknown, run: () => Promise<T>) => run() }
    await expect(
      executeArtifactGc(
        { ...permit, candidates: [{ sha256, rootRelativePath: `artifacts/sha256/aa/${sha256}` }] },
        lease,
        () => 1,
      ),
    ).rejects.toThrow('prerequisite is invalid')
    await expect(executeArtifactGc(permit, lease, () => Number.NaN)).rejects.toThrow('invalid byte count')
  })

  it('never treats the blocked dry-run prerequisite itself as deletion authority', async () => {
    const lease = { withCurrentSnapshot: async <T>(_snapshot: unknown, run: () => Promise<T>) => run() }
    const physicalDelete = vi.fn(() => 1)
    await expect(executeArtifactGc(prerequisite as never, lease, physicalDelete)).rejects.toThrow(
      'prerequisite is invalid',
    )
    expect(physicalDelete).not.toHaveBeenCalled()
    expect(() => authorizeWindowsArtifactGcExecution(prerequisite, false)).toThrow('unavailable')
  })

  it('rejects structural prerequisite and permit forgeries before acquiring a lease or deleting', async () => {
    const forgedPrerequisite = { ...prerequisite }
    expect(() => authorizeWindowsArtifactGcExecution(forgedPrerequisite, true)).toThrow(
      'prerequisite is invalid',
    )

    const withCurrentSnapshot = vi.fn()
    const lease: ArtifactGcExecutionLease = {
      async withCurrentSnapshot<T>(snapshot: unknown, run: () => Promise<T>): Promise<T> {
        withCurrentSnapshot(snapshot)
        return run()
      },
    }
    const physicalDelete = vi.fn(() => 1)
    await expect(executeArtifactGc({ ...permit }, lease, physicalDelete)).rejects.toThrow(
      'prerequisite is invalid',
    )
    expect(withCurrentSnapshot).not.toHaveBeenCalled()
    expect(physicalDelete).not.toHaveBeenCalled()
  })

  it('uses a distinct reviewed authority for the macOS openat/unlinkat primitive', async () => {
    const macPermit = authorizeMacOSArtifactGcExecution(prerequisite, true)
    expect(macPermit.authority).toBe('macos-openat-unlinkat-v1')
    await expect(
      executeArtifactGc(
        macPermit,
        { withCurrentSnapshot: async <T>(_snapshot: unknown, run: () => Promise<T>) => run() },
        () => 7,
      ),
    ).resolves.toMatchObject({ deleted: [{ sha256, bytes: 7 }] })
  })
})
