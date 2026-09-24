import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderHooksDoc, renderSlotsDoc, renderToolsMetaDoc } from '../tools/gen-docs.js'

describe('gen-docs', () => {
  it('hooks.md lists all seventeen events with the five columns', () => {
    const md = renderHooksDoc()
    for (const e of ['session_start', 'tool_call', 'shutdown'])
      expect(md).toMatch(new RegExp(`^\\| \`${e}\` \\|`, 'm'))
    expect(md).toContain('| event | mode | category | failPolicy | timeoutMs | replayOnResume |')
    // One row per event in the five-tuple table, and one per event in the IO table below it.
    expect(
      md.split('\n').filter((l) => /^\| `[a-z_]+` \| (emit|parallel|serial|waterfall) \|/.test(l)),
    ).toHaveLength(17)
  })
  // Independent of the renderer: the page must carry facts read out of the decision tables, not out
  // of the renderer's own output. Without this, the staleness case below only ever proves the file
  // matches whatever the renderer currently emits, however wrong that is.
  it('slots.md carries the four slot names, their orders and the byte cap', () => {
    const md = renderSlotsDoc()
    for (const [slot, order] of [
      ['tool.card.inline', 100],
      ['sidebar.action', 200],
      ['status.line', 300],
      ['notification', 400],
    ] as const)
      expect(md).toMatch(new RegExp(`^\\| \`${slot.replace(/\./g, '\\.')}\` \\| multi \\| ${order} \\|`, 'm'))
    expect(md).toContain('65536')
  })
  it('tools-meta.md carries all eight keys with their descriptions', () => {
    const md = renderToolsMetaDoc()
    for (const k of [
      'isReadOnly',
      'isDestructive',
      'isConcurrencySafe',
      'isOpenWorld',
      'replay',
      'costHint',
      'deferLoading',
      'requiresApproval',
    ])
      expect(md, k).toMatch(new RegExp(`^\\| \`${k}\` \\|`, 'm'))
    // The description column is what makes the page worth generating; an empty one would render as
    // a table with nothing in the last cell and still pass a "contains the key" check.
    for (const line of md.split('\n').filter((l) => l.startsWith('| `')))
      expect(line.split('|').at(-2)?.trim().length, line).toBeGreaterThan(20)
  })
  // Staleness gate only: the checked-in files were written by these same render functions, so this
  // can detect a forgotten `pnpm gen` and can never detect a wrong rendering. Named for what it does.
  it('the checked-in docs are not stale', () => {
    const base = new URL('../docs/', import.meta.url)
    expect(readFileSync(new URL('hooks.md', base), 'utf8')).toBe(renderHooksDoc())
    expect(readFileSync(new URL('slots.md', base), 'utf8')).toBe(renderSlotsDoc())
    expect(readFileSync(new URL('tools-meta.md', base), 'utf8')).toBe(renderToolsMetaDoc())
  })
})
