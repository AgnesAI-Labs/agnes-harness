import { describe, expect, it } from 'vitest'
import { summarizeCall } from '../src/step/summarize-call.js'

describe('summarizeCall', () => {
  it('leads write and edit with the path whatever order the arguments came in, and states the size', () => {
    const content = 'x'.repeat(5000)
    const write = summarizeCall('write', { content, path: 'src/a.ts' })
    expect(write).toBe('write src/a.ts (5000 chars)')
    expect(write).not.toContain('xxxx')
    expect(summarizeCall('edit', { edits: [{ oldText: 'a', newText: 'b' }], path: 'src/a.ts' })).toBe(
      'edit src/a.ts (1 edit)',
    )
    expect(summarizeCall('edit', { edits: [{}, {}, {}], path: 'src/a.ts' })).toBe('edit src/a.ts (3 edits)')
  })

  it('shows the head of a long shell command with an explicit count, never a silent cut', () => {
    const command = `${'a'.repeat(2900)} && touch TAIL_UNSEEN`
    const summary = summarizeCall('shell', { command, cwd: 'work' })
    expect(summary.startsWith(`shell ${'a'.repeat(160)}…[showing 160 of ${command.length} chars]`)).toBe(true)
    expect(summary).not.toContain('TAIL_UNSEEN')
    expect(summary).toContain('cwd=')
    expect(summary.length).toBeLessThan(400)
  })

  it('folds whitespace in a command and leaves a short one untouched', () => {
    expect(summarizeCall('shell', { command: 'git  status\n\t-s' })).toBe('shell git status -s')
  })

  it.each([
    ['read', { path: 'a.md', offset: 10, limit: 5 }, 'read a.md offset=10 limit=5'],
    ['grep', { pattern: 'foo bar', path: 'src' }, 'grep src pattern="foo bar"'],
    ['web_fetch', { url: 'https://example.com/x' }, 'web_fetch https://example.com/x'],
    ['mcp__db__query', { sql: 'select 1', limit: 3 }, 'mcp__db__query sql="select 1" limit=3'],
  ])('summarizes %s by its locating field first', (name, args, expected) => {
    expect(summarizeCall(name, args)).toBe(expected)
  })

  it('marks a shortened path and counts fields it had no room for', () => {
    const path = `${'d/'.repeat(200)}f.ts`
    expect(summarizeCall('read', { path })).toContain(`…[showing 240 of ${path.length} chars]`)
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v'.repeat(30)]))
    expect(summarizeCall('custom', many)).toMatch(/…\[\d+ more fields? not shown\]$/)
  })

  it('falls back to canonical JSON, marked when cut, for arguments that are not an object', () => {
    expect(summarizeCall('x', [1, 2])).toBe('x [1,2]')
    expect(summarizeCall('x', 'y'.repeat(300))).toContain('…[showing 200 of 302 chars]')
  })

  it('stays inside the ledger limit however large the call is', () => {
    const args = Object.fromEntries(
      ['path', 'file_path', 'command', 'url', 'pattern', 'query'].map((k) => [k, 'z'.repeat(1_000_000)]),
    )
    expect(summarizeCall('anything', args).length).toBeLessThan(2000)
  })

  it('does not cut through a surrogate pair', () => {
    const out = summarizeCall('shell', { command: `${'a'.repeat(159)}😀tail` })
    expect(out).toContain('…[showing 159 of ')
    expect(out).not.toMatch(/[\ud800-\udbff]…/)
  })
})
