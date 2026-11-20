import { lstat, open, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fault, noLinks, safeRelative } from './private-files.mjs'

const header = Buffer.from('SQLite format 3\0')
export async function databases(config, { strict = false } = {}) {
  const paths = []
  async function visit(dir, recursive) {
    for (const name of await readdir(dir).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })) {
      const file = join(dir, name),
        stat = await lstat(file)
      if (stat.isSymbolicLink()) throw fault('SYNC_DATABASE_PATH_UNSAFE')
      if (stat.isDirectory() && recursive) {
        await visit(file, true)
        continue
      }
      if (!stat.isFile() || !name.endsWith('.db') || name === 'computer-use-artifact-mutation-lock.db')
        continue
      const fd = await open(file, 'r')
      let valid
      try {
        const data = Buffer.alloc(16)
        await fd.read(data, 0, 16, 0)
        valid = data.equals(header)
      } finally {
        await fd.close()
      }
      if (!valid) {
        if (strict) throw fault('SYNC_DATABASE_INVALID')
        continue
      }
      paths.push(safeRelative(relative(config.home, file)))
    }
  }
  const main = join(config.home, 'data', 'sessions.db')
  try {
    await noLinks(config.home, main)
    const fd = await open(main, 'r')
    let valid
    try {
      const data = Buffer.alloc(16)
      await fd.read(data, 0, 16, 0)
      valid = data.equals(header)
    } finally {
      await fd.close()
    }
    if (valid) paths.push('data/sessions.db')
    else if (strict) throw fault('SYNC_DATABASE_INVALID')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await visit(join(config.home, 'data', 'tables'), true)
  await visit(join(config.home, 'data', 'artifacts'), false)
  return paths.sort()
}
export function databasePath(path) {
  safeRelative(path)
  if (
    path !== 'data/sessions.db' &&
    !/^data\/tables\/(?:[^/]+\/)*[^/]+\.db$/u.test(path) &&
    !/^data\/artifacts\/[^/]+\.db$/u.test(path)
  )
    throw fault('SYNC_DATABASE_PATH_INVALID')
  if (path.endsWith('computer-use-artifact-mutation-lock.db')) throw fault('SYNC_DATABASE_PATH_INVALID')
  return path
}
export function checkDatabase(file, { verify = true } = {}) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    if (verify) {
      const result = db.prepare('PRAGMA quick_check').all()
      if (result.length !== 1 || Object.values(result[0])[0] !== 'ok') throw fault('SYNC_DATABASE_CORRUPT')
    }
    return db.prepare('PRAGMA user_version').get().user_version
  } finally {
    db.close()
  }
}
