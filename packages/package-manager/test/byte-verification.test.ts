import * as syncFs from 'node:fs'
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PackageByteVerification, packageByteBinding } from '../src/byte-verification.js'
import { collectRead, collectReadAsync, directoryDigestSteps } from '../src/cooperative-read.js'
import { PackageError } from '../src/errors.js'
import { loadPackagePlugins, preflightPackagePluginsAsync } from '../src/package-plugin-loader.js'
import * as sources from '../src/sources.js'
import * as trees from '../src/tree-identity.js'
import { verifiedDirectoryDigestAsync, withoutPackageVerification } from '../src/verification-operation.js'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }))
const actualVolumeSupport = trees.supportsTreeIdentity

let root: string, directory: string, file: string
let now: number, wall: number
const owners: PackageByteVerification[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-byte-owner-'))
  directory = join(root, 'packages/payload')
  mkdirSync(directory, { recursive: true })
  file = join(directory, 'a.mjs')
  writeFileSync(file, 'GOOD')
  writeFileSync(join(directory, 'z.mjs'), 'TAIL')
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'acme/test',
      version: '1.0.0',
      agnes: { plugins: [{ export: 'main', apiRange: '^4.0.0' }] },
    }),
  )
  now = 0
  wall = 1_000_000
  // Unsupported platforms retain production fallback coverage in the explicit fallback case.
  vi.spyOn(trees, 'supportsTreeIdentity').mockReturnValue(true)
})
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  await setImmediate()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function identity() {
  const digest = sources.hashDirectory(directory, { exclude: [] })
  return { version: '1.0.0', integrity: digest, treeIntegrity: digest, capabilityHash: 'a'.repeat(64) }
}
function owner(options: Partial<ConstructorParameters<typeof PackageByteVerification>[0]> = {}) {
  const value = new PackageByteVerification({
    profileDir: root,
    roots: [root],
    now: () => now,
    wallNow: () => wall,
    quietMs: 0,
    ...options,
  })
  owners.push(value)
  return value
}
const read = (authority: PackageByteVerification, expected: ReturnType<typeof identity>) =>
  authority.run(() => collectReadAsync(directoryDigestSteps(directory, expected)))

it('keeps racy timestamps full-only until a later full pass proves a quiet tree', async () => {
  wall = Date.now()
  const expected = identity(),
    authority = owner({ quietMs: 1000 }),
    hash = vi.spyOn(sources, 'hashDirectoryAsync')
  await read(authority, expected)
  await read(authority, expected)
  expect(hash.mock.calls.length).toBe(2)
  now += 1100
  wall += 1100
  await read(authority, expected)
  await read(authority, expected)
  expect(hash.mock.calls.length).toBe(3)
})

it('uses stable observations across reads, while public full and write/fresh gates read actual bytes', async () => {
  const expected = identity(),
    authority = owner(),
    hash = vi.spyOn(sources, 'hashDirectoryAsync')
  expect(await read(authority, expected)).toBe(expected.treeIntegrity)
  const calls = hash.mock.calls.length
  expect(authority.run(() => collectRead(directoryDigestSteps(directory, expected)))).toBe(
    expected.treeIntegrity,
  )
  expect(await read(authority, expected)).toBe(expected.treeIntegrity)
  expect(hash.mock.calls.length).toBe(calls)
  expect(await authority.read(realpathSync(directory), expected)).toBe(expected.treeIntegrity)
  expect(hash.mock.calls.length).toBe(calls)
  const frozen = await trees.treeIdentity(directory)
  vi.spyOn(trees, 'treeIdentity').mockResolvedValue(frozen)
  writeFileSync(file, 'EVIL')
  expect(await read(authority, expected)).toBe(expected.treeIntegrity) // Accepted same-identity risk.
  expect(await authority.run(() => verifiedDirectoryDigestAsync(directory, expected))).not.toBe(
    expected.treeIntegrity,
  )
  expect(
    await authority.run(() =>
      withoutPackageVerification(() => collectReadAsync(directoryDigestSteps(directory, expected))),
    ),
  ).not.toBe(expected.treeIntegrity)
})

it('rechecks an earlier file at the end of a hit and refuses before the bad module sentinel runs', async () => {
  const expected = identity(),
    authority = owner()
  await read(authority, expected)
  const before = statSync(file),
    parent = statSync(directory),
    original = fs.lstat
  let changed = false
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (!changed && args[0] === join(realpathSync(directory), 'z.mjs')) {
      await setImmediate()
      changed = true
      writeFileSync(file, 'EVIL')
      utimesSync(file, before.atime, before.mtime)
    }
    return original(...args)
  })
  const imported = vi.fn(async () => ({}))
  await expect(
    authority.run(() =>
      loadPackagePlugins({
        snapshot: {
          ...expected,
          snapshotId: expected.integrity,
          profile: 'p',
          packageId: 'acme/test',
          directory,
          contributions: [],
        },
        generation: 1,
        importModule: imported,
      }),
    ),
  ).rejects.toThrow()
  expect(changed).toBe(true)
  expect(statSync(file).ctimeMs).not.toBe(before.ctimeMs)
  expect(statSync(directory).mtimeMs).toBe(parent.mtimeMs)
  expect(imported).not.toHaveBeenCalled()
})

