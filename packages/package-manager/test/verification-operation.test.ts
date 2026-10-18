import { AsyncResource } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import { verifiedDirectoryDigest, withoutPackageVerification, withPackageVerification } from '../src/index.js'
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
    symlinkSync(join(moved, 'payload'), join(dir, 'payload'))
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
