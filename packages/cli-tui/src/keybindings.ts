import { readFileSync } from 'node:fs'
import { escapeControl } from './component.js'
import {
  type ActionId,
  BINDINGS,
  currentKeymap,
  type Effective,
  installKeymap,
  Keymap,
  type Scope,
} from './keymap.js'
import { KEY_NAMES, type KeyName } from './keys.js'
import { tt } from './locale-extended.js'
import { KEYS_SCOPES } from './locale-keys.js'

/** Why one entry of keybindings.json was left out; the rest of the file still applies. */
export type Problem = {
  code: 'file' | 'unknown' | 'fixed' | 'shape' | 'key' | 'reserved' | 'conflict'
  id?: string
  detail?: string
}

// Text and unreadable escapes are not keys a binding can name.
const BINDABLE: ReadonlySet<string> = new Set(
  KEY_NAMES.filter((k) => k !== 'char' && k !== 'paste' && k !== 'unknown'),
)
// Ctrl-C and Ctrl-D end or interrupt the program; no action may take them over.
const RESERVED: ReadonlySet<string> = new Set(
  BINDINGS.filter((b) => b.scope === 'global' && 'fixed' in b).flatMap((b) => [...b.keys]),
)
// Global keys are tried before the editor, so an unconditional one hides an editor key of the same name.
// Only these act in some states (a running turn, an empty draft, End over an empty draft); the editor
// may share their key.
const sharesKey = (id: string, key: string): boolean =>
  id === 'steer' || id === 'queue-recall' || (id === 'timeline-bottom' && key === 'end')
const shown = (text: string): string => escapeControl(text).slice(0, 40)

/**
 * Lays the user's `{ "action": ["key", ...] }` over the defaults. An entry that is wrong in any way
 * is skipped with a reason; an unreadable file means the defaults stay. Nothing here throws.
 */
export function readKeybindings(path: string | undefined): { keymap: Keymap; problems: Problem[] } {
  const problems: Problem[] = []
  let raw: string
  try {
    raw = readFileSync(path ?? '', 'utf8')
  } catch (error) {
    if (path && (error as NodeJS.ErrnoException).code !== 'ENOENT')
      problems.push({ code: 'file', detail: shown(String((error as Error).message)) })
    return { keymap: new Keymap(), problems }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      keymap: new Keymap(),
      problems: [{ code: 'file', detail: shown(String((error as Error).message)) }],
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { keymap: new Keymap(), problems: [{ code: 'file', detail: 'not an object' }] }

  const byId = new Map(BINDINGS.map((b) => [b.id as string, b]))
  const accepted = new Map<ActionId, KeyName[]>()
  const keysOf = (b: (typeof BINDINGS)[number]): readonly string[] => accepted.get(b.id) ?? b.keys
  const overlaps = (a: Scope, b: Scope): boolean =>
    a === b ||
    (a === 'global' ? b === 'editor' || b === 'search' : b === 'global' && (a === 'editor' || a === 'search'))
  const holds = (binding: (typeof BINDINGS)[number], key: string): boolean =>
    BINDINGS.some(
      (b) =>
        b.id !== binding.id &&
        overlaps(binding.scope, b.scope) &&
        (b.scope === binding.scope || !sharesKey(b.scope === 'global' ? b.id : binding.id, key)) &&
        keysOf(b).includes(key),
    )
  for (const [id, value] of Object.entries(parsed)) {
    const binding = byId.get(id)
    if (!binding) problems.push({ code: 'unknown', id: shown(id) })
    else if ('fixed' in binding) problems.push({ code: 'fixed', id })
    else if (!Array.isArray(value) || value.length === 0 || value.some((k) => typeof k !== 'string'))
      problems.push({ code: 'shape', id })
    else {
      const keys = [...new Set(value as string[])]
      const bad = keys.find((k) => !BINDABLE.has(k))
      const reserved = keys.find((k) => RESERVED.has(k))
      const taken = keys.find((k) => holds(binding, k))
      if (bad !== undefined) problems.push({ code: 'key', id, detail: shown(bad) })
      else if (reserved !== undefined) problems.push({ code: 'reserved', id, detail: reserved })
      else if (taken !== undefined) problems.push({ code: 'conflict', id, detail: taken })
      else accepted.set(binding.id, keys as KeyName[])
    }
  }
  return { keymap: new Keymap(accepted), problems }
}

let loaded: { path: string | undefined; problems: Problem[] } | undefined

/** Reads the file once per process and puts its bindings in force; returns the notice to show, if any. */
export function installKeybindings(path: string | undefined, locale: string): string | undefined {
  if (loaded?.path !== path || loaded === undefined) {
    const read = readKeybindings(path)
    installKeymap(read.keymap)
    loaded = { path, problems: read.problems }
  }
  const [first] = loaded.problems
  if (!first) return undefined
  return first.code === 'file'
    ? tt('keys.noticeFile', locale, { detail: first.detail ?? '' })
    : tt('keys.notice', locale, { n: loaded.problems.length })
}

export const keybindingProblems = (): readonly Problem[] => loaded?.problems ?? []

function problemText(p: Problem, locale: string): string {
  return tt(`keys.problem.${p.code}`, locale, { id: p.id ?? '', detail: p.detail ?? '' })
}

/** The body of /keys: what is in force by scope, overrides marked, then anything that was ignored. */
export function formatKeys(
  locale: string,
  keymap: Keymap = currentKeymap(),
  problems: readonly Problem[] = keybindingProblems(),
): string {
  const defaults = new Map(BINDINGS.map((b) => [b.id as string, b.keys as readonly string[]]))
  const row = (r: Effective): string => {
    const mark = r.fixed
      ? ` [${tt('keys.fixed', locale)}]`
      : r.overridden
        ? ` [${tt('keys.overridden', locale, { keys: (defaults.get(r.id) ?? []).join(' ') })}]`
        : ''
    return `  ${r.id.padEnd(20)} ${r.keys.join(' ').padEnd(24)} ${tt(`keys.act.${r.id}`, locale)}${mark}`
  }
  const lines: string[] = []
  for (const scope of KEYS_SCOPES) {
    lines.push(
      tt(`keys.scope.${scope}`, locale),
      ...keymap
        .effective()
        .filter((r) => r.scope === scope)
        .map(row),
      '',
    )
  }
  lines.push(tt('keys.names', locale, { names: [...BINDABLE].join(' ') }))
  if (problems.length > 0)
    lines.push(
      '',
      `${tt('keys.problemsHeading', locale)}:`,
      ...problems.map((p) => `  ${problemText(p, locale)}`),
    )
  return lines.join('\n')
}
