import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export function fault(code) {
  return Object.assign(new Error(code), { code })
}
export function safeRelative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    value.includes('\\') ||
    value
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      ) ||
    isAbsolute(value)
  )
    throw fault('SYNC_PATH_INVALID')
  return value
}
export function within(root, path) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel))
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw fault('SYNC_DIRECTORY_UNSAFE')
  await chmod(path, 0o700)
}
export async function readPrivate(path, max = 65536) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > max
    )
      throw fault('SYNC_FILE_UNSAFE')
    const buffer = Buffer.alloc(max + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!chunk.bytesRead) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead > max) throw fault('SYNC_FILE_TOO_LARGE')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}
export async function privateJson(path) {
  try {
    return JSON.parse(await readPrivate(path))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw fault('SYNC_FILE_INVALID')
  }
}
export async function atomicJson(path, value) {
  await privateDirectory(dirname(path))
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await rename(temporary, path)
    const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function noLinks(root, target) {
  if (!within(root, target)) throw fault('SYNC_PATH_INVALID')
  let path = resolve(root)
  for (const part of ['', ...relative(root, target).split('/').filter(Boolean)]) {
    if (part) path = resolve(path, part)
    try {
      if ((await lstat(path)).isSymbolicLink()) throw fault('SYNC_PATH_UNSAFE')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}
