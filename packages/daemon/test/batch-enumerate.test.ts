import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeName,
  enumerateItems,
  escapeName,
  MAX_ENTRIES,
  MAX_IMAGE_BYTES,
} from '../src/batch/enumerate.js'
import { BatchSpecError } from '../src/batch/spec.js'

type FakeEntry = { name: Buffer; type: 'file' | 'directory' | 'link' | 'fifo' }
const fake = vi.hoisted(() => ({ extra: undefined as undefined | { dir: string; entries: FakeEntry[] } }))
// Some file systems accept names that are not UTF-8 and others refuse them; this injects such entries
// into one listing so the walk is covered everywhere.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const listing = await actual.opendir(...args)
      const extra = fake.extra
      if (!extra || args[0] !== extra.dir) return listing
      return (async function* () {
        // Injected first: the order a listing arrives in must not decide which entry keeps a path.
        for (const entry of extra.entries)
          yield {
            name: entry.name,
            isDirectory: () => entry.type === 'directory',
            isFile: () => entry.type === 'file',
            isSymbolicLink: () => entry.type === 'link',
          }
        yield* listing
      })()
    },
  }
})

let root: string
let outside: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-enum-'))
  outside = mkdtempSync(join(tmpdir(), 'agh-enum-outside-'))
})
afterEach(() => {
  fake.extra = undefined
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
const write = (relative: string, content: string | Uint8Array = 'x') => {
  mkdirSync(dirname(join(root, relative)), { recursive: true })
  writeFileSync(join(root, relative), content)
}
const list = (extra: { ext?: string[]; out?: string; maxItems?: number; maxEntries?: number } = {}) =>
  enumerateItems({
    root,
    dirAbs: join(root, 'images'),
    outAbs: join(root, extra.out ?? 'agh-batch/b0123456789ab'),
    ...(extra.ext ? { ext: extra.ext } : {}),
    ...(extra.maxItems ? { maxItems: extra.maxItems } : {}),
    ...(extra.maxEntries ? { maxEntries: extra.maxEntries } : {}),
  })
const posix = process.platform !== 'win32'
const privileged = typeof process.getuid === 'function' && process.getuid() === 0

describe('enumerateItems', () => {
  it('lists files in sorted order with workspace-relative paths and kinds', async () => {
    write('images/b.JPG')
    write('images/a.png')
    write('images/sub/c.jpeg')
    write('images/notes.txt')
    write('images/data.xlsx')
    write('images/.hidden.png')
    write('images/.cache/d.png')
    expect(await list()).toEqual([
      { path: 'images/a.png', kind: 'image', bytes: 1 },
      { path: 'images/b.JPG', kind: 'image', bytes: 1 },
      { path: 'images/data.xlsx', kind: 'other', bytes: 1, skip: 'unsupported_type' },
      { path: 'images/notes.txt', kind: 'text', bytes: 1 },
      { path: 'images/sub/c.jpeg', kind: 'image', bytes: 1 },
    ])
  })

  it('keeps only the requested extensions and leaves the results folder out', async () => {
    write('images/a.png')
    write('images/b.txt')
    write('images/out/c.png')
    expect((await list({ ext: ['png'], out: 'images/out' })).map((item) => item.path)).toEqual([
      'images/a.png',
    ])
  })

  it('marks files over the size limit without reading them', async () => {
    write('images/big.png')
    truncateSync(join(root, 'images/big.png'), MAX_IMAGE_BYTES + 1)
    expect(await list()).toEqual([
      { path: 'images/big.png', kind: 'image', bytes: MAX_IMAGE_BYTES + 1, skip: 'too_large' },
    ])
  })

  it.skipIf(!posix)(
    'does not follow directory links and skips file links that leave the workspace',
    async () => {
      write('images/a.png')
      writeFileSync(join(outside, 'secret.png'), 'x')
      mkdirSync(join(outside, 'dir'))
      writeFileSync(join(outside, 'dir', 'e.png'), 'x')
      symlinkSync(join(outside, 'secret.png'), join(root, 'images', 'link.png'))
      symlinkSync(join(outside, 'dir'), join(root, 'images', 'linked-dir'))
      expect(await list()).toEqual([
        { path: 'images/a.png', kind: 'image', bytes: 1 },
        { path: 'images/link.png', kind: 'other', bytes: 0, skip: 'outside_root' },
      ])
    },
  )

  it.skipIf(!posix)(
    'follows file links inside the workspace and drops dangling, looping and inner folder links',
    async () => {
      write('images/a.png')
      write('other/b.png', 'xyz')
      mkdirSync(join(root, 'other', 'deeper'))
      writeFileSync(join(root, 'other', 'deeper', 'f.png'), 'x')
      symlinkSync(join(root, 'other', 'b.png'), join(root, 'images', 'b.png'))
      symlinkSync(join(root, 'other', 'deeper'), join(root, 'images', 'c-dir'))
      symlinkSync(join(root, 'missing.png'), join(root, 'images', 'd.png'))
      symlinkSync(join(root, 'images', 'e.png'), join(root, 'images', 'e.png'))
      symlinkSync(join(root, 'images'), join(root, 'images', 'loop'))
      expect(await list()).toEqual([
        { path: 'images/a.png', kind: 'image', bytes: 1 },
        { path: 'images/b.png', kind: 'image', bytes: 3 },
      ])
    },
  )

  it.skipIf(!posix)('refuses a folder that is a link leaving the workspace', async () => {
    mkdirSync(join(outside, 'pics'))
    writeFileSync(join(outside, 'pics', 'a.png'), 'x')
    symlinkSync(join(outside, 'pics'), join(root, 'images'))
    await expect(list()).rejects.toThrow(/outside the workspace/)
  })

  it.skipIf(!posix)('leaves out special files without opening them', async () => {
    write('images/a.png')
    execFileSync('mkfifo', [join(root, 'images', 'pipe.png')])
    execFileSync('mkfifo', [join(outside, 'pipe.txt')])
    symlinkSync(join(outside, 'pipe.txt'), join(root, 'images', 'pipe-link.txt'))
    expect(await list()).toEqual([{ path: 'images/a.png', kind: 'image', bytes: 1 }])
  })

  it('refuses a folder that does not exist', async () => {
    await expect(list()).rejects.toBeInstanceOf(BatchSpecError)
  })

  it('refuses a folder outside the workspace, a file instead of a folder, and NUL bytes', async () => {
    writeFileSync(join(outside, 'a.png'), 'x')
    await expect(enumerateItems({ root, dirAbs: outside, outAbs: join(root, 'out') })).rejects.toBeInstanceOf(
      BatchSpecError,
    )
    write('images')
    await expect(list()).rejects.toBeInstanceOf(BatchSpecError)
    await expect(
      enumerateItems({ root, dirAbs: join(root, 'images\u0000'), outAbs: join(root, 'out') }),
    ).rejects.toBeInstanceOf(BatchSpecError)
  })

  it('refuses a tree with too many files, too many entries, or nested too deep', async () => {
    for (const name of ['a.png', 'b.png', 'c.png']) write(`images/${name}`)
    await expect(list({ maxItems: 2 })).rejects.toThrow(/more than 2 files/)
    expect(await list({ maxItems: 3 })).toHaveLength(3)
    for (const name of ['.x', '.y', 'z.bin']) write(`images/${name}`)
    await expect(list({ ext: ['png'], maxEntries: 5 })).rejects.toThrow(/more than 5 entries/)
    rmSync(join(root, 'images'), { recursive: true })
    write(`images/${Array.from({ length: 33 }, (_, index) => `d${index}`).join('/')}/deep.png`)
    await expect(list()).rejects.toThrow(/deeper than/)
  })

  it.skipIf(!posix)('counts links that leave the workspace against the file limit', async () => {
    for (const name of ['a.png', 'b.png', 'c.png']) {
      writeFileSync(join(outside, name), 'x')
      mkdirSync(join(root, 'images'), { recursive: true })
      symlinkSync(join(outside, name), join(root, 'images', name))
    }
    await expect(list({ maxItems: 2 })).rejects.toThrow(/more than 2 files/)
  })

  it.skipIf(!posix || privileged)('refuses a subfolder it cannot list', async () => {
    write('images/a.png')
    write('images/locked\nStep 3/b.png')
    chmodSync(join(root, 'images', 'locked\nStep 3'), 0o000)
    try {
      await expect(list()).rejects.toThrow(/^cannot list images\/locked Step 3$/)
    } finally {
      chmodSync(join(root, 'images', 'locked\nStep 3'), 0o755)
    }
  })

  it('never feeds earlier batch results back in, and refuses a folder inside them', async () => {
    write('a.txt')
    write('agh-batch/b00000000000a/results.jsonl')
    write('agh-batch/b00000000000a/summary.md')
    const items = await enumerateItems({
      root,
      dirAbs: root,
      outAbs: join(root, 'agh-batch', 'b0123456789ab'),
    })
    expect(items.map((item) => item.path)).toEqual(['a.txt'])
    await expect(
      enumerateItems({ root, dirAbs: join(root, 'agh-batch', 'b00000000000a'), outAbs: join(root, 'out') }),
    ).rejects.toThrow(/agh-batch/)
  })

  it('bounds the entries it will look at', () => {
    expect(MAX_ENTRIES).toBe(200_000)
  })

  it('reads names that are UTF-8 and escapes the bytes of names that are not', () => {
    expect(decodeName(Buffer.from('a 1\u00e9.png'))).toBe('a 1\u00e9.png')
    expect(decodeName(Buffer.from([0x61, 0xff, 0x2e, 0x70, 0x6e, 0x67]))).toBeUndefined()
    expect(decodeName(Buffer.from([0xef, 0xbf, 0xbd]))).toBe('\ufffd')
    expect(escapeName(Buffer.from([0x61, 0xff, 0x5c, 0x0a, 0x2e, 0x70, 0x6e, 0x67]))).toBe(
      'a\\xff\\x5c\\x0a.png',
    )
    expect(escapeName(Buffer.from([0xc3]))).not.toBe(escapeName(Buffer.from([0xc4])))
  })

  it.skipIf(process.platform !== 'linux')(
    'reports names that are not UTF-8 as skipped, once each',
    async () => {
      write('images/a.png')
      const dir = Buffer.from(join(root, 'images/'))
      writeFileSync(Buffer.concat([dir, Buffer.from([0x62, 0xff]), Buffer.from('.png')]), 'x')
      writeFileSync(Buffer.concat([dir, Buffer.from([0x62, 0xfe]), Buffer.from('.png')]), 'x')
      mkdirSync(Buffer.concat([dir, Buffer.from([0x63, 0xff])]))
      writeFileSync(Buffer.concat([dir, Buffer.from('.'), Buffer.from([0xff])]), 'x')
      write('images/b\\xff.png')
      const items = await list()
      expect(items).toEqual([
        { path: 'images/a.png', kind: 'image', bytes: 1 },
        { path: 'images/b\\xfe.png', kind: 'other', bytes: 0, skip: 'unreadable_name' },
        { path: 'images/b\\xff.png', kind: 'image', bytes: 1 },
        { path: 'images/b\\xff.png~2', kind: 'other', bytes: 0, skip: 'unreadable_name' },
        { path: 'images/c\\xff', kind: 'other', bytes: 0, skip: 'unreadable_name' },
      ])
      expect(new Set(items.map((item) => item.path)).size).toBe(items.length)
    },
  )

  // The real file below is named with a literal backslash, which Windows treats as a path separator.
  it.skipIf(!posix)('lists names that are not UTF-8 as skipped under distinct escaped paths', async () => {
    write('images/a.png')
    write('images/b\\xff.png')
    const bytes = (...parts: Array<string | number[]>) =>
      Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : Buffer.from(part))))
    fake.extra = {
      dir: join(root, 'images'),
      entries: [
        { name: bytes('b', [0xff], '.png'), type: 'file' },
        { name: bytes('b', [0xfe], '.png'), type: 'link' },
        { name: bytes('c', [0xff]), type: 'directory' },
        { name: bytes('d', [0xff], '.xlsx'), type: 'file' },
        { name: bytes('e', [0xff], '.png'), type: 'fifo' },
        { name: bytes('.', [0xff]), type: 'file' },
      ],
    }
    const items = await list()
    expect(items).toEqual([
      { path: 'images/a.png', kind: 'image', bytes: 1 },
      { path: 'images/b\\xfe.png', kind: 'other', bytes: 0, skip: 'unreadable_name' },
      { path: 'images/b\\xff.png', kind: 'image', bytes: 1 },
      { path: 'images/b\\xff.png~2', kind: 'other', bytes: 0, skip: 'unreadable_name' },
      { path: 'images/c\\xff', kind: 'other', bytes: 0, skip: 'unreadable_name' },
      { path: 'images/d\\xff.xlsx', kind: 'other', bytes: 0, skip: 'unreadable_name' },
    ])
    expect((await list({ ext: ['png'] })).map((item) => item.path)).toEqual([
      'images/a.png',
      'images/b\\xfe.png',
      'images/b\\xff.png',
      'images/b\\xff.png~2',
      'images/c\\xff',
    ])
    await expect(list({ maxEntries: 7 })).rejects.toThrow(/more than 7 entries/)
  })
})