it.each(['size', 'mtime', 'delete', 'rename', 'empty-directory', 'same-count-rename', 'hardlink', 'symlink'])(
  'reverifies changes to %s instead of refreshing the observed identity',
  async (kind) => {
    const expected = identity(),
      authority = owner(),
      hash = vi.spyOn(sources, 'hashDirectoryAsync')
    await read(authority, expected)
    const calls = hash.mock.calls.length
    if (kind === 'delete') rmSync(file)
    if (kind === 'size') writeFileSync(file, 'changed size')
    if (kind === 'mtime') {
      const s = statSync(file)
      utimesSync(file, s.atime, new Date(s.mtimeMs + 2000))
    }
    if (kind === 'rename') {
      writeFileSync(join(root, 'replacement'), 'EVIL')
      renameSync(join(root, 'replacement'), file)
    }
    if (kind === 'empty-directory') mkdirSync(join(directory, 'empty'))
    if (kind === 'same-count-rename') renameSync(join(directory, 'z.mjs'), join(directory, 'y.mjs'))
    if (kind === 'hardlink') linkSync(file, join(root, 'alias'))
    if (kind === 'symlink') {
      rmSync(file)
      symlinkSync(join(directory, 'z.mjs'), file)
    }
    const result = await read(authority, expected).catch(() => undefined)
    if (['mtime', 'empty-directory', 'hardlink'].includes(kind)) expect(result).toBe(expected.treeIntegrity)
    else expect(result).not.toBe(expected.treeIntegrity)
    expect(hash.mock.calls.length).toBeGreaterThan(calls)
  },
)

it('background full detects sustained tampering with every identity field frozen and seals later reads', async () => {
  const fault = vi.fn(),
    expected = identity(),
    authority = owner({ onMismatch: fault, softMs: 10 })
  await read(authority, expected)
  const frozen = await trees.treeIdentity(directory)
  vi.spyOn(trees, 'treeIdentity').mockResolvedValue(frozen)
  writeFileSync(file, 'EVIL')
  now = wall = 1_000_001 // Clock doubt first drops the positive.
  await expect(read(authority, expected)).resolves.not.toBe(expected.treeIntegrity)
  await setImmediate()
  expect(fault).toHaveBeenCalled()
})

it('idle rehash bypasses same-identity hits without requiring another foreground read', async () => {
  const fault = vi.fn(),
    expected = identity(),
    authority = owner({ onMismatch: fault, softMs: 10 })
  await read(authority, expected)
  const frozen = await trees.treeIdentity(directory)
  vi.spyOn(trees, 'treeIdentity').mockResolvedValue(frozen)
  writeFileSync(file, 'EVIL')
  now += 11
  wall += 11
  await authority.recheck()
  await setImmediate()
  expect(fault).toHaveBeenCalledWith(
    expect.objectContaining({ directory, binding: packageByteBinding(root) }),
  )
  await expect(read(authority, expected)).rejects.toThrow()
})

it('refuses an ancestor retargeted while the hit walk is awaiting later metadata', async () => {
  const expected = identity(),
    authority = owner()
  await read(authority, expected)
  const old = fs.lstat
  let changed = false
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (!changed && args[0] === join(realpathSync(directory), 'z.mjs')) {
      await setImmediate()
      changed = true
      renameSync(join(root, 'packages'), join(root, 'before'))
      const next = join(root, 'after/payload')
      mkdirSync(next, { recursive: true })
      writeFileSync(join(next, 'a.mjs'), 'EVIL')
      writeFileSync(join(next, 'package.json'), readFileSync(join(root, 'before/payload/package.json')))
      symlinkSync(join(root, 'after'), join(root, 'packages'), 'dir')
    }
    return old(...args)
  })
  await expect(read(authority, expected)).rejects.toThrow()
  expect(changed).toBe(true)
})

it.each(['before', 'at', 'overdue', 'suspend', 'wall-back', 'wall-forward', 'late-tick', 'lru', 'bytes'])(
  'applies expiry to byte reads for %s without refreshing TTL on hits',
  async (kind) => {
    const expected = identity(),
      authority = owner({
        hardMs: 100,
        maxRecords: kind === 'lru' ? 0 : 4096,
        maxBytes: kind === 'bytes' ? 0 : 64 * 1024 * 1024,
      }),
      hash = vi.spyOn(sources, 'hashDirectoryAsync')
    await read(authority, expected)
    const calls = hash.mock.calls.length
    if (kind === 'before') {
      now += 99
      wall += 99
    }
    if (kind === 'at') {
      now += 100
      wall += 100
    }
    if (kind === 'overdue') {
      now += 101
      wall += 101
    }
    if (kind === 'suspend') wall += 3_600_000
    if (kind === 'wall-back') wall -= 2000
    if (kind === 'wall-forward') wall += 2000
    if (kind === 'late-tick') {
      now += 3_600_000
      wall += 3_600_000
    }
    expect(await read(authority, expected)).toBe(expected.treeIntegrity)
    expect(hash.mock.calls.length).toBe(kind === 'before' ? calls : calls + 1)
    if (kind === 'before') {
      now++
      wall++
      expect(await read(authority, expected)).toBe(expected.treeIntegrity)
      expect(hash.mock.calls.length).toBe(calls + 1)
    }
  },
)

it('never accepts another volume, public factory, binding, or arbitrary sidecar as verification authority', async () => {
  const expected = identity(),
    first = owner(),
    hash = vi.spyOn(sources, 'hashDirectoryAsync')
  await read(first, expected)
  writeFileSync(join(root, 'verified.json'), JSON.stringify({ trusted: true, ...expected }))
  const before = hash.mock.calls.length
  expect(await read(owner(), expected)).toBe(expected.treeIntegrity)
  expect(hash.mock.calls.length).toBeGreaterThan(before)
  vi.mocked(trees.supportsTreeIdentity).mockReturnValue(false)
  const after = hash.mock.calls.length
  await read(first, expected)
  await read(first, expected)
  expect(hash.mock.calls.length).toBe(after + 2)
  writeFileSync(join(root, 'agnes-lock.json'), 'changed trust epoch')
  vi.mocked(trees.supportsTreeIdentity).mockReturnValue(true)
  expect(await read(first, expected)).toBe(expected.treeIntegrity)
})

