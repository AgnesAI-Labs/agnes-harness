import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '../src/editor.js'
import { formatKeys, installKeybindings, readKeybindings } from '../src/keybindings.js'
import { actionFor, installKeymap, Keymap } from '../src/keymap.js'

afterEach(() => installKeymap(new Keymap()))

function load(content: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'agh-keys-'))
  try {
    const path = join(dir, 'keybindings.json')
    if (content !== undefined) writeFileSync(path, content)
    return readKeybindings(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('keybindings.json', () => {
  it('has no effect when absent', () => {
    const { keymap, problems } = load(undefined)
    expect(problems).toEqual([])
    expect(keymap.action('editor', 'ctrl-k')).toBe('cut-to-end')
  })

  it('rebinds an action, freeing its old key', () => {
    const { keymap, problems } = load(
      '{"cut-to-end":["alt-up"],"undo":["ctrl-d"],"timeline-bottom":["end"],"queue-recall":["ctrl-end"],"card-toggle":["ctrl-g"]}',
    )
    // alt-up is shared with the global queue-recall (which only acts on an empty draft), and queue-recall
    // may take ctrl-end once timeline-bottom lets go;
    // ctrl-d is reserved; ctrl-g would be hidden behind the global card toggle's priority.
    expect(problems.map((p) => [p.code, p.id])).toEqual([
      ['reserved', 'undo'],
      ['conflict', 'card-toggle'],
    ])
    expect(keymap.action('editor', 'alt-up')).toBe('cut-to-end')
    expect(keymap.action('editor', 'ctrl-k')).toBeUndefined()
    expect(keymap.action('global', 'ctrl-end')).toBe('queue-recall')
    expect(keymap.action('global', 'ctrl-o')).toBe('card-toggle')
  })

  it('refuses a key another action holds in the same scope, and keeps the default', () => {
    const { keymap, problems } = load('{"cut-to-end":["ctrl-u"]}')
    expect(problems).toEqual([{ code: 'conflict', id: 'cut-to-end', detail: 'ctrl-u' }])
    expect(keymap.action('editor', 'ctrl-k')).toBe('cut-to-end')
    expect(keymap.action('editor', 'ctrl-u')).toBe('cut-to-start')
  })

  it('lets an entry take a key an earlier entry freed', () => {
    const { keymap, problems } = load(
      '{"cut-word-back":["word-delete-back"],"external-edit":["ctrl-w"],"cut-to-start":["ctrl-g"]}',
    )
    expect(problems).toEqual([])
    expect(keymap.action('editor', 'ctrl-g')).toBe('cut-to-start')
    expect(keymap.action('editor', 'ctrl-w')).toBe('external-edit')
  })

  it.each([
    ['interrupt', '{"interrupt":["ctrl-g"]}', 'fixed'],
    ['quit', '{"quit":["ctrl-g"]}', 'fixed'],
    ['approval confirm', '{"approval-confirm":["tab"]}', 'fixed'],
    ['approval dismiss', '{"approval-dismiss":["ctrl-g"]}', 'fixed'],
    ['taking ctrl-c', '{"cancel":["ctrl-c"]}', 'reserved'],
    ['hiding behind a global key', '{"cut-to-end":["ctrl-o"]}', 'conflict'],
    ['unknown action', '{"fly":["ctrl-g"]}', 'unknown'],
    ['unknown key', '{"cancel":["ctrl-x"]}', 'key'],
    ['text is not a key', '{"cancel":["char"]}', 'key'],
    ['not a list', '{"cancel":"esc"}', 'shape'],
    ['empty list', '{"cancel":[]}', 'shape'],
    ['inherited name', '{"constructor":["esc"]}', 'unknown'],
  ])('ignores %s', (_n, json, code) => {
    const { keymap, problems } = load(json)
    expect(problems.map((p) => p.code)).toEqual([code])
    expect(keymap.action('global', 'ctrl-c')).toBe('interrupt')
    expect(keymap.action('approval', 'enter')).toBe('approval-confirm')
    expect(keymap.action('editor', 'esc')).toBe('cancel')
  })

  it.each([
    ['broken JSON', '{nope'],
    ['an array', '[]'],
    ['null', 'null'],
  ])('keeps the defaults for %s', (_n, json) => {
    const { keymap, problems } = load(json)
    expect(problems.map((p) => p.code)).toEqual(['file'])
    expect(keymap.action('editor', 'ctrl-k')).toBe('cut-to-end')
  })

  it('keeps the good entries when one is bad', () => {
    const { keymap, problems } = load('{"fly":["ctrl-g"],"cut-to-end":["alt-up"]}')
    expect(problems.map((p) => p.code)).toEqual(['unknown'])
    expect(keymap.action('editor', 'alt-up')).toBe('cut-to-end')
  })

  it('makes the editor obey the override', () => {
    installKeymap(load('{"cut-to-end":["alt-up"],"newline":["ctrl-k"]}').keymap)
    expect(actionFor('editor', 'alt-up')).toBe('cut-to-end')
    const e = new Editor({ onSubmit() {} })
    e.setText('ab cd')
    e.cursor = 2
    e.handleInput('\x1b[1;3A')
    expect(e.text).toBe('ab')
    e.handleInput('\x0b') // the freed key now breaks the line
    expect(e.text).toBe('ab\n')
  })

  it('installs once per path and returns the notice for the ignored entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-keys-'))
    try {
      const path = join(dir, 'keybindings.json')
      writeFileSync(path, '{"fly":["ctrl-g"],"cancel":["ctrl-x"]}')
      expect(installKeybindings(path, 'en')).toBe('keybindings.json: 2 entries ignored (see /keys)')
      writeFileSync(path, '{}')
      expect(installKeybindings(path, 'en')).toBe('keybindings.json: 2 entries ignored (see /keys)')
      expect(installKeybindings(join(dir, 'other.json'), 'en')).toBeUndefined()
      writeFileSync(path, '{broken')
      expect(installKeybindings(path, 'zh-CN')).toContain('已忽略')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('/keys', () => {
  it('lists every scope, marks overrides and fixed rows, and names what was ignored', () => {
    const read = load('{"cut-to-end":["alt-up"],"fly":["ctrl-g"]}')
    const text = formatKeys('en', read.keymap, read.problems)
    expect(text).toContain('Global')
    expect(text).toContain('Prompt editor')
    expect(text).toMatch(/cut-to-end\s+alt-up\s+Cut to the end of the line \[overridden, default ctrl-k\]/)
    expect(text).toMatch(/interrupt\s+ctrl-c\s+.*\[fixed\]/)
    expect(text).toMatch(/cut-to-start\s+ctrl-u\s+Cut to the start of the line$/m)
    expect(text).toContain('fly: no such action')
    expect(formatKeys('zh-CN', read.keymap, read.problems)).toContain('已覆盖，默认 ctrl-k')
  })
})
