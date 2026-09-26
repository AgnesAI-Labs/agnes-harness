import { execFileSync } from 'node:child_process'
import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPrivateDirectorySync, hasPrivateDaclSync, windowsWritePrivateFile } from '../src/index.js'

const fault = vi.hoisted(() => ({ write: false, flush: false, collision: false }))
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>()
  return {
    ...crypto,
    randomUUID: () => (fault.collision ? '00000000-0000-4000-8000-000000000000' : crypto.randomUUID()),
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      if (fault.flush) throw Object.assign(new Error('injected flush failure'), { code: 'EIO' })
      return fs.fsyncSync(fd)
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.write) throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' })
      return fs.writeFileSync(...args)
    },
  }
})
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-private-snapshot-'))
})
afterEach(() => {
  fault.write = false
  fault.flush = false
  fault.collision = false
  rmSync(root, { recursive: true, force: true })
})

it.skipIf(process.platform !== 'win32')(
  'adopts safe inherited legacy permissions without modifying sibling files',
  async () => {
    const parent = join(root, 'private-parent')
    createPrivateDirectorySync(parent)
    const directory = join(parent, 'worker-snapshots')
    mkdirSync(directory)
    const file = join(directory, 'snapshot.json')
    const sibling = join(directory, 'unrelated.json')
    writeFileSync(file, 'legacy snapshot')
    writeFileSync(sibling, 'keep this file')
    expect(hasPrivateDaclSync(directory)).toBe(false)
    expect(hasPrivateDaclSync(sibling)).toBe(false)
    await windowsWritePrivateFile(file, Buffer.from('new snapshot'))
    expect(hasPrivateDaclSync(directory)).toBe(true)
    expect(hasPrivateDaclSync(file)).toBe(true)
    expect(hasPrivateDaclSync(sibling)).toBe(false)
    expect(readFileSync(sibling, 'utf8')).toBe('keep this file')
    expect(readFileSync(file, 'utf8')).toBe('new snapshot')
  },
)

it.skipIf(process.platform !== 'win32')(
  'privately replaces snapshots and leaves a previous hardlink unchanged',
  async () => {
    const file = join(root, 'private', '中文 快照.json')
    await windowsWritePrivateFile(file, Buffer.from('old'))
    linkSync(file, join(root, 'alias'))
    await windowsWritePrivateFile(file, Buffer.from('新快照'))
    expect(readFileSync(file, 'utf8')).toBe('新快照')
    expect(readFileSync(join(root, 'alias'), 'utf8')).toBe('old')
    expect(hasPrivateDaclSync(file)).toBe(true)
    expect(hasPrivateDaclSync(join(root, 'private'))).toBe(true)
    expect(readdirSync(join(root, 'private'))).toEqual(['中文 快照.json'])
  },
)
it.skipIf(process.platform !== 'win32').each(['write', 'flush'] as const)(
  'preserves previous bytes and removes its temporary after %s failure',
  async (stage) => {
    const file = join(root, 'private', 'snapshot.json')
    await windowsWritePrivateFile(file, Buffer.from('previous'))
    fault[stage] = true
    await expect(windowsWritePrivateFile(file, Buffer.from('replacement'))).rejects.toMatchObject({
      code: stage === 'write' ? 'ENOSPC' : 'EIO',
    })
    expect(readFileSync(file, 'utf8')).toBe('previous')
    expect(readdirSync(join(root, 'private'))).toEqual(['snapshot.json'])
  },
)
it.skipIf(process.platform !== 'win32')(
  'keeps the previous snapshot when a reader prevents replacement',
  async () => {
    const file = join(root, 'private', 'snapshot.json')
    await windowsWritePrivateFile(file, Buffer.from('previous'))
    const fd = openSync(file, 'r')
    try {
      await expect(windowsWritePrivateFile(file, Buffer.from('replacement'))).rejects.toMatchObject({
        win32Code: 5,
      })
      expect(readFileSync(file, 'utf8')).toBe('previous')
      expect(hasPrivateDaclSync(file)).toBe(true)
      expect(readdirSync(join(root, 'private'))).toEqual(['snapshot.json'])
    } finally {
      closeSync(fd)
    }
  },
)
it.skipIf(process.platform !== 'win32')('finishes replacement after a temporary reader closes', async () => {
  const file = join(root, 'private', 'snapshot.json')
  await windowsWritePrivateFile(file, Buffer.from('previous'))
  let fd: number | undefined = openSync(file, 'r')
  const timer = setTimeout(() => {
    if (fd !== undefined) closeSync(fd)
    fd = undefined
  }, 50)
  try {
    await windowsWritePrivateFile(file, Buffer.from('replacement'))
    expect(fd).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('replacement')
    expect(readdirSync(join(root, 'private'))).toEqual(['snapshot.json'])
  } finally {
    clearTimeout(timer)
    if (fd !== undefined) closeSync(fd)
  }
})
it.skipIf(process.platform !== 'win32')(
  'refuses a broad existing destination directory before writing',
  async () => {
    const directory = join(root, 'broad')
    mkdirSync(directory)
    // A new directory under the user's temporary directory inherits only the user, SYSTEM and
    // Administrators, which the private-directory rule may adopt as it is. Grant Everyone read
    // access so the directory is actually broad.
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot is required for the Windows ACL test')
    execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [directory, '/grant', '*S-1-1-0:R'], {
      windowsHide: true,
      stdio: 'pipe',
    })
    expect(hasPrivateDaclSync(directory)).toBe(false)
    await expect(
      windowsWritePrivateFile(join(directory, 'snapshot.json'), Buffer.from('secret')),
    ).rejects.toThrow()
    expect(readdirSync(directory)).toEqual([])
  },
)
it.skipIf(process.platform !== 'win32')(
  'never removes an occupied temporary name it did not create',
  async () => {
    const file = join(root, 'private', 'snapshot.json')
    await windowsWritePrivateFile(file, Buffer.from('previous'))
    const occupied = `${file}.00000000-0000-4000-8000-000000000000.tmp`
    writeFileSync(occupied, 'not-owned-by-this-write')
    fault.collision = true
    await expect(windowsWritePrivateFile(file, Buffer.from('replacement'))).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('previous')
    expect(readFileSync(occupied, 'utf8')).toBe('not-owned-by-this-write')
  },
)