it('uses parent admission only during boot, never as a transferable new full-verification TTL', async () => {
  const expected = identity(),
    parent = owner(),
    hash = vi.spyOn(sources, 'hashDirectoryAsync')
  await read(parent, expected)
  const admission = await parent.admission(),
    child = owner(),
    before = hash.mock.calls.length
  await child.boot(admission, async () => {
    expect(await read(child, expected)).toBe(expected.treeIntegrity)
    await preflightPackagePluginsAsync({
      snapshot: {
        ...expected,
        snapshotId: expected.integrity,
        packageId: 'acme/test',
        profile: 'p',
        directory,
        contributions: [],
      },
      generation: 1,
    })
  })
  expect(hash.mock.calls.length).toBe(before)
  await read(child, expected)
  expect(hash.mock.calls.length).toBe(before + 1)
  const changed = { ...admission, binding: 'wrong-profile' }
  const unadmitted = owner()
  await unadmitted.boot(changed, () => read(unadmitted, expected))
  expect(hash.mock.calls.length).toBeGreaterThan(before + 1)
  const original = trees.treeIdentity
  let invalidate = true
  const walk = vi.spyOn(trees, 'treeIdentity').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (invalidate) {
      invalidate = false
      parent.invalidate()
    }
    return result
  })
  expect((await parent.admission()).trees).toEqual([])
  walk.mockRestore()
})

it.each(['reset', 'grant-aba'])(
  'discards an old success after %s and never refills from that result',
  async (mode) => {
    if (mode === 'grant-aba') writeFileSync(join(root, 'agnes-lock.json'), 'grant A')
    const expected = identity(),
      authority = owner(),
      original = sources.hashDirectoryAsync
    const releases: (() => void)[] = [],
      starts: (() => void)[] = []
    const gates = [0, 1].map((index) => ({
      wait: new Promise<void>((r) => {
        releases[index] = r
      }),
      started: new Promise<void>((r) => {
        starts[index] = r
      }),
    }))
    let count = 0,
      settled = false
    vi.spyOn(sources, 'hashDirectoryAsync').mockImplementation(async (...args) => {
      const index = count++
      if (index < 2) {
        starts[index]!()
        await gates[index]!.wait
      }
      return index === 0 ? expected.treeIntegrity : original(...args)
    })
    const old = read(authority, expected)
    try {
      const outcome = old.then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      void old.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await gates[0]!.started
      if (mode === 'reset') authority.invalidate()
      else {
        writeFileSync(join(root, 'agnes-lock.json'), 'grant B')
        writeFileSync(join(root, 'agnes-lock.json'), 'grant A')
      }
      const newer = read(authority, expected)
      await gates[1]!.started
      releases[0]!()
      await setImmediate()
      if (mode === 'reset') expect(settled).toBe(false)
      else expect(await outcome).toHaveProperty('error.code', 'E_PACKAGE_INTEGRITY')
      const shared = read(authority, expected)
      writeFileSync(file, 'EVIL')
      releases[1]!()
      const actual = await newer
      expect(actual).not.toBe(expected.treeIntegrity)
      if (mode === 'reset') expect(await old).toBe(actual)
      expect(await shared).toBe(actual)
      expect(count).toBe(2)
      await expect(read(authority, expected)).rejects.toThrow()
      await authority.close()
      writeFileSync(file, 'GOOD')
      await expect(read(authority, expected)).rejects.toThrow()
      writeFileSync(join(root, 'agnes-lock.json'), 'new control decision after close')
      expect(await read(authority, expected)).toBe(expected.treeIntegrity)
    } finally {
      releases[0]!()
      releases[1]!()
    }
  },
)

it('drops unavailable evidence and aborts owned work on shutdown without revoking a grant', async () => {
  const expected = identity(),
    fault = vi.fn(),
    authority = owner({ onMismatch: fault, softMs: 0 })
  await read(authority, expected)
  const hash = vi.spyOn(sources, 'hashDirectoryAsync')
  hash.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'EACCES' }))
  await authority.recheck()
  await setImmediate()
  expect(fault).not.toHaveBeenCalled()
  expect(await read(authority, expected)).toBe(expected.treeIntegrity)
  authority.invalidate()
  let started!: () => void
  const ready = new Promise<void>((r) => {
    started = r
  })
  hash.mockImplementationOnce(async (_dir, options) => {
    started()
    await new Promise<void>((_resolve, reject) =>
      options!.signal!.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })),
        { once: true },
      ),
    )
    throw new Error('unreachable')
  })
  const pending = read(authority, expected)
  const rejected = expect(pending).rejects.toThrow('aborted')
  await ready
  await authority.close()
  await rejected
  expect(fault).not.toHaveBeenCalled()
})

it.each(['coarse', 'zero-inode'])(
  'keeps usable content full-only when its volume exposes %s identity',
  async (mode) => {
    const expected = identity(),
      authority = owner(),
      original = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const value = await original(...args)
      if (args[1]?.bigint) {
        const observed = value as import('node:fs').BigIntStats
        return Object.defineProperty(Object.create(value), mode === 'coarse' ? 'ctimeNs' : 'ino', {
          value: mode === 'coarse' ? (observed.ctimeNs / 1_000_000n) * 1_000_000n : 0n,
        })
      }
      return value
    })
    const hash = vi.spyOn(sources, 'hashDirectoryAsync')
    expect(await read(authority, expected)).toBe(expected.treeIntegrity)
    expect(await read(authority, expected)).toBe(expected.treeIntegrity)
    expect(hash.mock.calls.length).toBe(2)
  },
)

