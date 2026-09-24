import { execFileSync } from 'node:child_process'
import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileJournal } from '../src/journal-file.node.js'

describe.runIf(process.platform === 'win32')('Windows private SDK journal', () => {
  let parent: string, dir: string
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-journal-win-'))
    dir = join(parent, 'journal')
  })
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })
  it.each(['directory', 'journal.json', 'journal-lock.db'])(
    'refuses broad %s ACL without resetting identity',
    async (target) => {
      const journal = fileJournal(dir)
      const id = await journal.clientId()
      const before = readFileSync(join(dir, 'journal.json'))
      const path = target === 'directory' ? dir : join(dir, target)
      const systemRoot = process.env.SystemRoot
      if (!systemRoot) throw new Error('SystemRoot missing')
      const icacls = join(systemRoot, 'System32', 'icacls.exe')
      execFileSync(icacls, [path, '/grant', '*S-1-1-0:R'], { windowsHide: true })
      await expect(journal.nextCommandId('s')).rejects.toThrow('journal persistence unavailable')
      expect(readFileSync(join(dir, 'journal.json')).equals(before)).toBe(true)
      expect(readdirSync(dir).some((name) => name.includes('corrupt'))).toBe(false)
      execFileSync(icacls, [path, '/remove:g', '*S-1-1-0'], { windowsHide: true })
      expect(await fileJournal(dir).nextCommandId('s')).toBe(`${id}:s:1`)
    },
  )
  it.each(['journal.json', 'journal-lock.db'])('rejects a hard-linked %s', async (name) => {
    const journal = fileJournal(dir)
    await journal.clientId()
    const file = join(dir, name)
    linkSync(file, join(parent, 'alias'))
    const before = readFileSync(file)
    await expect(journal.clientId()).rejects.toThrow('journal persistence unavailable')
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(readdirSync(dir).some((entry) => entry.includes('corrupt'))).toBe(false)
  })
  it('refuses a directory junction without modifying its target', async () => {
    const id = await fileJournal(dir).clientId()
    const alias = join(parent, 'alias')
    symlinkSync(dir, alias, 'junction')
    try {
      await expect(fileJournal(alias).clientId()).rejects.toThrow('journal persistence unavailable')
    } finally {
      unlinkSync(alias)
    }
    expect(await fileJournal(dir).clientId()).toBe(id)
  })
  it('preserves pending command data larger than the bounded credential reader limit', async () => {
    const journal = fileJournal(dir)
    const text = 'x'.repeat(17 * 1024 * 1024)
    await journal.markPending('s', { commandId: 'large', method: 'submit', params: { text } })
    const pending = await fileJournal(dir).pending('s')
    expect(pending).toHaveLength(1)
    const command = pending[0]
    if (!command) throw new Error('pending command was lost')
    expect((command.params as { text: string }).text === text).toBe(true)
  })
})
