import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sandboxFileMasks, sandboxReadPaths } from '../src/sandbox-read-paths.js'

it('partitions aliased roots around missing and later-created private trees on every invocation', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agh-read-paths-'))
  try {
    const root = join(temp, 'root'),
      alias = join(temp, 'alias'),
      denied = join(alias, 'private', 'memory'),
      key = join(root, 'cloud-key')
    mkdirSync(root)
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(root, alias, linkType)
    writeFileSync(join(root, 'public.md'), 'public')
    mkdirSync(join(root, 'public'))
    const publicPaths = new Set([join(root, 'public'), join(root, 'public.md')])
    expect(new Set(sandboxReadPaths([denied, key], root))).toEqual(publicPaths)
    expect(existsSync(denied)).toBe(false)
    expect(sandboxFileMasks([key], [key])).toEqual({ denyPaths: [root], fileDenyPaths: [] })
    expect(existsSync(key)).toBe(false)
    mkdirSync(denied, { recursive: true })
    writeFileSync(join(denied, 'private.md'), 'private')
    writeFileSync(key, 'synthetic-private-key')
    expect(sandboxFileMasks([key], [key])).toEqual({ denyPaths: [key], fileDenyPaths: [key] })
    symlinkSync(denied, join(root, 'escape-to-private'), linkType)
    expect(new Set(sandboxReadPaths([denied, key], root))).toEqual(publicPaths)
    expect(sandboxReadPaths([root], alias)).toEqual([])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
