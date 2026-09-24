import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as system from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeWindowsPrivateExport } from '../src/commands/export-private-file.js'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }))

describe.runIf(process.platform === 'win32')('Windows private export commit', () => {
  let root: string
  let file: string
  const bytes = Buffer.from('private exported content 中文')
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'agnes-export-private-'))
    file = join(root, 'export.jsonl')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })
  it('creates private bytes and preserves a hard-linked old file when replacing the destination', () => {
    writeWindowsPrivateExport(file, bytes)
    expect(system.hasPrivateDaclSync(file)).toBe(true)
    const alias = join(root, 'alias.jsonl')
    fs.linkSync(file, alias)
    const replacement = Buffer.from('replacement')
    writeWindowsPrivateExport(file, replacement)
    expect(fs.readFileSync(alias)).toEqual(bytes)
    expect(fs.readFileSync(file)).toEqual(replacement)
    expect(system.hasPrivateDaclSync(file)).toBe(true)
    expect(fs.readdirSync(root).sort()).toEqual(['alias.jsonl', 'export.jsonl'])
  })
  it.each(['write', 'flush', 'rename'] as const)(
    'preserves old bytes and removes staging after %s failure',
    (stage) => {
      fs.writeFileSync(file, 'old')
      const fail = () => {
        throw new Error(`injected ${stage} failure`)
      }
      if (stage === 'write') vi.spyOn(fs, 'writeFileSync').mockImplementation(fail)
      if (stage === 'flush') vi.spyOn(fs, 'fsyncSync').mockImplementation(fail)
      if (stage === 'rename') vi.spyOn(system, 'renameWriteThroughSync').mockImplementation(fail)
      expect(() => writeWindowsPrivateExport(file, bytes)).toThrow(`injected ${stage} failure`)
      expect(fs.readFileSync(file, 'utf8')).toBe('old')
      expect(fs.readdirSync(root)).toEqual(['export.jsonl'])
    },
  )
  it('fails closed when private creation is unavailable', () => {
    fs.writeFileSync(file, 'old')
    vi.spyOn(system, 'createPrivateFileSync').mockImplementation(() => {
      throw new Error('native unavailable')
    })
    expect(() => writeWindowsPrivateExport(file, bytes)).toThrow('native unavailable')
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
    expect(fs.readdirSync(root)).toEqual(['export.jsonl'])
  })
  it('does not replace an existing directory when the real commit fails', () => {
    fs.mkdirSync(file)
    const marker = join(file, 'marker')
    fs.writeFileSync(marker, 'untouched')
    expect(() => writeWindowsPrivateExport(file, bytes)).toThrow()
    expect(fs.readFileSync(marker, 'utf8')).toBe('untouched')
    expect(fs.readdirSync(root)).toEqual(['export.jsonl'])
  })
})
