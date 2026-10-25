import type { PermissionRequest } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { FilterSelect } from '../src/components/filter-select.js'
import { Select } from '../src/components/select.js'
import { Editor } from '../src/editor.js'
import { PermissionModal } from '../src/permission-modal.js'
import { PromptHistory } from '../src/prompt-history.js'
import { TuiTheme } from '../src/theme.js'
import { SecretInputView } from '../src/views/secret-input.js'
import { UsagePanel } from '../src/views/usage-panel.js'

// Every key that means something today, by the bytes a terminal sends for it. This table is the
// contract the key binding table (keymap.ts) has to keep: it drives real components and checks what
// the key does, so it passes before and after the bindings move into one declaration.

type Seen = {
  text: string
  cursor: number
  submitted: string[]
  cancels: boolean[]
  external: number
  images: number
}
type Case = {
  name: string
  keys: string[]
  text?: string
  cursor?: number
  history?: string[]
  kitty?: boolean
  busy?: boolean
  complete?: (prefix: string) => string[]
  /** What the editor says about the last key, when that is the point. */
  handled?: boolean
  want: Partial<Seen>
}

function drive(c: Case): Seen & { handled: boolean } {
  const submitted: string[] = []
  const cancels: boolean[] = []
  let external = 0
  let images = 0
  const history = new PromptHistory()
  for (const h of [...(c.history ?? [])].reverse()) history.add(h)
  const e = new Editor({
    onSubmit: (t) => submitted.push(t),
    onCancelKey: (d) => cancels.push(d),
    onExternalEdit: () => void external++,
    onPasteImage: () => void images++,
    history,
    busy: () => c.busy === true,
    ...(c.complete ? { complete: c.complete } : {}),
  })
  e.setKitty(c.kitty === true)
  if (c.text !== undefined) {
    e.setText(c.text)
    e.cursor = c.cursor ?? c.text.length
  }
  let handled = false
  for (const k of c.keys) handled = e.handleInput(k)
  return { text: e.text, cursor: e.cursor, submitted, cancels, external, images, handled }
}

