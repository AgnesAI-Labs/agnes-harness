import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncTreeBatchedSync, syncTreeSync } from '../src/index.js'
import { syncTreeBatched } from '../src/tree-sync.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(join(root, 'readonly-dir'), 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

/** Files, an empty and a deep directory, read-only entries and a link the walk must skip. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'agh-tree-sync-'))
  roots.push(root)
  writeFileSync(join(root, 'a.txt'), 'a')
  mkdirSync(join(root, 'empty'))
  mkdirSync(join(root, 'deep', '1', '2'), { recursive: true })
  writeFileSync(join(root, 'deep', '1', '2', 'leaf.txt'), 'leaf')
  mkdirSync(join(root, 'readonly-dir'))
  writeFileSync(join(root, 'readonly-dir', 'inside.txt'), 'inside')
  chmodSync(join(root, 'readonly-dir'), 0o500)
  // Windows opens files for writing to flush them, so a read-only file cannot be flushed there at all.
  if (process.platform !== 'win32') writeFileSync(join(root, 'readonly.txt'), 'readonly', { mode: 0o400 })
  symlinkSync(join(root, 'a.txt'), join(root, 'link'))
  return root
}

/** The regular files and directories under `root`, and `root`, listed independently of the code under test. */
function entries(root: string): Set<string> {
  const found = new Set<string>([root])
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) for (const nested of entries(path)) found.add(nested)
    else if (entry.isFile()) found.add(path)
  }
  return found
}

describe('batched tree flush', () => {
  it('hands every file and directory to the drive, children first, then flushes the drive once through the root', () => {
    const root = tree()
    const calls: [path: string, directory: boolean, full: boolean][] = []
    syncTreeBatched([root], (path, directory, full) => calls.push([path, directory, full]))
    expect(calls.at(-1)).toEqual([root, true, true])
    expect(calls.filter(([, , full]) => full)).toHaveLength(1)
    const handed = calls.slice(0, -1)
    expect(new Set(handed.map(([path]) => path))).toEqual(entries(root))
    expect(handed).toHaveLength(entries(root).size)
    for (const [index, [path, directory]] of handed.entries()) {
      if (!directory) continue
      const descendants = handed.filter(([other]) => other.startsWith(`${path}/`))
      for (const [other] of descendants)
        expect(handed.findIndex(([candidate]) => candidate === other)).toBeLessThan(index)
    }
  })

  it('flushes several roots with one full flush through the last, and nothing for no roots', () => {
    const first = tree(),
      second = tree(),
      calls: [string, boolean][] = []
    syncTreeBatched([first, second], (path, _directory, full) => calls.push([path, full]))
    expect(calls.filter(([, full]) => full)).toEqual([[second, true]])
    expect(calls.at(-1)).toEqual([second, true])
    expect(calls.findIndex(([path]) => path === second)).toBeGreaterThan(
      calls.findIndex(([path]) => path === first),
    )
    calls.length = 0
    syncTreeBatched([], (path, _directory, full) => calls.push([path, full]))
    expect(calls).toEqual([])
  })

  it('flushes a tree through the native drive flush on macOS and per entry elsewhere', () => {
    const root = tree(),
      // On Windows a directory flush is a native call, not fsyncSync, so only files are counted.
      count = [...entries(root)].filter(
        (path) => process.platform !== 'win32' || !statSync(path).isDirectory(),
      ).length,
      fsync = vi.mocked(fsyncSync)
    fsync.mockClear()
    syncTreeSync(root)
    expect(fsync).toHaveBeenCalledTimes(count)
    fsync.mockClear()
    syncTreeBatchedSync(root)
    expect(fsync).toHaveBeenCalledTimes(process.platform === 'darwin' ? 0 : count)
  })

  it.runIf(process.platform === 'darwin')(
    'exposes a plain and a full descriptor flush in the macOS module',
    () => {
      const native = createRequire(import.meta.url)('@agnes/system-node/native') as {
        syncDescriptor(fd: number, full: boolean): void
      }
      const root = tree(),
        fd = openSync(join(root, 'a.txt'), 'r')
      try {
        expect(native.syncDescriptor(fd, false)).toBeUndefined()
        expect(native.syncDescriptor(fd, true)).toBeUndefined()
      } finally {
        closeSync(fd)
      }
      expect(() => native.syncDescriptor(fd, false)).toThrow()
      expect(() => native.syncDescriptor(-1, true)).toThrow(TypeError)
    },
  )
})
