import { execFileSync } from 'node:child_process'
import { linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDaemonMutationLock } from '../src/supervisor/mutation-lock.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(name = 'startup-lock.db') {
  const root = mkdtempSync(join(tmpdir(), 'agnes-legacy-lock-'))
  roots.push(root)
  createPrivateDirectorySync(join(root, 'daemon'))
  return { root, file: join(root, 'daemon', name) }
}

describe.skipIf(process.platform !== 'win32')('legacy Windows daemon locks', () => {
  it.each(['startup-lock.db', 'mutation-lock.db'])(
    'protects safe inherited %s without replacing content',
    (name) => {
      const { root, file } = fixture(name)
      const db = new DatabaseSync(file)
      db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('keep')")
      db.close()
      expect(hasPrivateDaclSync(file)).toBe(false)
      const before = readFileSync(file)
      const inode = statSync(file).ino
      const lock = acquireDaemonMutationLock(root, name)
      try {
        expect(hasPrivateDaclSync(file)).toBe(true)
        expect(statSync(file).ino).toBe(inode)
        expect(readFileSync(file)).toEqual(before)
        expect(() => acquireDaemonMutationLock(root, name)).toThrow('lock is held')
      } finally {
        lock.release()
      }
      expect(readFileSync(file)).toEqual(before)
    },
  )

  it('refuses broad inherited permissions without replacing file contents', () => {
    const { root, file } = fixture()
    writeFileSync(file, 'unchanged')
    execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:R'], { windowsHide: true })
    expect(() => acquireDaemonMutationLock(root, 'startup-lock.db')).toThrow('lock permissions are unsafe')
    expect(hasPrivateDaclSync(file)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('unchanged')
  })

  it('refuses a multiply-linked legacy file', () => {
    const { root, file } = fixture()
    writeFileSync(file, '')
    linkSync(file, join(root, 'alias.db'))
    expect(() => acquireDaemonMutationLock(root, 'startup-lock.db')).toThrow(
      'lock path must be a regular file',
    )
    expect(hasPrivateDaclSync(file)).toBe(false)
  })

  it('does not migrate arbitrary caller-supplied lock filenames', () => {
    const { root, file } = fixture('other.db')
    writeFileSync(file, '')
    expect(() => acquireDaemonMutationLock(root, 'other.db')).toThrow('lock permissions are unsafe')
    expect(hasPrivateDaclSync(file)).toBe(false)
  })

  it('distinguishes invalid SQLite content from unsafe permissions', () => {
    const { root, file } = fixture()
    writeFileSync(file, 'not a SQLite database'.repeat(100))
    expect(() => acquireDaemonMutationLock(root, 'startup-lock.db')).toThrow('cannot open lock database')
    expect(readFileSync(file, 'utf8')).toBe('not a SQLite database'.repeat(100))
  })
})