const S = 'ab cd ef'
const editorCases: Case[] = [
  { name: 'enter submits', keys: ['\r'], text: 'hi', want: { submitted: ['hi'], text: '' } },
  {
    name: 'enter with a trailing backslash breaks the line',
    keys: ['\r'],
    text: 'hi\\',
    want: { text: 'hi\n' },
  },
  { name: 'alt-enter breaks the line', keys: ['\x1b\r'], text: S, cursor: 5, want: { text: 'ab cd\n ef' } },
  {
    name: 'shift-enter breaks the line',
    keys: ['\x1b[13;2u'],
    kitty: true,
    text: S,
    cursor: 5,
    want: { text: 'ab cd\n ef' },
  },
  { name: 'backspace deletes', keys: ['\x7f'], text: S, cursor: 5, want: { text: 'ab c ef', cursor: 4 } },
  { name: 'ctrl-h byte deletes', keys: ['\b'], text: S, cursor: 5, want: { text: 'ab c ef', cursor: 4 } },
  { name: 'left', keys: ['\x1b[D'], text: S, cursor: 5, want: { cursor: 4 } },
  { name: 'ctrl-b', keys: ['\x02'], text: S, cursor: 5, want: { cursor: 4 } },
  { name: 'right', keys: ['\x1b[C'], text: S, cursor: 5, want: { cursor: 6 } },
  { name: 'ctrl-f', keys: ['\x06'], text: S, cursor: 5, want: { cursor: 6 } },
  ...[
    ['home', '\x1b[H'],
    ['home (SS3)', '\x1bOH'],
    ['home (1~)', '\x1b[1~'],
    ['home (7~)', '\x1b[7~'],
    ['ctrl-a', '\x01'],
  ].map(
    ([name, key]): Case => ({
      name: name as string,
      keys: [key as string],
      text: S,
      cursor: 5,
      want: { cursor: 0 },
    }),
  ),
  ...[
    ['end', '\x1b[F'],
    ['end (SS3)', '\x1bOF'],
    ['end (4~)', '\x1b[4~'],
    ['end (8~)', '\x1b[8~'],
    ['ctrl-e', '\x05'],
  ].map(
    ([name, key]): Case => ({
      name: name as string,
      keys: [key as string],
      text: S,
      cursor: 5,
      want: { cursor: 8 },
    }),
  ),
  { name: 'up recalls history', keys: ['\x1b[A'], history: ['two', 'one'], want: { text: 'two' } },
  { name: 'up twice goes older', keys: ['\x1b[A', '\x1b[A'], history: ['two', 'one'], want: { text: 'one' } },
  {
    name: 'down comes back',
    keys: ['\x1b[A', '\x1b[A', '\x1b[B'],
    history: ['two', 'one'],
    want: { text: 'two' },
  },
  {
    name: 'down past the newest clears',
    keys: ['\x1b[A', '\x1b[B'],
    history: ['two', 'one'],
    want: { text: '' },
  },
  {
    name: 'down on a fresh draft keeps it',
    keys: ['\x1b[B'],
    text: 'hello world',
    history: ['one'],
    want: { text: 'hello world' },
  },
  {
    name: 'up then down restores the unsent draft',
    keys: ['\x1b[A', '\x1b[B'],
    text: 'hello world',
    history: ['two', 'one'],
    want: { text: 'hello world' },
  },
  {
    name: 'up moves within a multi-line draft',
    keys: ['\x1b[A'],
    text: 'ab\ncd',
    cursor: 4,
    want: { cursor: 1 },
  },
  {
    name: 'down moves within a multi-line draft',
    keys: ['\x1b[B'],
    text: 'ab\ncd',
    cursor: 1,
    want: { cursor: 4 },
  },
  { name: 'esc clears an idle draft', keys: ['\x1b'], text: 'hi', want: { text: '', cancels: [true] } },
  {
    name: 'esc leaves the draft while busy',
    keys: ['\x1b'],
    text: 'hi',
    busy: true,
    want: { text: 'hi', cancels: [true] },
  },
  { name: 'tab completes', keys: ['\t'], text: 'ab cd', complete: () => ['cdx'], want: { text: 'ab cdx ' } },
  {
    name: 'ctrl-r then enter takes the match',
    keys: ['\x12', 'h', '\r'],
    history: ['hello'],
    want: { text: 'hello' },
  },
  { name: 'word-left (alt-b)', keys: ['\x1bb'], text: S, cursor: 5, want: { cursor: 3 } },
  { name: 'word-left (ctrl-left)', keys: ['\x1b[1;5D'], text: S, cursor: 5, want: { cursor: 3 } },
  { name: 'word-left (alt-left)', keys: ['\x1b[1;3D'], text: S, cursor: 5, want: { cursor: 3 } },
  { name: 'word-right (alt-f)', keys: ['\x1bf'], text: S, cursor: 3, want: { cursor: 5 } },
  { name: 'word-right (ctrl-right)', keys: ['\x1b[1;5C'], text: S, cursor: 3, want: { cursor: 5 } },
  { name: 'word-right (alt-right)', keys: ['\x1b[1;3C'], text: S, cursor: 3, want: { cursor: 5 } },
  { name: 'ctrl-k cuts to the end of the line', keys: ['\x0b'], text: S, cursor: 5, want: { text: 'ab cd' } },
  {
    name: 'ctrl-u cuts to the start of the line',
    keys: ['\x15'],
    text: S,
    cursor: 5,
    want: { text: ' ef', cursor: 0 },
  },
  {
    name: 'ctrl-w cuts the word before',
    keys: ['\x17'],
    text: S,
    cursor: 5,
    want: { text: 'ab  ef', cursor: 3 },
  },
  {
    name: 'alt-backspace cuts the word before',
    keys: ['\x1b\x7f'],
    text: S,
    cursor: 5,
    want: { text: 'ab  ef', cursor: 3 },
  },
  { name: 'alt-d cuts the word after', keys: ['\x1bd'], text: S, cursor: 5, want: { text: 'ab cd' } },
  { name: 'ctrl-y pastes the last cut', keys: ['\x0b', '\x19'], text: S, cursor: 5, want: { text: S } },
  { name: 'ctrl-z undoes', keys: ['x', '\x1a'], text: '', want: { text: '' } },
  { name: 'ctrl-shift-z redoes', keys: ['x', '\x1a', '\x1b[122;6u'], text: '', want: { text: 'x' } },
  {
    name: 'ctrl-g hands the draft to the external editor',
    keys: ['\x07'],
    text: 'hi',
    want: { external: 1, text: 'hi' },
  },
  {
    name: 'ctrl-v asks the app for the clipboard image and types nothing',
    keys: ['\x16'],
    text: 'hi',
    want: { images: 1, text: 'hi' },
  },
  { name: 'alt-up is swallowed', keys: ['\x1b[1;3A'], text: 'hi', handled: true, want: { text: 'hi' } },
  {
    name: 'alt-up (esc esc [A) is swallowed',
    keys: ['\x1b\x1b[A'],
    text: 'hi',
    handled: true,
    want: { text: 'hi' },
  },
  {
    name: 'an unknown escape is swallowed',
    keys: ['\x1b[<35;1;1M'],
    text: 'hi',
    handled: true,
    want: { text: 'hi' },
  },
  { name: 'a printable character is typed', keys: ['x'], text: 'hi', want: { text: 'hix' } },
  ...[
    ['ctrl-d', '\x04'],
    ['ctrl-o', '\x0f'],
    ['ctrl-c', '\x03'],
    ['f1', '\x1bOP'],
    ['pgup', '\x1b[5~'],
    ['pgdn', '\x1b[6~'],
    ['ctrl-end', '\x1b[1;5F'],
  ].map(
    ([name, key]): Case => ({
      name: `${name} is not the editor's`,
      keys: [key as string],
      text: 'hi',
      handled: false,
      want: { text: 'hi' },
    }),
  ),
]

