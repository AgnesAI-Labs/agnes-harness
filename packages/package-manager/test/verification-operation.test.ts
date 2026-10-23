import { AsyncResource } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import {
  invalidatePackageVerification,
  verifiedDirectoryDigest,
  verifiedDirectoryDigestAsync,
  withoutPackageVerification,
  withPackageVerification,
} from '../src/index.js'
import * as sources from '../src/sources.js'
import { hashDirectory } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agh-operation-'))
  roots.push(dir)
  writeFileSync(join(dir, 'payload'), 'first')
  return {
    dir,
    identity: {
      version: '1.0.0',
      integrity: hashDirectory(dir),
      treeIntegrity: hashDirectory(dir, { exclude: [] }),
      capabilityHash: 'a'.repeat(64),
    },
  }
}

// Review probes: inherited async resources must lose the observation at both exit paths.
it.each(['resolve', 'reject'] as const)(
  'closes inherited timers, promises, emitters and ports after %s',
  async (exit) => {
    const { dir, identity } = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let deferred!: Promise<unknown[]>
    let emit!: () => void
    let post!: () => void
    let ports!: MessageChannel
    const operation = withPackageVerification(async () => {
      verifiedDirectoryDigest(dir, identity)
      const emitter = new EventEmitter()
      ports = new MessageChannel()
      deferred = Promise.all([
        gate.then(() => verifiedDirectoryDigest(dir, identity)),
        gate.then(
          () =>
            new Promise<string>((resolve) =>
              setTimeout(() => resolve(verifiedDirectoryDigest(dir, identity)), 0),
            ),
        ),
        new Promise<string>((resolve) =>
          emitter.once('next', () => resolve(verifiedDirectoryDigest(dir, identity))),
        ),
        new Promise<string>((resolve) =>
          ports.port1.once('message', () => resolve(verifiedDirectoryDigest(dir, identity))),
        ),
      ])
      emit = AsyncResource.bind(() => {
        emitter.emit('next')
      })
      post = () => ports.port2.postMessage('next')
      if (exit === 'reject') throw new Error('probe exit')
    })
    if (exit === 'reject') await expect(operation).rejects.toThrow('probe exit')
    else await operation
    writeFileSync(join(dir, 'payload'), 'other')
    release()
    emit()
    post()
    try {
      for (const digest of await deferred) expect(digest).not.toBe(identity.treeIntegrity)
    } finally {
      ports.port1.close()
      ports.port2.close()
    }
  },
)

it('isolates overlapping top-level requests even while the first memo is alive', async () => {
  const { dir, identity } = fixture()
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const first = withPackageVerification(async () => {
    verifiedDirectoryDigest(dir, identity)
    started()
    await gate
  })
  await ready
  writeFileSync(join(dir, 'payload'), 'other')
  try {
    await withPackageVerification(async () =>
      expect(verifiedDirectoryDigest(dir, identity)).not.toBe(identity.treeIntegrity),
    )
  } finally {
    release()
    await first
  }
})

it('reuses only an exact identity in one operation, never a different version, digest or next operation', async () => {
  const { dir, identity } = fixture(),
    hash = vi.spyOn(sources, 'hashDirectory')
  await withPackageVerification(async () => {
    expect(verifiedDirectoryDigest(dir, identity)).toBe(identity.treeIntegrity)
    expect(verifiedDirectoryDigest(dir, identity)).toBe(identity.treeIntegrity)
    expect(hash).toHaveBeenCalledTimes(1)
    verifiedDirectoryDigest(dir, { ...identity, version: '2.0.0' })
    verifiedDirectoryDigest(dir, { ...identity, treeIntegrity: `sha256-${'f'.repeat(64)}` })
    expect(hash).toHaveBeenCalledTimes(3)
  })
  await withPackageVerification(async () => {
    verifiedDirectoryDigest(dir, identity)
  })
  expect(hash).toHaveBeenCalledTimes(4)
})

it('reuses a settled tree across opted-in reads until its root is replaced, and nowhere else', async () => {
  const { dir, identity } = fixture(),
    hash = vi.spyOn(sources, 'hashDirectory'),
    hashAsync = vi.spyOn(sources, 'hashDirectoryAsync')
  const settles = { settleTrees: true }
  const read = () =>
    withPackageVerification(async () => verifiedDirectoryDigest(dir, identity, false, true), settles)
  expect(await read()).toBe(identity.treeIntegrity)
  expect(await read()).toBe(identity.treeIntegrity)
  expect(
    await withPackageVerification(() => verifiedDirectoryDigestAsync(dir, identity, false, true), settles),
  ).toBe(identity.treeIntegrity)
  expect(hash).toHaveBeenCalledTimes(1)
  expect(hashAsync).not.toHaveBeenCalled()
  // Reads that do not opt in, trees that are not AGH-stored and write gates keep hashing every time.
  await withPackageVerification(async () => verifiedDirectoryDigest(dir, identity, false, true))
  await withPackageVerification(async () => verifiedDirectoryDigest(dir, identity), settles)
  withoutPackageVerification(() => verifiedDirectoryDigest(dir, identity, false, true))
  expect(hash).toHaveBeenCalledTimes(4)
  // Installs and updates replace the whole directory; a replaced root is hashed again.
  const next = `${dir}-next`
  roots.push(next)
  mkdirSync(next)
  writeFileSync(join(next, 'payload'), 'other')
  rmSync(dir, { recursive: true })
  renameSync(next, dir)
  expect(await read()).not.toBe(identity.treeIntegrity)
  expect(hash).toHaveBeenCalledTimes(5)
})

