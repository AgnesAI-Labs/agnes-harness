import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { watchLocalPlugins } from '../src/local-watcher.js'

it.skipIf(process.platform !== 'linux')(
  'observes atomic edits below an existing plugin directory on Linux',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-linux-watch-'))
    const roots = { home: join(root, 'home'), workspace: join(root, 'workspace') }
    const folder = join(roots.workspace, 'plugin', 'nested')
    await mkdir(folder, { recursive: true })
    const source = join(folder, 'plugin.ts')
    await writeFile(source, 'old')
    let generation = 'old'
    const errors: unknown[] = []
    const watcher = watchLocalPlugins({
      roots,
      scan: async () => ((await readFile(source, 'utf8')) === generation ? [] : ['fixture']),
      reload: {
        reloadPlugin: async () => {
          generation = await readFile(source, 'utf8')
        },
      },
      onError: (id) => errors.push(id),
    })
    try {
      await writeFile(join(folder, 'next'), 'new')
      await rename(join(folder, 'next'), source)
      await expect.poll(() => generation).toBe('new')
      expect(errors).toEqual([])
      await watcher.close()
      await writeFile(source, 'closed')
      await watcher.refresh()
      expect(generation).toBe('new')
    } finally {
      await watcher.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
