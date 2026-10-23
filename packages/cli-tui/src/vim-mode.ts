import {
  lineColumn,
  lineEndOf,
  lineStartOf,
  moveLine,
  nextBoundaryOf,
  nextWordStart,
  prevBoundaryOf,
  prevWordStart,
  wordEndAt,
  wordLastChar,
} from './edit-motion.js'
import { type ActionOf, actionFor, currentKeymap } from './keymap.js'
import { tt } from './locale-extended.js'
import { readPrefs, updatePrefs } from './prefs.js'

/** What the state machine reads and changes: the editor's draft, its kill ring and its undo stack. */
export interface VimTarget {
  text: string
  cursor: number
  /** Cuts `[from, to)` into the kill ring (as `register` when given), leaving the cursor at `from`. */
  cut(from: number, to: number, register?: string): void
  /** The newest kill-ring entry. */
  register(): string | undefined
  undoEdit(): void
  redoEdit(): void
}

export type VimModeName = 'insert' | 'normal'
type Act = ActionOf<'vim'>

// A number before these repeats them; before any other command it cancels the command, so `3dd` never
// deletes one line when three were asked for.
const MOVES: ReadonlySet<Act> = new Set([
  'vim-left',
  'vim-down',
  'vim-up',
  'vim-right',
  'vim-word',
  'vim-word-back',
  'vim-word-end',
  'vim-top',
  'vim-bottom',
])
const MAX_COUNT = 9999

const firstNonBlank = (text: string, from: number): number => {
  const end = lineEndOf(text, from)
  let at = from
  while (at < end && (text[at] === ' ' || text[at] === '\t')) at++
  return at
}

/** Offset where the `n`-th line (1-based, clamped to the last one) begins. */
function lineAt(text: string, n: number): number {
  let at = 0
  for (let i = 1; i < n; i++) {
    const next = text.indexOf('\n', at)
    if (next < 0) break
    at = next + 1
  }
  return at
}

/**
 * The prompt's vim mode: a switch kept in the preferences file (`vim`), the mode the editor is in, and the
 * normal-mode commands. Normal mode takes the keys the `vim` scope of the key table names; any other letter
 * is swallowed and every named key (arrows, Enter, Ctrl-keys) keeps its editor meaning. The cursor stands
 * on a character, so it never rests past the end of a line.
 */
export class Vim {
  enabled: boolean
  mode: VimModeName = 'insert'
  private pending = ''
  private count = ''

  constructor(private readonly path?: string) {
    this.enabled = readPrefs(path).vim === true
  }

  get normal(): boolean {
    return this.enabled && this.mode === 'normal'
  }

  /** `/vim [on|off]`: sets and saves the switch, or flips it. The editor starts in insert mode either way. */
  command(args: readonly string[], locale: string): string {
    const [arg] = args
    if (args.length > 1 || (arg !== undefined && arg !== 'on' && arg !== 'off'))
      return tt('vim.usage', locale)
    this.enabled = arg === undefined ? !this.enabled : arg === 'on'
    this.mode = 'insert'
    this.reset()
    const saved = updatePrefs(this.path, { vim: this.enabled })
    return `${tt(this.enabled ? 'vim.on' : 'vim.off', locale)}${saved ? '' : tt('vim.unsaved', locale)}`
  }

  /** Back to typing: a sent prompt starts the next one in insert mode. */
  insert(): void {
    this.mode = 'insert'
    this.reset()
  }

  /** Esc in insert mode: the cursor steps back onto the last character typed, as it does in vim. */
  leaveInsert(t: VimTarget): void {
    this.mode = 'normal'
    this.reset()
    if (t.cursor > lineStartOf(t.text, t.cursor)) t.cursor = prevBoundaryOf(t.text, t.cursor)
  }

  /** Esc in normal mode: true when it only dropped a half-typed command, so the caller does nothing more. */
  cancelPending(): boolean {
    const had = this.pending !== '' || this.count !== ''
    this.reset()
    return had
  }

  /** One typed character, or the name of a key the `vim` scope binds (Ctrl-R). */
  press(key: string, t: VimTarget): void {
    if (/^[0-9]$/.test(key) && this.pending === '' && (key !== '0' || this.count !== '')) {
      this.count = (this.count + key).slice(0, 4)
      return
    }
    const seq = this.pending + key
    const act = actionFor('vim', seq)
    if (act === undefined) {
      // A first key that starts a longer binding (`d`, `c`, `g`) waits for the next one; anything else ends the command.
      const starts = currentKeymap()
        .effective()
        .some(
          (row) => row.scope === 'vim' && row.keys.some((k) => k.length > seq.length && k.startsWith(seq)),
        )
      this.pending = starts && this.pending === '' ? seq : ''
      if (this.pending === '') this.count = ''
      return
    }
    const n = this.count === '' ? undefined : Math.min(MAX_COUNT, Number(this.count))
    this.reset()
    if (n === undefined || MOVES.has(act)) this.run(act, n, t)
    if (this.mode === 'normal') this.clamp(t)
  }

  private reset(): void {
    this.pending = ''
    this.count = ''
  }