describe('key bindings: editor', () => {
  it.each(editorCases)('$name', (c) => {
    const seen = drive(c)
    expect(seen).toMatchObject(c.want)
    if (c.handled !== undefined) expect(seen.handled).toBe(c.handled)
  })
})

describe('key bindings: history search', () => {
  const search: Case[] = [
    {
      name: 'the first match is the newest',
      keys: ['\x12', 'h', 'e', '\r'],
      history: ['hello', 'help'],
      want: { text: 'hello' },
    },
    {
      name: 'ctrl-r steps to an older match',
      keys: ['\x12', 'h', 'e', '\x12', '\r'],
      history: ['help', 'hello'],
      want: { text: 'hello' },
    },
    {
      name: 'backspace erases a query character',
      keys: ['\x12', 'h', 'e', 'l', 'l', '\x7f', '\r'],
      history: ['hello', 'help'],
      want: { text: 'hello' },
    },
    {
      name: 'esc puts the draft back',
      keys: ['\x12', 'h', 'e', '\x1b'],
      text: 'zz',
      history: ['help'],
      want: { text: 'zz' },
    },
    {
      name: 'another key takes the match and acts',
      keys: ['\x12', 'h', 'e', '\x1b[D'],
      history: ['help'],
      want: { text: 'help', cursor: 3 },
    },
  ]
  it.each(search)('$name', (c) => expect(drive(c)).toMatchObject(c.want))
})

