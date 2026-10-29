import { readPrefs, updatePrefs } from './prefs.js'

/**
 * The parts of the status line the user may turn off: the model, preset, usage (context gauge and
 * token line), directory, git branch, connection state and the extension `status.line` slot. The budget
 * warning, a parked approval ticket and error notices are not in this list: they are never hidden.
 */
export const STATUS_FIELDS = ['model', 'preset', 'usage', 'cwd', 'branch', 'link', 'slots'] as const
export type StatusField = (typeof STATUS_FIELDS)[number]

const KEY = 'statusLine'

/**
 * Which fields are shown. Stored as the ones hidden (`"statusLine": {"hide": ["cwd"]}`), so a field
 * added later is on for everyone who has not chosen otherwise. A file that cannot be read, or an
 * entry that is not a known field, leaves the defaults: every field shown.
 */
export class StatusLineConfig {
  private hidden = new Set<StatusField>()

  constructor(private readonly path?: string) {
    const saved = readPrefs(path)[KEY] as { hide?: unknown } | null | undefined
    const hide = saved !== null && typeof saved === 'object' && Array.isArray(saved.hide) ? saved.hide : []
    this.hidden = new Set(STATUS_FIELDS.filter((field) => hide.includes(field)))
  }

  shows(field: StatusField): boolean {
    return !this.hidden.has(field)
  }

  /** Flips one field and saves; false when the choice could not be written (it still holds for this run). */
  toggle(field: StatusField): boolean {
    if (this.hidden.has(field)) this.hidden.delete(field)
    else this.hidden.add(field)
    return this.save()
  }

  /** Every field shown again, and the saved choice removed. */
  reset(): boolean {
    this.hidden.clear()
    return this.save()
  }

  private save(): boolean {
    return updatePrefs(this.path, { [KEY]: this.hidden.size > 0 ? { hide: [...this.hidden] } : undefined })
  }
}