  /** The cursor rests on a character: at the end of a non-empty line it steps back onto the last one. */
  private clamp(t: VimTarget): void {
    t.cursor = Math.min(t.cursor, t.text.length)
    const end = lineEndOf(t.text, t.cursor)
    if (t.cursor >= end && end > lineStartOf(t.text, t.cursor)) t.cursor = prevBoundaryOf(t.text, end)
  }

  private run(act: Act, n: number | undefined, t: VimTarget): void {
    const each = (step: () => void): void => {
      for (let i = 0; i < (n ?? 1); i++) step()
    }
    const start = (): number => lineStartOf(t.text, t.cursor)
    const end = (): number => lineEndOf(t.text, t.cursor)
    const insert = (): void => {
      this.mode = 'insert'
    }
    const go = (line: number | undefined, fallback: number): void => {
      t.cursor = firstNonBlank(t.text, line === undefined ? fallback : lineAt(t.text, line))
    }
    switch (act) {
      case 'vim-left':
        each(() => {
          if (t.cursor > start()) t.cursor = prevBoundaryOf(t.text, t.cursor)
        })
        break
      case 'vim-right':
        each(() => {
          const next = nextBoundaryOf(t.text, t.cursor)
          if (next < end()) t.cursor = next
        })
        break
      case 'vim-down':
      case 'vim-up':
        each(() => {
          t.cursor =
            moveLine(t.text, t.cursor, act === 'vim-down' ? 1 : -1, lineColumn(t.text, t.cursor)) ?? t.cursor
        })
        break
      case 'vim-word':
        each(() => {
          t.cursor = nextWordStart(t.text, t.cursor)
        })
        break
      case 'vim-word-back':
        each(() => {
          t.cursor = prevWordStart(t.text, t.cursor)
        })
        break
      case 'vim-word-end':
        each(() => {
          t.cursor = wordLastChar(t.text, t.cursor)
        })
        break
      case 'vim-line-start':
        t.cursor = start()
        break
      case 'vim-line-first':
        t.cursor = firstNonBlank(t.text, start())
        break
      case 'vim-line-end':
        t.cursor = end() > start() ? prevBoundaryOf(t.text, end()) : start()
        break
      case 'vim-top':
        go(n, 0)
        break
      case 'vim-bottom':
        go(n, t.text.lastIndexOf('\n') + 1)
        break
      case 'vim-insert':
        insert()
        break
      case 'vim-append':
        if (t.cursor < end()) t.cursor = nextBoundaryOf(t.text, t.cursor)
        insert()
        break
      case 'vim-insert-start':
        t.cursor = firstNonBlank(t.text, start())
        insert()
        break
      case 'vim-append-end':
        t.cursor = end()
        insert()
        break
      case 'vim-open-below': {
        const at = end()
        t.text = `${t.text.slice(0, at)}\n${t.text.slice(at)}`
        t.cursor = at + 1
        insert()
        break
      }
      case 'vim-open-above': {
        const at = start()
        t.text = `${t.text.slice(0, at)}\n${t.text.slice(at)}`
        t.cursor = at
        insert()
        break
      }
      case 'vim-delete-char':
        if (t.cursor < end()) t.cut(t.cursor, nextBoundaryOf(t.text, t.cursor))
        break
      case 'vim-delete-line': {
        // The line and one of its newlines go; the register keeps the line with its own, so `p` puts it back as a line.
        const [from, to] = [start(), end()]
        const [cutFrom, cutTo] = to < t.text.length ? [from, to + 1] : from > 0 ? [from - 1, to] : [from, to]
        t.cut(cutFrom, cutTo, `${t.text.slice(from, to)}\n`)
        t.cursor = firstNonBlank(t.text, lineStartOf(t.text, t.cursor))
        break
      }
      case 'vim-delete-word':
        t.cut(t.cursor, Math.min(end(), nextWordStart(t.text, t.cursor)))
        break
      case 'vim-delete-to-end':
        t.cut(t.cursor, end())
        break
      case 'vim-change-word':
        // Like vim's `cw`: inside a word it stops at the word's end and keeps the space after it.
        t.cut(t.cursor, Math.min(end(), wordEndAt(t.text, t.cursor) ?? nextWordStart(t.text, t.cursor)))
        insert()
        break
      case 'vim-change-to-end':
        t.cut(t.cursor, end())
        insert()
        break
      case 'vim-paste':
      case 'vim-paste-before': {
        const text = t.register()
        if (text === undefined) return
        const after = act === 'vim-paste'
        if (text.endsWith('\n')) {
          // A whole line goes below (or above) the current one.
          const at = after ? end() : start()
          const atEnd = after && at === t.text.length
          t.text = atEnd
            ? `${t.text}\n${text.slice(0, -1)}`
            : `${t.text.slice(0, after ? at + 1 : at)}${text}${t.text.slice(after ? at + 1 : at)}`
          t.cursor = firstNonBlank(t.text, after ? at + 1 : at)
          break
        }
        const at = after && t.cursor < end() ? nextBoundaryOf(t.text, t.cursor) : t.cursor
        t.text = t.text.slice(0, at) + text + t.text.slice(at)
        t.cursor = prevBoundaryOf(t.text, at + text.length)
        break
      }
      case 'vim-undo':
        t.undoEdit()
        break
      case 'vim-redo':
        t.redoEdit()
        break
      case 'vim-normal':
        break
    }
  }
}