describe('key bindings: pickers', () => {
  const pick =
    (build: (choose: (id: string) => void, cancel: () => void) => { handleInput(d: string): boolean }) =>
    (keys: string[]) => {
      const log: string[] = []
      const c = build(
        (id) => log.push(`choose ${id}`),
        () => log.push('cancel'),
      )
      for (const k of keys) c.handleInput(k)
      return log
    }
  const options = ['a', 'b', 'c'].map((id) => ({ id, label: id }))
  const select = pick((onChoose, onCancel) => new Select({ options, onChoose, onCancel }))
  const filter = pick(
    (onChoose, onCancel) =>
      new FilterSelect({
        options: options.map((o) => ({ ...o, search: o.id })),
        locale: 'en',
        onChoose,
        onCancel,
      }),
  )
  it.each([
    ['down then enter', ['\x1b[B', '\r'], ['choose b']],
    ['down down up enter', ['\x1b[B', '\x1b[B', '\x1b[A', '\r'], ['choose b']],
    ['up stays at the top', ['\x1b[A', '\r'], ['choose a']],
    ['esc cancels', ['\x1b'], ['cancel']],
    ['a digit chooses its row', ['3'], ['choose c']],
  ])('select: %s', (_n, keys, want) => expect(select(keys as string[])).toEqual(want))
  it.each([
    ['down then enter', ['\x1b[B', '\r'], ['choose b']],
    ['esc cancels', ['\x1b'], ['cancel']],
    ['typing filters, esc clears it, a second esc cancels', ['c', '\x1b', '\x1b'], ['cancel']],
    ['typing then enter chooses the match', ['c', '\r'], ['choose c']],
    ['backspace drops a filter character', ['c', 'x', '\x7f', '\r'], ['choose c']],
    ['a digit chooses while the filter is empty', ['2'], ['choose b']],
  ])('filter select: %s', (_n, keys, want) => expect(filter(keys as string[])).toEqual(want))
})

describe('key bindings: report panel', () => {
  const open = () => {
    const panel = new UsagePanel({
      ansi: new TuiTheme('mono').ansi(createAnsi('none')),
      maxRows: () => 8,
      changed() {},
    })
    panel.show(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))
    return panel
  }
  const first = (p: UsagePanel): string => p.render(40).find((l) => l.includes('line ')) ?? ''
  it.each([
    ['esc', '\x1b'],
    ['enter', '\r'],
    ['ctrl-c', '\x03'],
    ['q', 'q'],
  ])('%s closes', (_n, key) => {
    const p = open()
    expect(p.handleInput(key)).toBe(true)
    expect(p.render(40)).toEqual([])
  })
  it.each([
    ['down', ['\x1b[B'], 'line 1'],
    // A page is the panel's body height; the key hints sit in the border, so the body is one row taller than before.
    ['pgdn', ['\x1b[6~'], 'line 6'],
    ['pgdn then pgup', ['\x1b[6~', '\x1b[5~'], 'line 0'],
    ['down, down, up', ['\x1b[B', '\x1b[B', '\x1b[A'], 'line 1'],
  ])('scrolls: %s', (_n, keys, want) => {
    const p = open()
    p.render(40)
    for (const k of keys as string[]) p.handleInput(k)
    expect(first(p)).toContain(want)
  })
})

