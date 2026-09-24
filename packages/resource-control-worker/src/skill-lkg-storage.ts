import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  createPrivateFileSync,
  hasPrivateDaclSync,
  renameWriteThrough,
  windowsEnsurePrivateDirectorySync,
  windowsOpenPrivateFileSync,
} from '@agnes/system-node'

const windows = process.platform === 'win32' // guards-allow-platform: private Worker cache storage boundary.

export async function readSkillCache(path: string): Promise<string> {
  if (!windows) return readFile(path, 'utf8')
  const target = resolve(path),
    directory = dirname(target),
    info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || !hasPrivateDaclSync(directory))
    throw Object.assign(new Error('Skill cache directory is not private'), { code: 'EACCES' })
  const fd = windowsOpenPrivateFileSync(target)
  try {
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export async function writeSkillCache(path: string, contents: string): Promise<void> {
  const target = resolve(path),
    directory = dirname(target)
  if (windows) windowsEnsurePrivateDirectorySync(directory)
  else await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    if (windows) {
      const fd = createPrivateFileSync(temporary)
      try {
        writeFileSync(fd, contents, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      await renameWriteThrough(temporary, target)
    } else {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(contents, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
