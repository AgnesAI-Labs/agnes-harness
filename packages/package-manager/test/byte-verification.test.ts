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
