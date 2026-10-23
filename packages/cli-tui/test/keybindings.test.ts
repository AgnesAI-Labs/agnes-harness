import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DraftStash, STASH_MAX } from '../src/draft-stash.js'
import { Editor } from '../src/editor.js'
import { formatKeys, installKeybindings, readKeybindings } from '../src/keybindings.js'
import { actionFor, installKeymap, Keymap } from '../src/keymap.js'
import { parseKey } from '../src/keys.js'
import { nextModel } from '../src/model-cycle.js'
import { nextThinkingLevel } from '../src/thinking-cycle.js'

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

describe('thinking-cycle (Shift+Tab)', () => {
  const models = [
    { route: 'r', id: 'plain' },
    { route: 'r', id: 'deep', reasoning: true },
    { route: 'r', id: 'mapped', reasoning: true, thinkingLevelMap: { low: 'l', high: 'h' } },
  ]
  it('is a global action on a key the editor does not use', () => {
    expect(actionFor('global', 'shift-tab')).toBe('thinking-cycle')
    expect(actionFor('editor', 'shift-tab')).toBeUndefined()
  })
  it('steps through the model levels, wraps, and declines a model without thinking', () => {
    const at = (id: string, thinking: string) => nextThinkingLevel(models, { route: 'r', id, thinking })
    expect(at('deep', 'off')).toBe('low')
    expect(at('deep', 'high')).toBe('off')
    expect(at('mapped', 'low')).toBe('high')
    expect(at('mapped', 'high')).toBe('low')
    expect(at('mapped', 'off')).toBe('low')
    expect(at('plain', 'off')).toBeUndefined()
    expect(at('gone', 'off')).toBeUndefined()
  })
})

describe('model cycle (Alt-P)', () => {
  const models = [
    { route: 'r', id: 'a' },
    { route: 'r', id: 'deep', reasoning: true },
    { route: 'r', id: 'a' },
    { route: 's', id: 'last', reasoning: true, thinkingLevelMap: { low: 'l' } },
  ]
  const at = (id: string, step: 1 | -1, route = 'r', thinking = 'high') =>
    nextModel(models, { route, id, thinking }, step)
  it('is a global action; Alt-P and Alt-Shift-P are told apart, plain and as kitty reports them', () => {
    expect(actionFor('global', 'alt-p')).toBe('model-next')
    expect(actionFor('global', 'alt-shift-p')).toBe('model-prev')
    expect(parseKey('\x1bp', false).name).toBe('alt-p')
    expect(parseKey('\x1bP', false).name).toBe('alt-shift-p')
    expect(parseKey('\x1b[112;3u', true).name).toBe('alt-p')
    expect(parseKey('\x1b[112;4u', true).name).toBe('alt-shift-p')
  })
  it('walks the picker order, lists each model once, wraps, and keeps a thinking level the model offers', () => {
    expect(at('a', 1)).toEqual({ route: 'r', model: 'deep', thinking: 'high' })
    expect(at('deep', 1)).toEqual({ route: 's', model: 'last' })
    expect(at('last', 1, 's')).toEqual({ route: 'r', model: 'a' })
    expect(at('a', -1)).toEqual({ route: 's', model: 'last' })
    expect(at('deep', -1)).toEqual({ route: 'r', model: 'a' })
  })
  it('starts at the first (or last) when the current model is not listed, and declines when nothing else is', () => {
    expect(at('gone', 1)).toEqual({ route: 'r', model: 'a' })
    expect(at('gone', -1)).toEqual({ route: 's', model: 'last' })
    expect(nextModel([{ route: 'r', id: 'a' }], { route: 'r', id: 'a', thinking: '' }, 1)).toBeUndefined()
    expect(nextModel([], undefined, 1)).toBeUndefined()
  })
})

describe('draft stash (Ctrl-S)', () => {
  const rig = () => {
    const editor = new Editor({ onSubmit: () => {} })
    const notes: string[] = []
    const stash = new DraftStash(
      editor,
      (text) => notes.push(text),
      () => 'en',
    )
    return { editor, notes, stash }
  }
  it('is a global action on the byte the terminal sends, also as kitty reports it', () => {
    expect(actionFor('global', 'ctrl-s')).toBe('draft-stash')
    expect(parseKey('\x13', false).name).toBe('ctrl-s')
    expect(parseKey('\x1b[115;5u', false).name).toBe('ctrl-s')
  })
  it('pushes a draft and clears the prompt, then pops the newest back into an empty one', () => {
    const { editor, notes, stash } = rig()
    editor.setText('first')
    stash.press()
    expect([editor.text, stash.size]).toEqual(['', 1])
    editor.setText('second')
    stash.press()
    stash.press()
    expect([editor.text, stash.size]).toEqual(['second', 1])
    editor.clear()
    stash.press()
    expect([editor.text, stash.size]).toEqual(['first', 0])
    editor.clear()
    stash.press()
    expect(notes.at(-1)).toBe('Nothing stashed')
    expect(editor.text).toBe('')
  })
  it('keeps at most ten drafts, dropping the oldest', () => {
    const { editor, stash } = rig()
    for (let i = 1; i <= 12; i++) {
      editor.setText(`d${i}`)
      stash.press()
    }
    expect(stash.size).toBe(STASH_MAX)
    stash.press()
    expect(editor.text).toBe('d12')
    for (let i = 0; i < 9; i++) {
      editor.clear()
      stash.press()
    }
    expect(editor.text).toBe('d3')
    expect(stash.size).toBe(0)
  })
  it('leaves the prompt alone while history search is open', () => {
    const { editor, stash } = rig()
    editor.setText('draft')
    editor.handleInput('\x12')
    stash.press()
    expect([editor.inSearch, stash.size]).toEqual([true, 0])
  })
})

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
