import { execFile, execFileSync } from 'node:child_process'
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPrivateDirectorySync, hasPrivateDaclSync, windowsAppendPrivateFileSync } from '../src/index.js'

const windows = process.platform === 'win32' // guards-allow-platform: actual Windows append/DACL validation.
let root: string
let directory: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-append-中文 '))
  directory = join(root, 'private')
  createPrivateDirectorySync(directory)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe.skipIf(!windows)('private Windows append', () => {
  it('creates, reopens, appends and flushes without changing existing bytes', () => {
    const file = join(directory, 'audit.jsonl')
    windowsAppendPrivateFileSync(file, Buffer.from('第一行\n'))
    windowsAppendPrivateFileSync(file, Buffer.from('second\n'), true)
    windowsAppendPrivateFileSync(file, Buffer.alloc(0), true)
    expect(readFileSync(file, 'utf8')).toBe('第一行\nsecond\n')
    expect(hasPrivateDaclSync(file)).toBe(true)
  })
  it('protects already-private inherited permissions without truncating legacy data', () => {
    const file = join(directory, 'inherited')
    writeFileSync(file, 'legacy\n')
    windowsAppendPrivateFileSync(file, Buffer.from('next\n'))
    expect(readFileSync(file, 'utf8')).toBe('legacy\nnext\n')
    expect(hasPrivateDaclSync(file)).toBe(true)
  })
  it('rejects broad ACLs, hard links and directories without appending', () => {
    const file = join(directory, 'broad')
    windowsAppendPrivateFileSync(file, Buffer.from('preserve'))
    const system = process.env.SystemRoot
    if (!system) throw new Error('SystemRoot required')
    execFileSync(join(system, 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:R'], {
      windowsHide: true,
      stdio: 'pipe',
    })
    expect(() => windowsAppendPrivateFileSync(file, Buffer.from('bad'))).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('preserve')
    expect(hasPrivateDaclSync(file)).toBe(false)
    const linked = join(directory, 'linked')
    windowsAppendPrivateFileSync(linked, Buffer.from('original'))
    linkSync(linked, join(directory, 'alias'))
    expect(() => windowsAppendPrivateFileSync(linked, Buffer.from('bad'))).toThrow()
    expect(readFileSync(linked, 'utf8')).toBe('original')
    expect(() => windowsAppendPrivateFileSync(directory, Buffer.from('bad'))).toThrow()
  })
  it('preserves complete records from concurrent processes opening the same new file', async () => {
    const file = join(directory, 'concurrent')
    const module = createRequire(import.meta.url).resolve('@agnes/system-node/native')
    const script = `const native = require(process.argv[1]);
      for (let i = 0; i < 100; i++) native.appendPrivateFile(process.argv[2],
        Buffer.from(JSON.stringify({writer: process.argv[3], i, text: '中'.repeat(4096)}) + '\\n'), i === 99);`
    const execute = promisify(execFile)
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        execute(process.execPath, ['-e', script, module, file, String(i)], {
          windowsHide: true,
          timeout: 10000,
        }),
      ),
    )
    for (const result of results) expect(result.stderr).toBe('')
    const records = readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { writer: string; i: number; text: string })
    expect(records).toHaveLength(400)
    expect(new Set(records.map((record) => `${record.writer}:${record.i}`)).size).toBe(400)
    for (const record of records) expect(record.text).toBe('中'.repeat(4096))
    expect(hasPrivateDaclSync(file)).toBe(true)
  })
})
