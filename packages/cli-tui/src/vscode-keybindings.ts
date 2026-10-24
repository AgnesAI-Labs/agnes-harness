import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** What Shift+Enter sends in the terminal: ESC then Return, which the TUI reads as Alt+Enter, a newline. */
export const SHIFT_ENTER_ENTRY = {
  key: 'shift+enter',
  command: 'workbench.action.terminal.sendSequence',
  args: { text: '\u001b\r' },
  when: 'terminalFocus',
}
/** The same entry as it is written into the file (JSON escapes, so no raw control character lands there). */
export const SHIFT_ENTER_JSON =
  '{ "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\\u001b\\r" }, "when": "terminalFocus" }'

export type Editor = 'Code' | 'Code - Insiders' | 'Cursor'
export type Refusal = 'unsafe' | 'conflict' | 'already' | 'noDirectory'

/** The editor's per-user keybindings.json (`User/keybindings.json` under its settings directory). */
export function keybindingsPath(
  editor: Editor,
  platform: NodeJS.Platform = process.platform, // guards-allow-platform: the keybindings file lives under the editor's per-OS settings directory.
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const base =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? join(home, '.config'))
  return join(base, editor, 'User', 'keybindings.json')
}

type Scan = { entries: unknown[]; last: number }

/**
 * Reads the JSON-with-comments array VS Code keeps its keybindings in: its entries, and the index of the
 * last token inside the array (its `[` when empty). Strings, `//` and block comments, and trailing commas
 * are understood; anything else (a second top-level value, a non-array, broken syntax) is `undefined`.
 */
function scan(text: string): Scan | undefined {
  const clean: string[] = []
  let depth = 0
  let open = -1
  let close = -1
  let last = -1
  let quote = false
  let line = false
  let block = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    const next = text[i + 1]
    if (line) {
      line = c !== '\n'
      clean.push(c === '\n' ? c : ' ')
      continue
    }
    if (block) {
      block = !(c === '*' && next === '/')
      clean.push(' ')
      if (!block) {
        clean.push(' ')
        i++
      }
      continue
    }
    if (quote) {
      clean.push(c)
      last = i
      if (c === '\\') {
        clean.push(next ?? '')
        i++
      } else if (c === '"') quote = false
      continue
    }
    if (c === '/' && (next === '/' || next === '*')) {
      line = next === '/'
      block = next === '*'
      clean.push(' ', ' ')
      i++
      continue
    }
    clean.push(c)
    if (/\s/.test(c)) continue
    // Anything significant outside the one array, before it or after it, is not a file this edits.
    if (depth === 0 && !(c === '[' && open < 0)) return undefined
    const previous = last
    last = i
    if (c === '"') quote = true
    else if (c === '[' || c === '{') {
      depth++
      if (open < 0) open = i
    } else if (c === ']' || c === '}') {
      depth--
      if (depth < 0) return undefined
      let j = clean.length - 2
      while (j >= 0 && /\s/.test(clean[j] as string)) j--
      if (clean[j] === ',') clean[j] = ' '
      if (depth === 0) {
        if (c !== ']') return undefined
        close = i
        last = previous
      }
    }
  }
  if (open < 0 || close < 0 || depth !== 0 || quote || block) return undefined
  try {
    const value: unknown = JSON.parse(clean.join(''))
    return Array.isArray(value) ? { entries: value, last } : undefined
  } catch {
    return undefined
  }
}

/**
 * `text` with the Shift+Enter entry appended as the array's last element and nothing else changed: the
 * text before and after the insertion is byte for byte the original, comments included. Refuses (never
 * guesses) a file it cannot read as that array, one that already binds shift+enter to a terminal
 * sequence, and any result that does not read back as the old entries plus this one.
 */
export function appendShiftEnter(text: string): { text: string } | { refused: Refusal } {
  const before = scan(text)
  if (!before) return { refused: 'unsafe' }
  const bound = before.entries.find(
    (entry) =>
      (entry as { key?: unknown } | null)?.key === 'shift+enter' &&
      (entry as { command?: unknown }).command === SHIFT_ENTER_ENTRY.command,
  )
  if (bound) {
    const sent = (bound as { args?: { text?: unknown } }).args?.text
    return { refused: sent === SHIFT_ENTER_ENTRY.args.text ? 'already' : 'conflict' }
  }
  const mark = text[before.last]
  const comma = mark === '[' || mark === ',' ? '' : ','
  const after = `${text.slice(0, before.last + 1)}${comma}\n  ${SHIFT_ENTER_JSON}${text.slice(before.last + 1)}`
  const check = scan(after)
  const same = JSON.stringify([...before.entries, SHIFT_ENTER_ENTRY])
  return check && JSON.stringify(check.entries) === same ? { text: after } : { refused: 'unsafe' }
}

export type Plan = { path: string; backup: string | undefined; before: string | undefined; after: string }

const stamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '')

/** What writing the entry into `path` would do: the new text and the backup of the old file, or why not. */
export function planShiftEnter(path: string, now: Date = new Date()): Plan | { refused: Refusal } {
  if (!existsSync(path)) {
    if (!existsSync(dirname(path))) return { refused: 'noDirectory' }
    return { path, backup: undefined, before: undefined, after: `[\n  ${SHIFT_ENTER_JSON}\n]\n` }
  }
  const before = readFileSync(path, 'utf8')
  const result = appendShiftEnter(before)
  if ('refused' in result) return result
  return { path, backup: `${path}.agh-backup-${stamp(now)}`, before, after: result.text }
}

/**
 * Writes a plan: the old file is copied to the backup first (never over an existing file), then the new
 * text replaces it through a temporary file in the same directory. A symlinked keybindings.json (a dotfiles
 * setup) keeps being a link: the real file is the one replaced, with its permissions.
 */
export function applyPlan(plan: Plan): void {
  if (plan.before === undefined) {
    writeFileSync(plan.path, plan.after, { flag: 'wx' })
    return
  }
  const real = realpathSync(plan.path)
  if (plan.backup) copyFileSync(real, plan.backup, constants.COPYFILE_EXCL)
  const temporary = `${real}.agh-${process.pid}.tmp`
  writeFileSync(temporary, plan.after, { mode: statSync(real).mode & 0o777, flag: 'wx' })
  renameSync(temporary, real)
}