it('forgets settled trees when a read is invalidated', async () => {
  const { dir, identity } = fixture(),
    hash = vi.spyOn(sources, 'hashDirectory')
  const read = () =>
    withPackageVerification(async () => verifiedDirectoryDigest(dir, identity, false, true), {
      settleTrees: true,
    })
  await read()
  invalidatePackageVerification()
  await read()
  expect(hash).toHaveBeenCalledTimes(2)
})

it.each(['synchronous', 'asynchronous'] as const)(
  'a %s write forces independent verification and invalidates its parent read',
  async (kind) => {
    const { dir, identity } = fixture()
    await withPackageVerification(async () => {
      verifiedDirectoryDigest(dir, identity)
      const change = () => {
        writeFileSync(join(dir, 'payload'), 'other')
        expect(verifiedDirectoryDigest(dir, identity)).not.toBe(identity.treeIntegrity)
      }
      await (kind === 'synchronous'
        ? withoutPackageVerification(change)
        : withoutPackageVerification(async () => {
            await Promise.resolve()
            change()
          }))
      expect(verifiedDirectoryDigest(dir, identity)).not.toBe(identity.treeIntegrity)
    })
  },
)

it('canonicalizes an ancestor alias on each hit and refuses a directory retargeted to a link', async () => {
  const { dir, identity } = fixture()
  const alias = `${dir}-alias`,
    moved = join(dir, 'moved')
  roots.push(alias)
  symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await withPackageVerification(async () => {
    verifiedDirectoryDigest(dir, identity)
    // The directory root itself is never accepted through a symbolic link or junction.
    expect(() => verifiedDirectoryDigest(alias, identity)).toThrow(/symbolic link/)
    mkdirSync(moved)
    renameSync(join(dir, 'payload'), join(moved, 'payload'))
    // A directory link exercises the same traversal refusal and works without Windows file-link privileges.
    symlinkSync(moved, join(dir, 'payload'), process.platform === 'win32' ? 'junction' : 'dir')
    // A pre-execution/write gate must reject a link introduced after the read observation.
    expect(() => withoutPackageVerification(() => verifiedDirectoryDigest(dir, identity))).toThrow(
      /symbolic link/,
    )
    unlinkSync(join(dir, 'payload'))
    // An ancestor alias is allowed, but retargeting it changes the canonical key immediately.
    mkdirSync(join(dir, 'first', 'tree'), { recursive: true })
    mkdirSync(join(dir, 'second', 'tree'), { recursive: true })
    writeFileSync(join(dir, 'first', 'tree', 'data'), 'first')
    writeFileSync(join(dir, 'second', 'tree', 'data'), 'other')
    const ancestor = `${dir}-ancestor`
    roots.push(ancestor)
    symlinkSync(join(dir, 'first'), ancestor, process.platform === 'win32' ? 'junction' : 'dir')
    const digest = hashDirectory(join(ancestor, 'tree'))
    const expected = { ...identity, integrity: digest, treeIntegrity: digest }
    expect(verifiedDirectoryDigest(join(ancestor, 'tree'), expected)).toBe(digest)
    unlinkSync(ancestor)
    symlinkSync(join(dir, 'second'), ancestor, process.platform === 'win32' ? 'junction' : 'dir')
    expect(verifiedDirectoryDigest(join(ancestor, 'tree'), expected)).not.toBe(digest)
    const currentDigest = hashDirectory(dir)
    const current = { ...identity, integrity: currentDigest, treeIntegrity: currentDigest }
    verifiedDirectoryDigest(dir, current)
    const replaced = `${dir}-replaced`
    roots.push(replaced)
    renameSync(dir, replaced)
    writeFileSync(dir, 'not a directory')
    expect(() => verifiedDirectoryDigest(dir, current)).toThrow(/not a directory/)
  })
})