it('verifies identical bytes in each physical archive copy independently', async () => {
  const expected = identity(),
    authority = owner(),
    hash = vi.spyOn(sources, 'hashDirectoryAsync')
  const copy = join(root, 'packages/retained')
  cpSync(directory, copy, { recursive: true })
  expect(await read(authority, expected)).toBe(expected.treeIntegrity)
  expect(await authority.read(copy, expected)).toBe(expected.treeIntegrity)
  expect(hash.mock.calls.length).toBe(2)
  writeFileSync(join(copy, 'a.mjs'), 'EVIL')
  expect(await authority.read(copy, expected)).not.toBe(expected.treeIntegrity)
  expect(await read(authority, expected)).toBe(expected.treeIntegrity)
})

it('bounds repeated observation resets as busy without permanently quarantining valid bytes', async () => {
  const expected = identity(),
    fault = vi.fn(),
    authority = owner({ onMismatch: fault })
  const hash = vi.spyOn(sources, 'hashDirectoryAsync').mockImplementation(async () => {
    authority.invalidate()
    return expected.treeIntegrity
  })
  await expect(read(authority, expected)).rejects.toMatchObject({
    code: 'E_PACKAGE_BUSY',
    detail: { reason: 'busy' },
  })
  expect(hash).toHaveBeenCalledTimes(3)
  const imported = vi.fn(async () => ({}))
  await expect(
    authority.run(() =>
      loadPackagePlugins({
        snapshot: {
          ...expected,
          snapshotId: expected.integrity,
          profile: 'p',
          packageId: 'acme/test',
          directory,
          contributions: [],
        },
        generation: 1,
        importModule: imported,
      }),
    ),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_BUSY', detail: { reason: 'busy' } })
  expect(imported).not.toHaveBeenCalled()
  await setImmediate()
  expect(fault).not.toHaveBeenCalled()
})

it.each(['foreground', 'background'] as const)(
  'review: a real metadata EIO during %s verification is unavailable evidence, not a mismatch',
  async (phase) => {
    const fault = vi.fn(),
      expected = identity(),
      authority = owner({ onMismatch: fault, softMs: 0 })
    await read(authority, expected)
    const original = fs.lstat
    const unavailable = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(realpathSync(directory)))
        throw Object.assign(new Error('synthetic filesystem I/O outage'), { code: 'EIO' })
      return original(...args)
    })
    if (phase === 'foreground') await expect(read(authority, expected)).rejects.toThrow()
    else await authority.recheck()
    await setImmediate()
    expect(fault).not.toHaveBeenCalled()
    unavailable.mockRestore()
    expect(await read(authority, expected)).toBe(expected.treeIntegrity)
  },
)

it('review: unsupported-volume EACCES from the actual full verifier never revokes trust', async () => {
  const fault = vi.fn(),
    expected = identity(),
    authority = owner({ onMismatch: fault })
  vi.mocked(trees.supportsTreeIdentity).mockReturnValue(false)
  const original = fs.lstat
  const unavailable = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(realpathSync(directory)))
      throw Object.assign(new Error('synthetic permission outage'), { code: 'EACCES' })
    return original(...args)
  })
  await expect(read(authority, expected)).rejects.toThrow()
  await setImmediate()
  expect(fault).not.toHaveBeenCalled()
  unavailable.mockRestore()
  expect(await read(authority, expected)).toBe(expected.treeIntegrity)
})

it.each(['sync', 'async'] as const)(
  'review: a proven symlink violation at the %s gate notifies and seals until a control change',
  async (mode) => {
    const fault = vi.fn(),
      expected = identity(),
      authority = owner({ onMismatch: fault })
    await read(authority, expected)
    rmSync(file)
    symlinkSync(join(directory, 'z.mjs'), file)
    if (mode === 'sync')
      expect(() => authority.run(() => collectRead(directoryDigestSteps(directory, expected)))).toThrow()
    else await expect(read(authority, expected)).rejects.toThrow()
    await setImmediate()
    // Merely replacing the file is not a new control/trust decision.
    rmSync(file)
    writeFileSync(file, 'GOOD')
    const repaired = await read(authority, expected).then(
      () => 'accepted',
      () => 'refused',
    )
    expect({ notified: fault.mock.calls.length > 0, repaired }).toEqual({
      notified: true,
      repaired: 'refused',
    })
  },
)

it.each(['same-owner', 'another-owner', 'constructed-object'] as const)(
  'review: an admission cannot be replayed after assembly through %s',
  async (mode) => {
    const expected = identity(),
      parent = owner(),
      child = owner()
    await read(parent, expected)
    const issued = await parent.admission()
    await child.boot(issued, () => read(child, expected))
    writeFileSync(file, 'EVIL')
    const replay =
      mode === 'constructed-object'
        ? {
            binding: packageByteBinding(root),
            trees: [{ directory: realpathSync(directory), identity: expected }],
          }
        : issued
    const target = mode === 'same-owner' ? child : owner()
    const imported = vi.fn(async () => ({ main: { apply() {} } }))
    const result = await target
      .boot(replay, () =>
        target.run(() =>
          loadPackagePlugins({
            snapshot: {
              ...expected,
              snapshotId: expected.integrity,
              profile: 'p',
              packageId: 'acme/test',
              directory,
              contributions: [],
            },
            generation: 1,
            importModule: imported,
          }),
        ),
      )
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
    // Owning a separate verifier is not authority over the executable's original verifier.
    // Keep this boundary assertion alongside the public boot() single-use contract probe.
    await expect(read(parent, expected)).resolves.not.toBe(expected.treeIntegrity)
    expect({ refused: 'error' in result, imported: imported.mock.calls.length > 0 }).toEqual({
      refused: true,
      imported: false,
    })
  },
)

