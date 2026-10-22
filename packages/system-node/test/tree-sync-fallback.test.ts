import { fsyncSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { syncTreeBatchedSync } from '../src/index.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})
// A native artifact built before the descriptor flush existed: it loads, but has no syncDescriptor.
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string) => {
      const real = actual.createRequire(url)
      return Object.assign(
        (id: string) =>
          id === '@agnes/system-node/native' ? { abiVersion: 1, deletePrivateArtifact() {} } : real(id),
        real,
      )
    },
  }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Only macOS has a batched flush to fall back from; elsewhere the function is syncTreeSync itself.
it.runIf(process.platform === 'darwin')(
  'falls back to a full flush per entry when the native module has no descriptor flush',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'agh-tree-sync-fallback-'))
    roots.push(root)
    writeFileSync(join(root, 'a.txt'), 'a')
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'b.txt'), 'b')
    const fsync = vi.mocked(fsyncSync)
    fsync.mockClear()
    syncTreeBatchedSync(root)
    // root, nested, and the two files
    expect(fsync).toHaveBeenCalledTimes(4)
  },
)
