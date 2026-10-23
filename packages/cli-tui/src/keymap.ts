import type { KeyName } from './keys.js'

/** Letters the approval scope reads as keys: single-key decisions, never rebindable. */
export type ApprovalLetter = 'y' | 'a' | 'n'
type BoundKey = KeyName | ApprovalLetter

/**
 * Every key binding, declared once. A scope is a place that reads keys; inside one scope a key means
 * one action. Code asks `actionFor(scope, key)` and switches on the action, never on the key.
 * `fixed` rows are escape hatches and approval keys: they stay as shipped whatever the user writes.
 */
export const BINDINGS = [
  // App level, tried before the editor.
  { id: 'interrupt', scope: 'global', keys: ['ctrl-c'], fixed: true },
  { id: 'quit', scope: 'global', keys: ['ctrl-d'], fixed: true },
  { id: 'card-toggle', scope: 'global', keys: ['ctrl-o'] },
  { id: 'hint-1', scope: 'global', keys: ['f1'] },
  { id: 'hint-2', scope: 'global', keys: ['f2'] },
  { id: 'hint-3', scope: 'global', keys: ['f3'] },
  { id: 'hint-4', scope: 'global', keys: ['f4'] },
  { id: 'timeline-bottom', scope: 'global', keys: ['ctrl-end', 'end'] },
  { id: 'timeline-page-up', scope: 'global', keys: ['pgup'] },
  { id: 'timeline-page-down', scope: 'global', keys: ['pgdn'] },
  { id: 'steer', scope: 'global', keys: ['alt-enter'] },
  { id: 'queue-recall', scope: 'global', keys: ['alt-up'] },
  { id: 'thinking-cycle', scope: 'global', keys: ['shift-tab'] },
  { id: 'model-next', scope: 'global', keys: ['alt-p'] },
  { id: 'model-prev', scope: 'global', keys: ['alt-shift-p'] },
  { id: 'draft-stash', scope: 'global', keys: ['ctrl-s'] },
  // The prompt editor.
  { id: 'submit', scope: 'editor', keys: ['enter'] },
  { id: 'newline', scope: 'editor', keys: ['alt-enter', 'shift-enter'] },
  { id: 'delete-back', scope: 'editor', keys: ['backspace'] },
  { id: 'cursor-left', scope: 'editor', keys: ['left', 'ctrl-b'] },
  { id: 'cursor-right', scope: 'editor', keys: ['right', 'ctrl-f'] },
  { id: 'line-start', scope: 'editor', keys: ['home', 'ctrl-a'] },
  { id: 'line-end', scope: 'editor', keys: ['end', 'ctrl-e'] },
  { id: 'move-up', scope: 'editor', keys: ['up'] },
  { id: 'move-down', scope: 'editor', keys: ['down'] },
  { id: 'cancel', scope: 'editor', keys: ['esc'] },
  { id: 'complete', scope: 'editor', keys: ['tab'] },
  { id: 'history-search', scope: 'editor', keys: ['ctrl-r'] },
  { id: 'word-left', scope: 'editor', keys: ['word-left'] },
  { id: 'word-right', scope: 'editor', keys: ['word-right'] },
  { id: 'cut-to-end', scope: 'editor', keys: ['ctrl-k'] },
  { id: 'cut-to-start', scope: 'editor', keys: ['ctrl-u'] },
  { id: 'cut-word-back', scope: 'editor', keys: ['ctrl-w', 'word-delete-back'] },
  { id: 'cut-word', scope: 'editor', keys: ['word-delete'] },
  { id: 'yank', scope: 'editor', keys: ['ctrl-y'] },
  { id: 'yank-pop', scope: 'editor', keys: ['alt-y'] },
  { id: 'undo', scope: 'editor', keys: ['ctrl-z'] },
  { id: 'redo', scope: 'editor', keys: ['ctrl-shift-z'] },
  { id: 'external-edit', scope: 'editor', keys: ['ctrl-g'] },
  { id: 'paste-image', scope: 'editor', keys: ['ctrl-v'] },
  // Ctrl-R history search; any other key accepts the match and then does what it always does.
  { id: 'search-older', scope: 'search', keys: ['ctrl-r'] },
  { id: 'search-erase', scope: 'search', keys: ['backspace'] },
  { id: 'search-cancel', scope: 'search', keys: ['esc'] },
  { id: 'search-accept', scope: 'search', keys: ['enter'] },
  // Pickers and option lists.
  { id: 'picker-up', scope: 'picker', keys: ['up'], fixed: true },
  { id: 'picker-down', scope: 'picker', keys: ['down'], fixed: true },
  { id: 'picker-choose', scope: 'picker', keys: ['enter'], fixed: true },
  { id: 'picker-cancel', scope: 'picker', keys: ['esc'], fixed: true },
  { id: 'picker-erase', scope: 'picker', keys: ['backspace'], fixed: true },
  { id: 'picker-page-up', scope: 'picker', keys: ['pgup'], fixed: true },
  { id: 'picker-page-down', scope: 'picker', keys: ['pgdn'], fixed: true },
  { id: 'picker-scope', scope: 'picker', keys: ['tab'], fixed: true },
  // Read-only report panels.
  { id: 'panel-close', scope: 'panel', keys: ['esc', 'enter', 'ctrl-c'], fixed: true },
  { id: 'panel-up', scope: 'panel', keys: ['up'], fixed: true },
  { id: 'panel-down', scope: 'panel', keys: ['down'], fixed: true },
  { id: 'panel-page-up', scope: 'panel', keys: ['pgup'], fixed: true },
  { id: 'panel-page-down', scope: 'panel', keys: ['pgdn'], fixed: true },
  // The approval dialog: never rebindable, so a changed key cannot approve by accident.
  { id: 'approval-dismiss', scope: 'approval', keys: ['esc', 'ctrl-c'], fixed: true },
  { id: 'approval-confirm', scope: 'approval', keys: ['enter'], fixed: true },
  { id: 'approval-up', scope: 'approval', keys: ['up'], fixed: true },
  { id: 'approval-down', scope: 'approval', keys: ['down'], fixed: true },
  { id: 'approval-page-up', scope: 'approval', keys: ['pgup'], fixed: true },
  { id: 'approval-page-down', scope: 'approval', keys: ['pgdn'], fixed: true },
  // Single-key decisions, live once the card has settled (approval-settle.ts); the same decisions as the numbers.
  { id: 'approval-allow-once', scope: 'approval', keys: ['y'], fixed: true },
  { id: 'approval-allow-always', scope: 'approval', keys: ['a'], fixed: true },
  { id: 'approval-reject', scope: 'approval', keys: ['n'], fixed: true },
  // Secret and text prompts.
  { id: 'secret-submit', scope: 'secret', keys: ['enter'], fixed: true },
  { id: 'secret-erase', scope: 'secret', keys: ['backspace'], fixed: true },
  { id: 'secret-back', scope: 'secret', keys: ['esc'], fixed: true },
  { id: 'secret-abort', scope: 'secret', keys: ['ctrl-c'], fixed: true },
] as const satisfies readonly {
  id: string
  scope: string
  keys: readonly BoundKey[]
  fixed?: true
}[]