it('review: a changed source-policy binding cannot turn a delayed old full success into a new hit', async () => {
  const expected = identity(),
    fault = vi.fn(),
    authority = owner({ onMismatch: fault })
  const original = sources.hashDirectoryAsync
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const hash = vi.spyOn(sources, 'hashDirectoryAsync').mockImplementationOnce(async (...args) => {
    const actual = await original(...args)
    entered()
    await gate
    return actual
  })
  const pending = read(authority, expected).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  try {
    await reached
    writeFileSync(join(root, 'package-sources.json'), JSON.stringify({ version: 1, changed: true }))
    release()
    expect(await pending).toHaveProperty('error')
    hash.mockRestore()
    expect(await read(authority, expected)).toBe(expected.treeIntegrity)
    await setImmediate()
    expect(fault).not.toHaveBeenCalled()
  } finally {
    release()
    await pending
  }
})

it.each([
  ['darwin', 0x1an, true],
  ['darwin', 0xef53n, false],
  ['linux', 0xef53n, true],
  ['linux', 0x58465342n, true],
  ['linux', 0x1an, false],
  ['linux', 0n, false],
  ['win32', 0x1an, false],
  ['win32', 0x58465342n, false],
] as const)('review: volume allowlist on %s with type %s is %s', (platform, type, expected) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const actual = syncFs.statfsSync(directory, { bigint: true })
  vi.spyOn(syncFs, 'statfsSync').mockReturnValue({ ...actual, type })
  try {
    Object.defineProperty(process, 'platform', { value: platform })
    expect(actualVolumeSupport(directory)).toBe(expected)
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
})

it.each([
  ['sync', true],
  ['async', true],
  ['sync', false],
  ['async', false],
] as const)(
  'drops %s evidence on EIO (identity supported %s) and requires a new full proof',
  async (mode, supported) => {
    const fault = vi.fn(),
      expected = identity(),
      authority = owner({ onMismatch: fault })
    const hash = vi.spyOn(sources, mode === 'sync' ? 'hashDirectory' : 'hashDirectoryAsync')
    const use = () =>
      mode === 'sync'
        ? Promise.resolve().then(() => authority.readSync(directory, expected))
        : read(authority, expected)
    expect(await use()).toBe(expected.treeIntegrity)
    vi.mocked(trees.supportsTreeIdentity).mockReturnValue(supported)
    const outage = Object.assign(new Error('storage unavailable'), { code: 'EIO' })
    const canonical = realpathSync(file)
    const originalSync = syncFs.lstatSync,
      originalAsync = fs.lstat
    const sync = vi.spyOn(syncFs, 'lstatSync').mockImplementation((...args) => {
      if (String(args[0]) === canonical) throw outage
      return originalSync(...args)
    })
    const async = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === canonical) throw outage
      return originalAsync(...args)
    })
    await expect(use()).rejects.toThrow()
    await setImmediate()
    expect(fault).not.toHaveBeenCalled()
    sync.mockRestore()
    async.mockRestore()
    const before = hash.mock.calls.length
    expect(await use()).toBe(expected.treeIntegrity)
    expect(hash.mock.calls.length).toBe(before + 1)
  },
)

it.each(['sync', 'async'] as const)(
  'preserves root errno through the %s full hasher without turning it into success',
  async (mode) => {
    const outage = Object.assign(new Error('root unavailable'), { code: 'EIO' })
    const originalSync = syncFs.lstatSync,
      originalAsync = fs.lstat
    vi.spyOn(syncFs, 'lstatSync').mockImplementation((...args) => {
      if (String(args[0]) === directory) throw outage
      return originalSync(...args)
    })
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === directory) throw outage
      return originalAsync(...args)
    })
    const result =
      mode === 'sync'
        ? Promise.resolve().then(() => sources.hashDirectory(directory))
        : sources.hashDirectoryAsync(directory)
    await expect(result).rejects.toMatchObject({
      code: 'E_PACKAGE_SOURCE',
      detail: { reason: 'directory-unavailable' },
      cause: outage,
    })
  },
)

