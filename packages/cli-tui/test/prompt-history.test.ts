import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PromptHistory } from '../src/prompt-history.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agh-history-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('PromptHistory', () => {
  it('persists across instances in a private file, newest first, skipping an immediate repeat', () => {
    const path = join(dir, 'tui-history.jsonl')
    const first = new PromptHistory(path)
    for (const text of ['one', 'two', 'two', '/help', 'multi\nline']) first.add(text)
    expect(first.entries).toEqual(['multi\nline', '/help', 'two', 'one'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(new PromptHistory(path).entries).toEqual(first.entries)
  })

  it('narrows a file that was created with wider permissions', () => {
    const path = join(dir, 'h.jsonl')
    writeFileSync(path, '{"text":"old"}\n', { mode: 0o644 })
    chmodSync(path, 0o644)
    new PromptHistory(path).add('new')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('keeps prompts another process appended when it rewrites a full file', () => {
    const path = join(dir, 'h.jsonl')
    const ours = new PromptHistory(path)
    for (let i = 0; i < 500; i++) ours.add(`prompt ${i}`)
    const other = new PromptHistory(path)
    other.add('from other')
    ours.add('from ours')
    const reloaded = new PromptHistory(path).entries
    expect(reloaded).toHaveLength(500)
    expect(reloaded.slice(0, 2)).toEqual(['from ours', 'from other'])
    // Memory stays this run's own: an entry too long for the file survives the rewrite.
    const long = 'x'.repeat(25_000)
    ours.add(long)
    ours.add('after long')
    expect(ours.entries.slice(0, 3)).toEqual(['after long', long, 'from ours'])
  })

  it('keeps the newest 500, in memory and on disk', () => {
    const path = join(dir, 'h.jsonl')
    const history = new PromptHistory(path)
    for (let i = 0; i < 620; i++) history.add(`prompt ${i}`)
    expect(history.entries).toHaveLength(500)
    expect(history.entries[0]).toBe('prompt 619')
    expect(history.entries.at(-1)).toBe('prompt 120')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(500)
    expect(new PromptHistory(path).entries).toEqual(history.entries)
  })

  it('falls back to memory when the file is damaged or cannot be used, without throwing', () => {
    const damaged = join(dir, 'damaged.jsonl')
    writeFileSync(damaged, '{"text":"kept"}\n\u0000garbage{{\n{"text":"also kept"}\nno newline at the end')
    const history = new PromptHistory(damaged)
    expect(history.entries).toEqual(['also kept', 'kept'])
    history.add('after')
    expect(new PromptHistory(damaged).entries).toEqual(['after', 'also kept', 'kept'])

    // A directory where the file should be, and a path whose parent is missing.
    mkdirSync(join(dir, 'is-a-dir'))
    for (const path of [join(dir, 'is-a-dir'), join(dir, 'missing', 'h.jsonl')]) {
      const memory = new PromptHistory(path)
      expect(() => memory.add('still remembered')).not.toThrow()
      expect(memory.entries).toEqual(['still remembered'])
    }
  })

  it('searches newest first, case-insensitively, one older match at a time', () => {
    const history = new PromptHistory()
    for (const text of ['Fix the build', 'write docs', 'fix tests', 'other']) history.add(text)
    expect(history.find('FIX')).toBe(1)
    expect(history.find('fix', 1)).toBe(3)
    expect(history.find('fix', 3)).toBe(-1)
  })
})