export type Binding = (typeof BINDINGS)[number]
export type ActionId = Binding['id']
export type Scope = Binding['scope']
/** The ids of one scope, so a switch over `actionFor('editor', ...)` is checked against the table. */
export type ActionOf<S extends Scope> = Extract<Binding, { scope: S }>['id']

export type Effective = {
  id: ActionId
  scope: Scope
  keys: readonly BoundKey[]
  fixed: boolean
  overridden: boolean
}

/** The bindings in force: the table's defaults, with any accepted overrides laid over them. */
export class Keymap {
  private readonly rows: Effective[]
  private readonly lookup = new Map<string, ActionId>()

  constructor(overrides: ReadonlyMap<ActionId, readonly KeyName[]> = new Map()) {
    this.rows = BINDINGS.map((b) => {
      const keys = overrides.get(b.id)
      return {
        id: b.id,
        scope: b.scope,
        keys: keys ?? b.keys,
        fixed: 'fixed' in b,
        overridden: keys !== undefined,
      }
    })
    for (const row of this.rows) for (const key of row.keys) this.lookup.set(`${row.scope}:${key}`, row.id)
  }

  action<S extends Scope>(scope: S, key: string): ActionOf<S> | undefined {
    return this.lookup.get(`${scope}:${key}`) as ActionOf<S> | undefined
  }

  effective(): readonly Effective[] {
    return this.rows
  }
}

let current = new Keymap()

/** Swaps the bindings in force; called once at startup, and by tests. */
export function installKeymap(keymap: Keymap): void {
  current = keymap
}

export function actionFor<S extends Scope>(scope: S, key: string): ActionOf<S> | undefined {
  return current.action(scope, key)
}

export const currentKeymap = (): Keymap => current