it.each([
  ['sync', 'root'],
  ['async', 'root'],
  ['sync', 'full-fallback'],
  ['async', 'full-fallback'],
  ['sync', 'after-full'],
  ['async', 'after-full'],
  ['sync', 'after-full-root'],
  ['async', 'after-full-root'],
] as const)(
  'closes a confirmed structural violation at the %s %s gate until a control decision',
  async (mode, gate) => {
    const fault = vi.fn(),
      expected = identity(),
      authority = owner({ onMismatch: fault })
    const use = () =>
      mode === 'sync'
        ? Promise.resolve().then(() => authority.readSync(directory, expected))
        : read(authority, expected)
    expect(await use()).toBe(expected.treeIntegrity)
    const breakLeaf = () => {
      rmSync(file)
      symlinkSync(join(directory, 'z.mjs'), file)
    }
    const saved = directory + '-saved'
    const breakRoot = () => {
      renameSync(directory, saved)
      symlinkSync(saved, directory, 'dir')
    }
    const corrupt = gate.includes('root') ? breakRoot : breakLeaf
    if (gate === 'root') corrupt()
    if (gate === 'full-fallback') {
      vi.mocked(trees.supportsTreeIdentity).mockReturnValue(false)
      breakLeaf()
    }
    if (gate.startsWith('after-full')) {
      authority.invalidate()
      if (mode === 'sync') {
        const original = sources.hashDirectory
        vi.spyOn(sources, 'hashDirectory').mockImplementationOnce((...args) => {
          const digest = original(...args)
          corrupt()
          return digest
        })
      } else {
        const original = sources.hashDirectoryAsync
        vi.spyOn(sources, 'hashDirectoryAsync').mockImplementationOnce(async (...args) => {
          const digest = await original(...args)
          corrupt()
          return digest
        })
      }
    }
    await expect(use()).rejects.toThrow()
    await setImmediate()
    expect(fault).toHaveBeenCalled()
    if (gate.includes('root')) {
      rmSync(directory)
      renameSync(saved, directory)
    } else {
      rmSync(file)
      writeFileSync(file, 'GOOD')
    }
    await expect(use()).rejects.toThrow()
    symlinkSync(join(root, 'packages'), join(root, 'alias'), 'dir')
    for (const path of [realpathSync(directory), join(root, 'alias/payload')]) {
      const aliasRead =
        mode === 'sync'
          ? Promise.resolve().then(() => authority.readSync(path, expected))
          : authority.read(path, expected)
      await expect(aliasRead).rejects.toThrow()
    }
    writeFileSync(join(root, 'agnes-lock.json'), 'a new control decision')
    expect(await use()).toBe(expected.treeIntegrity)
  },
)

it('drops positives when background control-file IO is unavailable before scanning a tree', async () => {
  const control = join(root, 'agnes-lock.json')
  writeFileSync(control, 'control')
  const expected = identity(),
    fault = vi.fn(),
    authority = owner({ onMismatch: fault, softMs: 0 })
  const hash = vi.spyOn(sources, 'hashDirectoryAsync')
  await read(authority, expected)
  const original = syncFs.readFileSync
  const outage = vi.spyOn(syncFs, 'readFileSync').mockImplementation((...args) => {
    if (String(args[0]) === control) throw Object.assign(new Error('control IO unavailable'), { code: 'EIO' })
    return original(...args)
  })
  await expect(authority.recheck()).rejects.toThrow()
  outage.mockRestore()
  await setImmediate()
  expect(fault).not.toHaveBeenCalled()
  const before = hash.mock.calls.length
  expect(await read(authority, expected)).toBe(expected.treeIntegrity)
  expect(hash.mock.calls.length).toBe(before + 1)
})

it.each(['sync', 'async'] as const)('refuses a %s use when the volume probe reports EIO', async (mode) => {
  const expected = identity(),
    fault = vi.fn(),
    authority = owner({ onMismatch: fault })
  const use = () =>
    mode === 'sync'
      ? Promise.resolve().then(() => authority.readSync(directory, expected))
      : read(authority, expected)
  const hash = vi.spyOn(sources, mode === 'sync' ? 'hashDirectory' : 'hashDirectoryAsync')
  await use()
  vi.mocked(trees.supportsTreeIdentity).mockImplementation(actualVolumeSupport)
  const outage = vi.spyOn(syncFs, 'statfsSync').mockImplementation(() => {
    throw Object.assign(new Error('volume IO unavailable'), { code: 'EIO' })
  })
  await expect(use()).rejects.toThrow()
  outage.mockRestore()
  await setImmediate()
  expect(fault).not.toHaveBeenCalled()
  const before = hash.mock.calls.length
  expect(await use()).toBe(expected.treeIntegrity)
  expect(hash.mock.calls.length).toBe(before + 1)
})

it('refuses a torn full scan without treating unchanged repaired bytes as a trust violation', async () => {
  const expected = identity(),
    fault = vi.fn(),
    authority = owner({ onMismatch: fault })
  await read(authority, expected)
  authority.invalidate()
  const canonical = realpathSync(file),
    original = fs.open
  let changed = false
  const scan = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (String(args[0]) === canonical && !changed) {
      changed = true
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const before = await stat()
        writeFileSync(file, 'GOOD')
        return before
      })
    }
    return handle
  })
  await expect(read(authority, expected)).rejects.toMatchObject({ detail: { reason: 'tree-changed' } })
  scan.mockRestore()
  await setImmediate()
  expect(changed).toBe(true)
  expect(fault).not.toHaveBeenCalled()
  const hash = vi.spyOn(sources, 'hashDirectoryAsync')
  expect(await read(authority, expected)).toBe(expected.treeIntegrity)
  expect(hash).toHaveBeenCalled()
})

