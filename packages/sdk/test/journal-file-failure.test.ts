import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ rename: false }))
vi.mock('@agnes/system-node', async (original) => {
  const fs = await original<typeof import('@agnes/system-node')>()
  return {
    ...fs,
    renameWriteThroughSync: (...args: Parameters<typeof fs.renameWriteThroughSync>) => {
      if (fault.rename) {
        fault.rename = false
        throw new Error('private fault marker')
      }
      return fs.renameWriteThroughSync(...args)
    },
  }
})

import { fileJournal } from '../src/journal-file.node.js'

it('does not publish an uncommitted counter or lose pending commands when rename fails', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'agnes-journal-failure-'))
  const dir = join(parent, 'journal')
  try {
    const journal = fileJournal(dir)
    const id = await journal.clientId()
    await journal.markPending('s', { commandId: 'old', method: 'submit', params: { saved: true } })
    const before = readFileSync(join(dir, 'journal.json'))
    fault.rename = true
    await expect(journal.nextCommandId('s')).rejects.toThrow(/^journal persistence unavailable$/)
    expect(readFileSync(join(dir, 'journal.json'))).toEqual(before)
    expect(readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(await journal.nextCommandId('s')).toBe(`${id}:s:1`)
    expect(await fileJournal(dir).pending('s')).toEqual([
      { commandId: 'old', method: 'submit', params: { saved: true } },
    ])
  } finally {
    fault.rename = false
    rmSync(parent, { recursive: true, force: true })
  }
})
