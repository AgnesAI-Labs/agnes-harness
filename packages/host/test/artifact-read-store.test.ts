import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_RECLAIMED_FAILURE,
  createLocalArtifactReadStore,
  LOCAL_ARTIFACT_READ_MAX_BYTES,
} from '../src/artifact-read-store.js'
import { computerUseMarkerPath } from '../src/computer-use-marker.js'
import { createPrivateArtifactStore, writeComputerUseTombstoneLocked } from '../src/private-artifact-store.js'

/** A hook run before the store's own `lstat` / `open` of a path, to race a collector against it. */
const race = vi.hoisted(() => ({
  before: undefined as undefined | ((operation: 'lstat' | 'open', path: string) => Promise<void>),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: (async (path: string, ...rest: unknown[]) => {
      await race.before?.('lstat', String(path))
      return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.lstat,
    open: (async (path: string, ...rest: unknown[]) => {
      await race.before?.('open', String(path))
      return (actual.open as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.open,
  }
})

const roots: string[] = []
afterEach(async () => {
  race.before = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(text = 'production artifact bytes') {
  const dataDir =
    process.platform === 'win32'
      ? join(tmpdir(), `agnes-artifact-read-store-${randomUUID()}`)
      : await mkdtemp(join(tmpdir(), 'agnes-artifact-read-store-'))
  if (process.platform === 'win32') {
    createPrivateDirectorySync(dataDir)
    windowsEnsurePrivateDirectorySync(join(dataDir, 'artifacts'))
  }
  roots.push(dataDir)
  const bytes = new TextEncoder().encode(text)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2))
  const path = join(directory, sha256)
  await mkdir(directory, { recursive: true })
  await writeFile(path, bytes)
  return {
    dataDir,
    bytes,
    path,
    ref: Object.freeze({ sha256, size: bytes.byteLength, mime: 'application/octet-stream' }),
  }
}

describe('local production artifact read store', () => {
  it('reads the exact Base content-addressed layout and returns an independent copy', async () => {
    const item = await fixture()
    const store = createLocalArtifactReadStore({ dataDir: item.dataDir, maxArtifactBytes: 1024 })
    const read = await store.get(item.ref, new AbortController().signal)
    expect(read).toEqual(item.bytes)
    read[0] = 0
    expect(await store.get(item.ref, new AbortController().signal)).toEqual(item.bytes)
  })

  it('fails closed for malformed identities without evaluating accessors', async () => {
    const item = await fixture()
    const store = createLocalArtifactReadStore({ dataDir: item.dataDir, maxArtifactBytes: 1024 })
    let touched = false
    const hostile = Object.defineProperty({ size: item.ref.size, mime: item.ref.mime }, 'sha256', {
      enumerable: true,
      get() {
        touched = true
        return item.ref.sha256
      },
    })
    await expect(store.get(hostile as never, new AbortController().signal)).rejects.toThrow(
      'artifact bytes unavailable',
    )
    expect(touched).toBe(false)
    await expect(
      store.get({ ...item.ref, sha256: '../../sessions.db' }, new AbortController().signal),
    ).rejects.toThrow('artifact bytes unavailable')
    const signal = new Proxy(new AbortController().signal, {
      get() {
        throw new Error('credential-shaped signal detail')
      },
    })
    await expect(store.get(item.ref, signal)).rejects.toThrow('artifact bytes unavailable')
  })

  it('rejects oversize, tampered, linked and aborted reads with one fixed error', async () => {
    const item = await fixture()
    const store = createLocalArtifactReadStore({ dataDir: item.dataDir, maxArtifactBytes: item.bytes.length })
    await expect(
      store.get({ ...item.ref, size: item.bytes.length + 1 }, new AbortController().signal),
    ).rejects.toThrow('artifact bytes unavailable')

    await writeFile(item.path, 'tampered')
    await expect(store.get(item.ref, new AbortController().signal)).rejects.toThrow(
      'artifact bytes unavailable',
    )

    await rm(item.path)
    const target = join(item.dataDir, 'elsewhere')
    if (process.platform === 'win32') {
      await mkdir(target)
      // A directory junction is a real Windows reparse-point attack fixture and does not require
      // Developer Mode or elevation like a file symlink does.
      await symlink(target, item.path, 'junction')
    } else {
      await writeFile(target, item.bytes)
      await symlink(target, item.path)
    }
    await expect(store.get(item.ref, new AbortController().signal)).rejects.toThrow(
      'artifact bytes unavailable',
    )

    const controller = new AbortController()
    controller.abort()
    await expect(store.get(item.ref, controller.signal)).rejects.toThrow('artifact bytes unavailable')
  })

  it('requires a bounded absolute trusted root', () => {
    for (const input of [
      { dataDir: 'relative', maxArtifactBytes: 1 },
      { dataDir: '/tmp/data', maxArtifactBytes: -1 },
      { dataDir: '/tmp/data', maxArtifactBytes: LOCAL_ARTIFACT_READ_MAX_BYTES + 1 },
    ])
      expect(() => createLocalArtifactReadStore(input)).toThrow('artifact bytes unavailable')
  })

  it('refuses artifact identities above the RPC frame ceiling before opening bytes', async () => {
    const item = await fixture()
    const store = createLocalArtifactReadStore({
      dataDir: item.dataDir,
      maxArtifactBytes: LOCAL_ARTIFACT_READ_MAX_BYTES,
    })
    await expect(
      store.get({ ...item.ref, size: LOCAL_ARTIFACT_READ_MAX_BYTES + 1 }, new AbortController().signal),
    ).rejects.toThrow('artifact bytes unavailable')
  })

  it('tells a screenshot reclaimed by retention apart from a missing one', async () => {
    const item = await fixture('reclaimed screenshot')
    const platform = process.platform === 'win32' ? 'win32' : 'darwin'
    const tombstone = (size: number) =>
      writeComputerUseTombstoneLocked(item.dataDir, platform, {
        sha256: item.ref.sha256,
        size,
        createdAtMs: 0,
        collectedAtMs: 1,
      })
    const store = createLocalArtifactReadStore({ dataDir: item.dataDir, maxArtifactBytes: 1024 })
    const signal = new AbortController().signal
    const image = { sha256: item.ref.sha256, mime: 'image/png' }
    await tombstone(item.bytes.byteLength)
    // Bytes present win over the tombstone.
    await expect(store.get(item.ref, signal)).resolves.toEqual(item.bytes)
    await rm(item.path)
    await expect(store.inspect(image, signal)).resolves.toEqual({ ...image, size: item.bytes.byteLength })
    await expect(store.get(item.ref, signal)).rejects.toBe(ARTIFACT_RECLAIMED_FAILURE)
    // A tombstone claiming more than the read ceiling is not trusted for a reference.
    await tombstone(2048)
    await expect(store.inspect(image, signal)).rejects.toThrow('artifact bytes unavailable')
    // A version 1 marker without bytes is an ordinary missing artifact.
    await rm(computerUseMarkerPath(item.dataDir, item.ref.sha256))
    await createPrivateArtifactStore(item.dataDir, platform).putComputerUseMetadata(
      item.ref.sha256,
      new TextEncoder().encode(
        `${JSON.stringify({ schemaVersion: 1, sha256: item.ref.sha256, size: item.bytes.byteLength, createdAtMs: 0 }, null, 2)}\n`,
      ),
    )
    const missing = store.get(item.ref, signal)
    await expect(missing).rejects.toThrow('artifact bytes unavailable')
    await expect(missing).rejects.not.toBe(ARTIFACT_RECLAIMED_FAILURE)
    await expect(store.inspect(image, signal)).rejects.toThrow('artifact bytes unavailable')
  })

  it('treats a missing artifact without any marker as an ordinary failure', async () => {
    const item = await fixture('never classified')
    await rm(item.path)
    const store = createLocalArtifactReadStore({ dataDir: item.dataDir, maxArtifactBytes: 1024 })
    const read = store.get(item.ref, new AbortController().signal)
    await expect(read).rejects.toThrow('artifact bytes unavailable')
    await expect(read).rejects.not.toBe(ARTIFACT_RECLAIMED_FAILURE)
  })

  describe('when a collector reclaims the bytes in the middle of a read', () => {
    async function reclaimable() {
      const item = await fixture('screenshot reclaimed mid-read')
      await writeComputerUseTombstoneLocked(item.dataDir, process.platform === 'win32' ? 'win32' : 'darwin', {
        sha256: item.ref.sha256,
        size: item.bytes.byteLength,
        createdAtMs: 0,
        collectedAtMs: 1,
      })
      const store = createLocalArtifactReadStore({ dataDir: item.dataDir, maxArtifactBytes: 1024 })
      /** Unlinks the bytes right before the `nth` matching operation on them. */
      const unlinkBefore = (operation: 'lstat' | 'open', nth = 1) => {
        let seen = 0
        race.before = async (op, path) => {
          if (op !== operation || path !== item.path) return
          seen += 1
          if (seen === nth) await rm(item.path)
        }
      }
      return { item, store, unlinkBefore, image: { sha256: item.ref.sha256, mime: 'image/png' } }
    }

    it('get reports reclaimed when the bytes vanish between its lstat and open', async () => {
      const { item, store, unlinkBefore } = await reclaimable()
      unlinkBefore('open')
      await expect(store.get(item.ref, new AbortController().signal)).rejects.toBe(ARTIFACT_RECLAIMED_FAILURE)
    })

    it('inspect returns the reclaimed reference when its byte check loses the race', async () => {
      const { item, store, unlinkBefore, image } = await reclaimable()
      unlinkBefore('open')
      await expect(store.inspect(image, new AbortController().signal)).resolves.toEqual({
        ...image,
        size: item.bytes.byteLength,
      })
      const again = await reclaimable()
      // Second lstat: the one inside the byte check, after inspect saw the bytes.
      again.unlinkBefore('lstat', 2)
      await expect(again.store.inspect(again.image, new AbortController().signal)).resolves.toEqual({
        ...again.image,
        size: again.item.bytes.byteLength,
      })
    })

    it('still fails closed when the bytes vanish without a tombstone', async () => {
      const item = await fixture('lost mid-read')
      const store = createLocalArtifactReadStore({ dataDir: item.dataDir, maxArtifactBytes: 1024 })
      race.before = async (op, path) => {
        if (op === 'open' && path === item.path) await rm(item.path)
      }
      const read = store.get(item.ref, new AbortController().signal)
      await expect(read).rejects.toThrow('artifact bytes unavailable')
      await expect(read).rejects.not.toBe(ARTIFACT_RECLAIMED_FAILURE)
    })

    it('inspect of a reclaimed screenshot honours an aborted signal', async () => {
      const { item, store, image } = await reclaimable()
      await rm(item.path)
      const controller = new AbortController()
      controller.abort()
      await expect(store.inspect(image, controller.signal)).rejects.toThrow('artifact bytes unavailable')
    })
  })
})
