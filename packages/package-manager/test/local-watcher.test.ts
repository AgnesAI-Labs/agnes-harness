import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { watchLocalPlugins } from '../src/local-watcher.js'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, watch: vi.fn(actual.watch) }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// On Windows libuv aborts the process when a recursively watched directory was named by an alias of
// its long path (an 8.3 short name such as RUNNER~1); a directory link stands in for that alias here.
it('watches each root by its native real path, not the spelling it was configured with', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-watch-alias-'))
  roots.push(root)
  const real = join(root, 'real')
  mkdirSync(real)
  const alias = join(root, 'alias')
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const watcher = watchLocalPlugins({
    roots: { home: alias, workspace: join(root, 'workspace') },
    scan: async () => [],
  })
  try {
    expect(vi.mocked(fs.watch).mock.calls.map(([path]) => path)).toEqual([
      realpathSync.native(real),
      realpathSync.native(join(root, 'workspace')),
    ])
  } finally {
    await watcher.close()
  }
})
