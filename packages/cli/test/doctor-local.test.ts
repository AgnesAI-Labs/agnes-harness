import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { doctorBinary, doctorStorage } from '../src/commands/doctor-local.js'

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-'))
  return { home, env: {}, cwd: home, agnesVersion: '0', log: () => {} }
}
describe('local doctor checks', () => {
  it('verifies real WAL transactions and preserves existing databases', async () => {
    const d = setup()
    try {
      mkdirSync(join(d.home, 'data'))
      writeFileSync(join(d.home, 'data', 'doctor.db'), 'existing-user-data')
      const r = await doctorStorage(d)
      expect(r.status).toBe('ok')
      expect(r.detail.join(' ')).toContain('journal_mode wal')
      expect(r.detail.join(' ')).toContain('transaction write/read verified')
      expect(readdirSync(join(d.home, 'data'))).toEqual(['doctor.db'])
      expect(readFileSync(join(d.home, 'data', 'doctor.db'), 'utf8')).toBe('existing-user-data')
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  it('verifies the real default cache and removes only its probe', async () => {
    const d = setup()
    try {
      const cache = join(d.home, 'cache', 'jiti', '0')
      mkdirSync(cache, { recursive: true })
      writeFileSync(join(cache, 'keep'), 'cached')
      const r = await doctorBinary(d)
      expect(r.status).toBe('ok')
      expect(r.detail).toContain('sea: no')
      expect(readdirSync(cache)).toEqual(['keep'])
      expect(readFileSync(join(cache, 'keep'), 'utf8')).toBe('cached')
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  it.each([
    ['storage', doctorStorage, 'data'],
    ['binary', doctorBinary, 'cache'],
  ] as const)(
    'reports real %s path failures without leaking filesystem errors',
    async (name, probe, child) => {
      const d = setup()
      try {
        writeFileSync(join(d.home, child), 'not-a-directory')
        const r = await probe(d)
        expect(r.status).toBe('fail')
        expect(r.detail).toEqual([`${name} local probe failed`])
        expect(readFileSync(join(d.home, child), 'utf8')).toBe('not-a-directory')
      } finally {
        rmSync(d.home, { recursive: true, force: true })
      }
    },
  )

  // The actual failure mode this pair of defaults used to have: a database from the pre-fix
  // default sitting at the home root, invisible to everything that now looks under home/data.
  // `agnes doctor` has to say so, plainly, and only when it is actually true.
  it('names a leftover pre-fix database at the home root, without opening or moving it', async () => {
    const d = setup()
    try {
      writeFileSync(join(d.home, 'sessions.db'), 'left-behind-by-an-older-build')
      const r = await doctorStorage(d)
      expect(r.detail.join('\n')).toContain(join(d.home, 'sessions.db'))
      expect(r.detail.join('\n')).toContain(join(d.home, 'data'))
      expect(readFileSync(join(d.home, 'sessions.db'), 'utf8')).toBe('left-behind-by-an-older-build')
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })

  it('says nothing about a leftover database when there is none to find', async () => {
    const d = setup()
    try {
      const r = await doctorStorage(d)
      expect(r.detail.some((line) => line.includes('sessions.db'))).toBe(false)
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
})
