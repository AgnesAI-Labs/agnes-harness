import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))

it.runIf(process.platform !== 'win32')(
  'preserves directory aliases for journals while strict callers reject them',
  async () => {
    const { renameWriteThrough, syncDirectory } = await import('../src/index.js')
    const root = await fs.mkdtemp(join(tmpdir(), 'agnes-directory-alias-'))
    try {
      const real = join(root, 'real'),
        alias = join(root, 'alias')
      await fs.mkdir(real)
      await fs.symlink(real, alias, 'dir')
      await fs.writeFile(join(real, 'source'), 'new')
      await fs.writeFile(join(real, 'target'), 'old')
      await renameWriteThrough(join(alias, 'source'), join(alias, 'target'))
      expect(await fs.readFile(join(real, 'target'), 'utf8')).toBe('new')
      await syncDirectory(alias)
      await expect(syncDirectory(alias, { noFollow: true })).rejects.toThrow()
      await syncDirectory(real, { noFollow: true })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

// Exercises both POSIX branches on Windows; this is not a macOS filesystem acceptance test.
it.each(['darwin', 'linux'])(
  'awaits rename and directory durability on %s without sync IO',
  async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    vi.resetModules()
    const { renameWriteThrough } = await import('../src/index.js')
    let release!: () => void
    const renamed = new Promise<void>((resolve) => {
      release = resolve
    })
    const rename = vi.spyOn(fs, 'rename').mockReturnValue(renamed)
    const sync = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const open = vi.spyOn(fs, 'open').mockResolvedValue({ sync, close } as unknown as fs.FileHandle)
    const saving = renameWriteThrough('/agnes/source', '/agnes/target')
    expect(rename).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
    release()
    await saving
    expect(open).toHaveBeenCalledOnce()
    expect(sync).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  },
)

it('reports a post-rename flush failure, closes the handle, and never retries the committed rename', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  vi.resetModules()
  const { renameWriteThrough } = await import('../src/index.js')
  const failure = new Error('disk flush failed')
  const rename = vi.spyOn(fs, 'rename').mockResolvedValue(undefined)
  const close = vi.fn(async () => undefined)
  vi.spyOn(fs, 'open').mockResolvedValue({
    sync: vi.fn().mockRejectedValue(failure),
    close,
  } as unknown as fs.FileHandle)
  await expect(renameWriteThrough('/agnes/source', '/agnes/target')).rejects.toBe(failure)
  expect(rename).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