it.each(
  (['sync', 'async'] as const).flatMap((mode) =>
    (['cold', 'hit', 'full-fallback'] as const).flatMap((gate) =>
      (['EIO', 'ABORT_ERR', 'unknown', 'ESTALE'] as const).map((code) => [mode, gate, code] as const),
    ),
  ),
)('recheck: %s %s refuses a one-shot %s without success or revocation', async (mode, gate, code) => {
  const expected = identity(),
    fault = vi.fn(),
    authority = owner({ onMismatch: fault })
  const use = () =>
    mode === 'sync'
      ? Promise.resolve().then(() => authority.readSync(directory, expected))
      : read(authority, expected)
  if (gate === 'hit') expect(await use()).toBe(expected.treeIntegrity)
  if (gate === 'full-fallback') vi.mocked(trees.supportsTreeIdentity).mockReturnValue(false)
  const canonical = realpathSync(file),
    originalSync = syncFs.lstatSync,
    originalAsync = fs.lstat
  let injected = false
  const error =
    code === 'unknown'
      ? new Error('unclassified storage failure')
      : Object.assign(new Error('synthetic storage failure'), { code })
  const sync = vi.spyOn(syncFs, 'lstatSync').mockImplementation((...args) => {
    if (mode === 'sync' && String(args[0]) === canonical && !injected) {
      injected = true
      throw error
    }
    return originalSync(...args)
  })
  const async = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (mode === 'async' && String(args[0]) === canonical && !injected) {
      injected = true
      throw error
    }
    return originalAsync(...args)
  })
  const outcome = await use().then(
    () => 'accepted',
    () => 'refused',
  )
  sync.mockRestore()
  async.mockRestore()
  await setImmediate()
  const hash = vi.spyOn(sources, mode === 'sync' ? 'hashDirectory' : 'hashDirectoryAsync')
  expect(await use()).toBe(expected.treeIntegrity)
  expect({
    injected,
    outcome,
    revoked: fault.mock.calls.length > 0,
    newFull: hash.mock.calls.length > 0,
  }).toEqual({ injected: true, outcome: 'refused', revoked: false, newFull: true })
})

it.each(['EIO', 'ABORT_ERR', 'unknown', 'ESTALE'] as const)(
  'recheck: background %s drops positive evidence without revoking or renewing it',
  async (code) => {
    const expected = identity(),
      fault = vi.fn(),
      authority = owner({ onMismatch: fault, softMs: 0 })
    await read(authority, expected)
    const canonical = realpathSync(file),
      original = fs.lstat
    let injected = false
    const outage = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === canonical && !injected) {
        injected = true
        throw code === 'unknown'
          ? new Error('unknown storage failure')
          : Object.assign(new Error('synthetic outage'), { code })
      }
      return original(...args)
    })
    await authority.recheck()
    outage.mockRestore()
    await setImmediate()
    const hash = vi.spyOn(sources, 'hashDirectoryAsync')
    expect(await read(authority, expected)).toBe(expected.treeIntegrity)
    expect({ injected, revoked: fault.mock.calls.length > 0, newFull: hash.mock.calls.length > 0 }).toEqual({
      injected: true,
      revoked: false,
      newFull: true,
    })
  },
)

it.each(['sync', 'async'] as const)(
  'recheck: confirmed %s symlink evidence survives a subsequent root EIO',
  async (mode) => {
    const expected = identity(),
      fault = vi.fn(),
      authority = owner({ onMismatch: fault })
    await read(authority, expected)
    rmSync(file)
    symlinkSync(join(directory, 'z.mjs'), file)
    const physical = realpathSync(directory),
      leaf = join(physical, 'a.mjs'),
      originalSync = syncFs.lstatSync,
      originalAsync = fs.lstat
    let confirmed = false,
      unavailable = false
    const sync = vi.spyOn(syncFs, 'lstatSync').mockImplementation((...args) => {
      const path = String(args[0])
      if (mode === 'sync' && confirmed && (path === directory || path === physical)) {
        unavailable = true
        throw Object.assign(new Error('root failed after structural evidence'), { code: 'EIO' })
      }
      const stat = originalSync(...args)
      if (!stat) throw new Error('expected an actual lstat observation')
      if (mode === 'sync' && path === leaf && stat.isSymbolicLink()) confirmed = true
      return stat
    })
    const async = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const path = String(args[0])
      if (mode === 'async' && confirmed && (path === directory || path === physical)) {
        unavailable = true
        throw Object.assign(new Error('root failed after structural evidence'), { code: 'EIO' })
      }
      const stat = await originalAsync(...args)
      if (mode === 'async' && path === leaf && stat.isSymbolicLink()) confirmed = true
      return stat
    })
    const use = () =>
      mode === 'sync'
        ? Promise.resolve().then(() => authority.readSync(directory, expected))
        : read(authority, expected)
    await expect(use()).rejects.toThrow()
    sync.mockRestore()
    async.mockRestore()
    await setImmediate()
    rmSync(file)
    writeFileSync(file, 'GOOD')
    const repaired = await use().then(
      () => 'accepted',
      () => 'refused',
    )
    expect({ confirmed, unavailable, notified: fault.mock.calls.length > 0, repaired }).toEqual({
      confirmed: true,
      unavailable: true,
      notified: true,
      repaired: 'refused',
    })
  },
)

it.each(['success', 'reject', 'wrong-binding', 'throwing-binding'] as const)(
  'recheck: boot consumption is one-shot after %s and never survives its assembly scope',
  async (mode) => {
    const expected = identity(),
      parent = owner(),
      child = owner()
    await read(parent, expected)
    const admission = await parent.admission()
    const input = mode === 'wrong-binding' ? { ...admission, binding: 'stale' } : admission
    if (mode === 'throwing-binding') {
      const path = join(root, 'agnes-lock.json')
      writeFileSync(path, 'control')
      const original = syncFs.readFileSync
      const outage = vi.spyOn(syncFs, 'readFileSync').mockImplementation((...args) => {
        if (String(args[0]) === path) throw Object.assign(new Error('binding outage'), { code: 'EIO' })
        return original(...args)
      })
      await expect(child.boot(input, async () => undefined)).rejects.toThrow()
      outage.mockRestore()
      rmSync(path)
    } else if (mode === 'reject') {
      await expect(
        child.boot(input, async () => {
          throw new Error('assembly rejected')
        }),
      ).rejects.toThrow('assembly rejected')
    } else {
      await child.boot(input, () => read(child, expected))
    }
    writeFileSync(file, 'EVIL')
    const refuse = async () => {
      const result = await read(child, expected)
      if (result !== expected.treeIntegrity) throw new Error('bad bytes refused')
    }
    await expect(child.boot(admission, refuse)).rejects.toThrow()
    const third = owner()
    await expect(
      third.boot(admission, async () => {
        if ((await read(third, expected)) !== expected.treeIntegrity) throw new Error('bad bytes refused')
      }),
    ).rejects.toThrow()
    expect(Object.isFrozen(admission)).toBe(true)
    expect(Object.isFrozen(admission.trees)).toBe(true)
  },
)