describe('key bindings: approval modal', () => {
  const request: PermissionRequest = {
    sessionId: 's',
    toolCall: {
      title: 'write',
      rawInput: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])),
    },
    options: [
      { optionId: 'a', name: 'Allow', kind: 'allow_once' },
      { optionId: 'al', name: 'Always', kind: 'allow_always' },
      { optionId: 'r', name: 'Reject', kind: 'reject_once' },
    ],
  }
  const run = async (keys: string[]) => {
    const modal = new PermissionModal(vi.fn(), { maxRows: () => 12 })
    const answer = modal.ask(request, { signal: new AbortController().signal })
    modal.render(80)
    for (const k of keys) {
      modal.handleInput(k)
      modal.render(80)
    }
    return { modal, answer }
  }
  it.each([
    ['enter rejects by default', ['\r'], { optionId: 'r' }],
    [
      'up then enter keeps rejecting when the allow row is off screen or selects it',
      ['\x1b[A', '\x1b[A', '\r'],
      { optionId: 'a' },
    ],
    ['1 allows once', ['1'], { optionId: 'a' }],
    ['2 allows always', ['2'], { optionId: 'al' }],
    ['3 rejects', ['3'], { optionId: 'r' }],
    ['esc detaches', ['\x1b'], { unanswered: 'detached' }],
    ['ctrl-c detaches', ['\x03'], { unanswered: 'detached' }],
  ])('%s', async (_n, keys, want) => {
    const { answer } = await run(keys as string[])
    expect(await answer).toEqual(want)
  })
  it.each([
    ['y allows once', 'y', { optionId: 'a' }],
    ['n rejects', 'n', { optionId: 'r' }],
  ])('%s', async (_n, key, want) => {
    const { answer } = await run([key])
    expect(await answer).toEqual(want)
  })
  it('before the card has settled only esc, paging and the selection act; text is left to the draft', async () => {
    const modal = new PermissionModal(vi.fn(), { maxRows: () => 12 })
    const answer = modal.ask(request, { signal: new AbortController().signal })
    modal.render(80)
    for (const k of ['y', 'a', 'n', '1', '2', '3']) expect(modal.handleInput(k, false)).toBe(false)
    expect(modal.handleInput('\r', false)).toBe(true)
    expect(modal.handleInput('\x1b[A', false)).toBe(true)
    expect(modal.count).toBe(1)
    modal.handleInput('\x1b', false)
    expect(await answer).toEqual({ unanswered: 'detached' })
  })
  it('a decides nothing: an always-allow takes its number', async () => {
    const modal = new PermissionModal(vi.fn(), { maxRows: () => 12 })
    const answer = modal.ask(request, { signal: new AbortController().signal })
    expect(modal.render(80).join('\n')).not.toContain('[a]')
    expect(modal.handleInput('a')).toBe(true)
    expect(modal.count).toBe(1)
    modal.handleInput('2')
    expect(await answer).toEqual({ optionId: 'al' })
  })
  it('leaves the letters to the prompt while it holds a draft; numbers still decide', async () => {
    const modal = new PermissionModal(vi.fn(), { maxRows: () => 12, letters: () => false })
    const answer = modal.ask(request, { signal: new AbortController().signal })
    modal.render(80)
    for (const k of ['y', 'a', 'n']) expect(modal.handleInput(k, true)).toBe(false)
    expect(modal.count).toBe(1)
    modal.handleInput('1', true)
    expect(await answer).toEqual({ optionId: 'a' })
  })
  it('a new question gets a new head, so the guard restarts', () => {
    const modal = new PermissionModal(vi.fn())
    void modal.ask(request, { signal: new AbortController().signal })
    const first = modal.head
    void modal.ask(request, { signal: new AbortController().signal })
    modal.handleInput('\x1b')
    expect(modal.head).not.toBe(first)
  })
  it('pgdn and pgup page the details, down and up move the selection', async () => {
    const { modal } = await run([])
    const footer = () => modal.render(80).at(-1) ?? ''
    const before = footer()
    modal.handleInput('\x1b[6~')
    const paged = footer()
    expect(paged).not.toBe(before)
    modal.handleInput('\x1b[5~')
    expect(footer()).toBe(before)
    const selected = () => modal.render(80).find((l) => l.includes('❯')) ?? ''
    expect(selected()).toContain('3.')
    modal.handleInput('\x1b[A')
    expect(selected()).toContain('2.')
    modal.handleInput('\x1b[B')
    expect(selected()).toContain('3.')
  })
})

describe('key bindings: secret prompt', () => {
  const run = (keys: string[]) => {
    const log: string[] = []
    const v = new SecretInputView({
      onSubmit: (s) => log.push(`submit ${s}`),
      onBack: () => log.push('back'),
    })
    const handled = keys.map((k) => v.handleInput(k))
    return { log, handled }
  }
  it.each([
    ['enter submits', ['a', 'b', '\r'], ['submit ab']],
    ['backspace erases', ['a', 'b', '\x7f', '\r'], ['submit a']],
    ['esc goes back', ['a', '\x1b'], ['back']],
  ])('%s', (_n, keys, want) => expect(run(keys as string[]).log).toEqual(want))
  it('ctrl-c clears the secret and is left to the app', () => {
    expect(run(['a', '\x03']).handled).toEqual([true, false])
  })
})
