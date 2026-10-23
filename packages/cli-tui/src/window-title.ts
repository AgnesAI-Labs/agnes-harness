import { basename } from 'node:path'
import type { UITimeline } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { tt } from './locale-extended.js'
import { readPrefs, updatePrefs } from './prefs.js'

/** What the terminal window title is made of; `off` leaves the title alone and writes no escape at all. */
export const TITLE_MODES = ['off', 'session', 'cwd', 'session-cwd'] as const
export type TitleMode = (typeof TITLE_MODES)[number]
/**
 * The title was already `agh · DIRECTORY` before `/title` existed, so that stays what no saved choice
 * means; `off` is one `/title off` away, and this is the one line to change if the default should flip.
 */
export const DEFAULT_TITLE_MODE: TitleMode = 'cwd'
/** Longest title written, in characters. */
export const TITLE_MAX = 80
/** In front of the title while a turn runs, and while an approval waits. */
const BUSY = '● '
const WAITING = '! '

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g

/** One line with no control or bidi character in it (so nothing can end the OSC early), cut to `TITLE_MAX`. */
export function cleanTitle(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').replace(UNSAFE, '').trim()).slice(0, TITLE_MAX).join('')
}

/**
 * The terminal window title (OSC 2), built from the session name and the directory name. TerminalSignals
 * writes it; this decides the text. The session name is read from the daemon's session list when the
 * session opens and when a turn ends, so a `/rename` shows from the next turn on; until it is known, or
 * when the session has none yet, the directory name stands in.
 */
export class WindowTitle {
  mode: TitleMode
  private name: string | undefined
  private seen: string | undefined
  private busy = false

  constructor(
    private readonly o: {
      /** The preferences file, where the mode is kept under `title`. */
      path?: string | undefined
      cwd: string
      session?: () => Pick<Session, 'id' | 'client'>
      changed?: () => void
    },
  ) {
    const saved = readPrefs(o.path).title
    this.mode = TITLE_MODES.find((mode) => mode === saved) ?? DEFAULT_TITLE_MODE
  }

  private get named(): boolean {
    return this.mode === 'session' || this.mode === 'session-cwd'
  }

  /** The title for the screen as it is now; undefined when the mode is `off`. */
  text(state: { busy: boolean; pending: boolean }): string | undefined {
    if (this.mode === 'off') return undefined
    const directory = basename(this.o.cwd)
    const name =
      this.mode === 'cwd'
        ? directory
        : this.mode === 'session'
          ? (this.name ?? directory)
          : [this.name, directory].filter(Boolean).join(' · ')
    return cleanTitle(`${state.pending ? WAITING : state.busy ? BUSY : ''}agh · ${name}`)
  }

  /** Fed every projected timeline: reads the session name again when a session opens and when a turn ends. */
  tick(timeline: Pick<UITimeline, 'sessionId' | 'opState'>): void {
    const opened = timeline.sessionId !== this.seen
    if (opened) this.name = undefined
    const ended = this.busy && !timeline.opState
    this.seen = timeline.sessionId
    this.busy = Boolean(timeline.opState)
    if (opened || ended) this.refresh()
  }

  private refresh(): void {
    const session = this.o.session?.()
    if (!this.named || !session) return
    void session.client.session
      .list({ limit: 500 })
      .then((page) => {
        const title = page.items.find((item) => item.sessionId === session.id)?.title
        if (this.o.session?.().id !== session.id || title === this.name) return
        this.name = title
        this.o.changed?.()
      })
      .catch(() => {})
  }

  /** `/title [off|session|cwd|session-cwd]`: sets and saves the mode, or says which one is in force. */
  command(args: readonly string[], locale: string): string {
    const [arg] = args
    const mode = TITLE_MODES.find((m) => m === arg)
    if (args.length > 1 || (arg !== undefined && mode === undefined)) return tt('title.usage', locale)
    if (mode === undefined) return `${tt(`title.${this.mode}`, locale)} · ${tt('title.usage', locale)}`
    this.mode = mode
    this.refresh()
    this.o.changed?.()
    const saved = updatePrefs(this.o.path, { title: mode })
    return `${tt(`title.${mode}`, locale)}${saved ? '' : tt('title.unsaved', locale)}`
  }
}