it.each(
  (['sync', 'async'] as const).flatMap((mode) =>
    (
      ['control-EIO', 'control-ESTALE', 'wall-back', 'mono-back', 'positive-reset', 'new-binding'] as const
    ).map((transition) => [mode, transition] as const),
  ),
)(
  'recheck2: confirmed %s structure evidence survives %s at the new control refresh',
  async (mode, transition) => {
    const control = join(root, 'agnes-lock.json')
    writeFileSync(control, 'grant A')
    const expected = identity(),
      fault = vi.fn(),
      authority = owner({ onMismatch: fault })
    await read(authority, expected)
    rmSync(file)
    symlinkSync(join(directory, 'z.mjs'), file)
    const leaf = join(realpathSync(directory), 'a.mjs')
    const originalSync = syncFs.lstatSync,
      originalAsync = fs.lstat,
      originalControl = syncFs.readFileSync
    let confirmed = false,
      transitioned = false
    const observe = () => {
      confirmed = true
      if (transitioned || transition.startsWith('control-')) return
      transitioned = true
      if (transition === 'wall-back') wall -= 1
      if (transition === 'mono-back') now -= 1
      if (transition === 'positive-reset') authority.invalidate()
      if (transition === 'new-binding') writeFileSync(control, 'grant B')
    }
    const sync = vi.spyOn(syncFs, 'lstatSync').mockImplementation((...args) => {
      const stat = originalSync(...args)
      if (mode === 'sync' && String(args[0]) === leaf && stat?.isSymbolicLink()) observe()
      return stat
    })
    const async = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const stat = await originalAsync(...args)
      if (mode === 'async' && String(args[0]) === leaf && stat.isSymbolicLink()) observe()
      return stat
    })
    const controls = vi.spyOn(syncFs, 'readFileSync').mockImplementation((...args) => {
      if (confirmed && !transitioned && transition.startsWith('control-') && String(args[0]) === control) {
        transitioned = true
        throw Object.assign(new Error('live controls unavailable after structure evidence'), {
          code: transition === 'control-EIO' ? 'EIO' : 'ESTALE',
        })
      }
      return originalControl(...args)
    })
    const use = () =>
      mode === 'sync'
        ? Promise.resolve().then(() => authority.readSync(directory, expected))
        : read(authority, expected)
    await expect(use()).rejects.toThrow()
    sync.mockRestore()
    async.mockRestore()
    controls.mockRestore()
    await setImmediate()
    rmSync(file)
    writeFileSync(file, 'GOOD')
    const repaired = await use().then(
      () => 'accepted',
      () => 'refused',
    )
    expect({ confirmed, transitioned, notified: fault.mock.calls.length > 0, repaired }).toEqual({
      confirmed: true,
      transitioned: true,
      notified: transition !== 'new-binding',
      repaired: transition === 'new-binding' ? 'accepted' : 'refused',
    })
  },
)

it.each(['raw', 'wrapped'] as const)(
  'recheck2: %s ESTALE does not enter the bounded retry even after epoch invalidation',
  async (mode) => {
    const expected = identity(),
      fault = vi.fn(),
      authority = owner({ onMismatch: fault })
    const stale = Object.assign(new Error('raw stale handle'), { code: 'ESTALE' })
    const error =
      mode === 'raw'
        ? stale
        : new PackageError('E_DEP_MISSING', 'wrapped failure', {
            detail: { reason: 'tree-changed' },
            cause: stale,
          })
    const hash = vi.spyOn(sources, 'hashDirectoryAsync').mockImplementationOnce(async () => {
      authority.invalidate()
      throw error
    })
    await expect(read(authority, expected)).rejects.toBe(error)
    expect(hash).toHaveBeenCalledTimes(1)
    await setImmediate()
    expect(fault).not.toHaveBeenCalled()
    expect(await read(authority, expected)).toBe(expected.treeIntegrity)
    expect(hash).toHaveBeenCalledTimes(2)
  },
)

it('recheck2: an immediate structural seal fences an older pending full success', async () => {
  const expected = identity(),
    fault = vi.fn(),
    authority = owner({ onMismatch: fault })
  const original = sources.hashDirectoryAsync
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.spyOn(sources, 'hashDirectoryAsync').mockImplementationOnce(async (...args) => {
    const actual = await original(...args)
    entered()
    await gate
    return actual
  })
  const pending = read(authority, expected).then(
    () => 'accepted',
    () => 'refused',
  )
  try {
    await ready
    rmSync(file)
    symlinkSync(join(directory, 'z.mjs'), file)
    expect(() => authority.readSync(directory, expected)).toThrow()
    release()
    expect(await pending).toBe('refused')
    await setImmediate()
    expect(fault).toHaveBeenCalledOnce()
    rmSync(file)
    writeFileSync(file, 'GOOD')
    await expect(read(authority, expected)).rejects.toThrow()
  } finally {
    release()
  }
})
