import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { testFsPolicy } from '@agnes/core/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createFs } from '../../src/adapters/fs.js'
import type { FsIo } from '../../src/adapters/fs-io.js'
import { localFsIo } from '../../src/adapters/fs-io-local.js'
import { createRemoteFsIo } from '../../src/adapters/fs-io-remote.js'
import { createLoopbackTransport } from '../../src/adapters/remote-transport.js'
import { memoryFsIo } from '../../testkit/fs-io-memory.js'

/**
 * The FsIo contract, held to through the fence: every io that can pass this file can sit under
 * createFs. Cases are written against the fence's behaviour, not the io's internals, so the same
 * assertions run over the real disk and over the memory tree.
 */
type Fixture = {
  io: FsIo
  /** The canonical workspace root the policy is built at. */
  root: string
  seed(rel: string, text: string): void
  mkdir(rel: string): void
  /** Creates a symlink at `at` (workspace-relative) pointing at `target` (absolute). */
  link(at: string, target: string): void
  /** An absolute path outside the workspace that exists. */
  outside(): string
  dispose(): void
}

const dec = (u: Uint8Array): string => new TextDecoder().decode(u)
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

function localFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-fsio-local-'))
  const out = mkdtempSync(join(tmpdir(), 'agnes-fsio-out-'))
  const root = realpathSync.native(dir)
  return {
    io: localFsIo,
    root,
    seed: (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text, 'utf8')
    },
    mkdir: (rel) => mkdirSync(join(root, rel), { recursive: true }),
    link: (at, target) => symlinkSync(target, join(root, at)),
    outside: () => {
      writeFileSync(join(out, 'secret'), 'x', 'utf8')
      return realpathSync.native(out)
    },
    dispose: () => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    },
  }
}

function memoryFixture(): Fixture {
  const mem = memoryFsIo()
  const root = '/mem/ws'
  mem.seedDir(root)
  return {
    io: mem,
    root,
    seed: (rel, text) => mem.seedFile(`${root}/${rel}`, text),
    mkdir: (rel) => mem.seedDir(`${root}/${rel}`),
    link: (at, target) => mem.symlink(target, `${root}/${at}`),
    outside: () => {
      mem.seedFile('/mem/out/secret', 'x')
      return '/mem/out'
    },
    dispose: () => undefined,
  }
}

function remoteFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-fsio-remote-'))
  const out = mkdtempSync(join(tmpdir(), 'agnes-fsio-out-'))
  const root = realpathSync.native(dir)
  return {
    io: createRemoteFsIo(createLoopbackTransport({ root })),
    root,
    seed: (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text, 'utf8')
    },
    mkdir: (rel) => mkdirSync(join(root, rel), { recursive: true }),
    link: (at, target) => symlinkSync(target, join(root, at)),
    outside: () => {
      writeFileSync(join(out, 'secret'), 'x', 'utf8')
      return realpathSync.native(out)
    },
    dispose: () => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    },
  }
}

const FIXTURES: Array<[string, () => Fixture]> = [
  ['local', localFixture],
  // The memory tree speaks posix paths only; on win32 the fence joins with `\` and the two never meet.
  ...(process.platform === 'win32' ? [] : ([['memory', memoryFixture]] as Array<[string, () => Fixture]>)),
  // The remote io shells out to python3/readlink/mkdir/rm as spawned executables, which win32 has
  // no equivalents for as plain argv[0]s.
  ...(process.platform === 'win32'
    ? []
    : ([['remote over loopback transport', remoteFixture]] as Array<[string, () => Fixture]>)),
]

