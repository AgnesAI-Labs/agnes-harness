import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { renameWriteThrough, renameWriteThroughSync } from '../src/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function files() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-rename-async-'))
  roots.push(root)
  const source = join(root, 'source'),
    target = join(root, 'target')
  writeFileSync(source, 'new')
  writeFileSync(target, 'old')
  return { source, target }
}

it('replaces contents and reports a missing source without changing the target', async () => {
  const { source, target } = files()
  await renameWriteThrough(source, target)
  expect(readFileSync(target, 'utf8')).toBe('new')
  expect(existsSync(source)).toBe(false)
  await expect(renameWriteThrough(source, target)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(readFileSync(target, 'utf8')).toBe('new')
})

it.runIf(process.platform === 'win32')('lets an open reader close before replacing the target', async () => {
  const { source, target } = files()
  let fd: number | undefined = openSync(target, 'r')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(() => renameWriteThroughSync(source, target)).toThrow(expect.objectContaining({ win32Code: 5 }))
    timer = setTimeout(() => {
      if (fd !== undefined) closeSync(fd)
      fd = undefined
    }, 50)
    await renameWriteThrough(source, target)
    expect(fd).toBeUndefined()
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(existsSync(source)).toBe(false)
  } finally {
    clearTimeout(timer)
    if (fd !== undefined) closeSync(fd)
  }
})

it.runIf(process.platform === 'win32')(
  'bounds retries and preserves both files when the reader remains open',
  async () => {
    const { source, target } = files()
    const fd = openSync(target, 'r')
    try {
      await expect(renameWriteThrough(source, target)).rejects.toMatchObject({ code: 'EACCES', win32Code: 5 })
      expect(readFileSync(target, 'utf8')).toBe('old')
      expect(readFileSync(source, 'utf8')).toBe('new')
    } finally {
      closeSync(fd)
    }
  },
)