it('shares pending async verification, retries failures/mismatches and isolates the next operation', async () => {
  const { dir, identity } = fixture()
  const hash = vi.spyOn(sources, 'hashDirectoryAsync')
  await withPackageVerification(async () => {
    expect(
      await Promise.all(Array.from({ length: 4 }, () => verifiedDirectoryDigestAsync(dir, identity))),
    ).toEqual(Array(4).fill(identity.treeIntegrity))
    expect(hash).toHaveBeenCalledTimes(1)
    expect(verifiedDirectoryDigest(dir, identity)).toBe(identity.treeIntegrity)
    invalidatePackageVerification()
    hash.mockRejectedValueOnce(new Error('read failed'))
    await expect(verifiedDirectoryDigestAsync(dir, identity)).rejects.toThrow('read failed')
    expect(await verifiedDirectoryDigestAsync(dir, identity)).toBe(identity.treeIntegrity)
    const mismatch = { ...identity, treeIntegrity: 'sha256-wrong' }
    await verifiedDirectoryDigestAsync(dir, mismatch)
    await verifiedDirectoryDigestAsync(dir, mismatch)
    expect(hash).toHaveBeenCalledTimes(5)
  })
  await withPackageVerification(() => verifiedDirectoryDigestAsync(dir, identity))
  expect(hash).toHaveBeenCalledTimes(6)
})

it.each(['invalidate', 'write', 'resolve', 'reject'] as const)(
  'a late async result cannot repopulate an operation after %s',
  async (exit) => {
    const { dir, identity } = fixture()
    let release!: (digest: string) => void
    const hash = vi.spyOn(sources, 'hashDirectoryAsync').mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    let pending!: Promise<string>
    let inherited!: () => Promise<string>
    const operation = withPackageVerification(async () => {
      inherited = AsyncResource.bind(() => verifiedDirectoryDigestAsync(dir, identity))
      pending = verifiedDirectoryDigestAsync(dir, identity)
      if (exit === 'invalidate') invalidatePackageVerification()
      if (exit === 'write') withoutPackageVerification(() => {})
      if (exit === 'resolve' || exit === 'reject') {
        if (exit === 'reject') throw new Error('ended')
        return
      }
      let releaseNew!: (digest: string) => void
      hash.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseNew = resolve
          }),
      )
      const newer = verifiedDirectoryDigestAsync(dir, identity)
      release(identity.treeIntegrity)
      await pending
      // The old finally must not delete the newer epoch's pending work or populate its memo.
      const joined = verifiedDirectoryDigestAsync(dir, identity)
      let settled = false
      void joined.then(() => {
        settled = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(hash).toHaveBeenCalledTimes(2)
      releaseNew(identity.treeIntegrity)
      expect(await Promise.all([newer, joined])).toEqual([identity.treeIntegrity, identity.treeIntegrity])
      invalidatePackageVerification()
      writeFileSync(join(dir, 'payload'), 'other')
      expect(await inherited()).not.toBe(identity.treeIntegrity)
    })
    if (exit === 'reject') await expect(operation).rejects.toThrow('ended')
    else await operation
    if (exit === 'resolve' || exit === 'reject') {
      release(identity.treeIntegrity)
      await pending
      writeFileSync(join(dir, 'payload'), 'other')
      expect(await inherited()).not.toBe(identity.treeIntegrity)
    }
    expect(hash.mock.calls.length).toBeGreaterThanOrEqual(2)
  },
)

it('checks root links, type and ancestor retargeting on every async memo/pending access', async () => {
  const { dir, identity } = fixture()
  const alias = `${dir}-alias`,
    moved = `${dir}-moved`
  roots.push(alias, moved)
  await withPackageVerification(async () => {
    expect(await verifiedDirectoryDigestAsync(dir, identity)).toBe(identity.treeIntegrity)
    symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(verifiedDirectoryDigestAsync(alias, identity)).rejects.toThrow(/symbolic link/)
    renameSync(dir, moved)
    symlinkSync(moved, dir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(verifiedDirectoryDigestAsync(dir, identity)).rejects.toThrow(/symbolic link/)
    unlinkSync(dir)
    writeFileSync(dir, 'not a directory')
    await expect(verifiedDirectoryDigestAsync(dir, identity)).rejects.toThrow(/not a directory/)
    unlinkSync(dir)
    mkdirSync(dir)
    mkdirSync(join(dir, 'tree'))
    writeFileSync(join(dir, 'tree', 'payload'), 'first')
    unlinkSync(alias)
    symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const digest = hashDirectory(join(dir, 'tree'), { exclude: [] })
    const expected = { ...identity, treeIntegrity: digest }
    expect(await verifiedDirectoryDigestAsync(join(alias, 'tree'), expected)).toBe(digest)
    unlinkSync(alias)
    mkdirSync(join(moved, 'tree'))
    writeFileSync(join(moved, 'tree', 'payload'), 'other')
    symlinkSync(moved, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await verifiedDirectoryDigestAsync(join(alias, 'tree'), expected)).not.toBe(digest)
  })
})