describe.each(FIXTURES)('FsIo contract through the fence: %s', (_name, open) => {
  const held: Fixture[] = []
  afterEach(() => {
    for (const f of held.splice(0)) f.dispose()
  })
  const fixture = (): Fixture => {
    const f = open()
    held.push(f)
    return f
  }
  const fence = (f: Fixture, deny: string[] = ['.git']) =>
    createFs(() => ({ policy: testFsPolicy(f.root, { deny }), caseSensitive: true }), f.io)

  it('reads a line window, one-based and clamped', async () => {
    const f = fixture()
    f.seed('a.txt', 'l1\nl2\nl3\n')
    const fs = fence(f)
    expect(dec(await fs.read('a.txt', { offset: 2, limit: 1 }))).toBe('l2\n')
    expect(dec(await fs.read('a.txt', { offset: 9, limit: 2 }))).toBe('')
    expect(dec(await fs.read('a.txt'))).toBe('l1\nl2\nl3\n')
  })

  it('keeps a leading BOM in a windowed read, the same bytes Buffer.toString used to keep', async () => {
    const f = fixture()
    const withBom = '﻿l1\nl2\n'
    f.seed('bom.txt', withBom)
    const fs = fence(f)
    // Unwindowed: never touches a decoder, so this pins the write/read roundtrip is byte-exact.
    expect([...(await fs.read('bom.txt'))]).toEqual([...enc(withBom)])
    // Windowed: goes through the line-splitting decoder, which is where a default TextDecoder
    // would silently drop the BOM that Buffer.toString('utf8') used to keep.
    const windowed = await fs.read('bom.txt', { offset: 1, limit: 1 })
    expect([...windowed]).toEqual([...enc('﻿l1\n')])
  })

  it('creates parent directories on write', async () => {
    const f = fixture()
    const fs = fence(f)
    await fs.write('a/b/c.txt', enc('x'))
    expect((await fs.stat('a/b/c.txt')).size).toBe(1)
  })

  it('lists kinds, and stat describes the name asked about rather than what it points at', async () => {
    const f = fixture()
    f.mkdir('real')
    f.seed('real/x', 'ok')
    f.link('inside-link', join(f.root, 'real'))
    const fs = fence(f)
    const kinds = Object.fromEntries((await fs.list('.')).map((e) => [e.name, e.kind]))
    expect(kinds).toMatchObject({ real: 'dir', 'inside-link': 'symlink' })
    expect((await fs.stat('inside-link')).kind).toBe('symlink')
    expect((await fs.stat('real')).kind).toBe('dir')
    expect(dec(await fs.read('inside-link/x'))).toBe('ok')
  }, 15_000)

  it('answers rm for the parent as well as the leaf', async () => {
    const f = fixture()
    f.seed('vault/leaf', 'x')
    const fs = createFs(
      () => ({
        policy: testFsPolicy(f.root, { deny: ['vault'], extraAllowAbsolute: [`${f.root}/vault/leaf`] }),
        caseSensitive: true,
      }),
      f.io,
    )
    await expect(fs.rm('vault/leaf')).rejects.toThrow(/denied by policy at its parent/)
  })

  it('refuses a symlink that escapes, whether final or in the middle of the path', async () => {
    const f = fixture()
    const out = f.outside()
    f.link('out-link', join(out, 'secret'))
    f.link('dir-link', out)
    const fs = fence(f)
    await expect(fs.read('out-link')).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.stat('out-link')).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.read('dir-link/secret')).rejects.toThrow(/E_FS_DENIED/)
    await expect(fs.write('dir-link/new', enc('x'))).rejects.toThrow(/E_FS_DENIED/)
  }, 15_000)

  it('resolves a dangling link to its target and writes there when the target is inside', async () => {
    const f = fixture()
    f.link('dangling', join(f.root, 'not-yet'))
    const fs = fence(f)
    expect(await fs.realpath('dangling')).toBe(join(f.root, 'not-yet'))
    await fs.write('dangling', enc('x'))
    expect((await fs.stat('not-yet')).kind).toBe('file')
  })

  it('refuses a dangling link whose target is outside, before creating that target', async () => {
    const f = fixture()
    const out = f.outside()
    f.link('dangling-out', join(out, 'created-through-link'))
    const fs = fence(f)
    await expect(fs.write('dangling-out', enc('x'))).rejects.toThrow(/E_FS_DENIED/)
    // Asked of the io directly: the fence would refuse the outside path whether or not it exists.
    expect(await f.io.lstat(join(out, 'created-through-link'))).toBeUndefined()
  })

  it('refuses a symlink cycle', async () => {
    const f = fixture()
    f.link('a', join(f.root, 'b'))
    f.link('b', join(f.root, 'a'))
    const fs = fence(f)
    await expect(fs.read('a')).rejects.toThrow(/contains a symlink cycle/)
  })

  it('falls back to the lexical remainder past a missing or non-directory component', async () => {
    const f = fixture()
    f.seed('file.txt', 'x')
    const fs = fence(f)
    expect(await fs.realpath('missing/deep')).toBe(join(f.root, 'missing', 'deep'))
    expect(await fs.realpath('file.txt/x')).toBe(join(f.root, 'file.txt', 'x'))
    // Through a plain file the io answers with its own error, never with the policy's marker.
    await expect(fs.read('file.txt/x')).rejects.not.toThrow(/E_FS_DENIED/)
  })

  it('exposes a policy-free canonicalize for the sandbox seam and session open', async () => {
    const f = fixture()
    f.mkdir('real')
    f.link('inside-link', join(f.root, 'real'))
    const fs = fence(f)
    expect(await fs.canonicalize('inside-link')).toBe(join(f.root, 'real'))
    expect(await fs.canonicalize('x', { base: join(f.root, 'real') })).toBe(join(f.root, 'real', 'x'))
    await expect(fs.canonicalize('')).rejects.toThrow(/not a usable path/)
  })

  it('rm without recursive refuses a directory, empty or not, as node:fs does', async () => {
    const f = fixture()
    f.mkdir('empty')
    f.mkdir('full')
    f.seed('full/child.txt', 'x')
    const fs = fence(f)
    // node:fs's rm(recursive: false) (force: false, what localFsIo passes) fails on the directory
    // itself before it ever gets to ask whether the directory is empty - an empty dir must fail
    // exactly like a non-empty one, not silently succeed.
    await expect(fs.rm('empty')).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' })
    await expect(fs.rm('full')).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' })
  })

  it('write onto an existing directory fails as EISDIR', async () => {
    const f = fixture()
    f.mkdir('adir')
    const fs = fence(f)
    // fs.write() mkdir's the parent first (idempotent on an already-existing directory) and then
    // writes the leaf - the collision surfaces from writeFile, the same EISDIR `open()` gives, not
    // EEXIST.
    await expect(fs.write('adir', enc('x'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('mkdir onto an existing file fails as EEXIST', async () => {
    const f = fixture()
    f.seed('afile', 'x')
    const fs = fence(f)
    // A non-directory collision at the leaf node:fs's mkdir(recursive) is asked to create is EEXIST;
    // ENOTDIR is reserved for a non-directory collision partway down the path (already covered above
    // by the fall-back-to-lexical-remainder case).
    await expect(fs.mkdir('afile')).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
