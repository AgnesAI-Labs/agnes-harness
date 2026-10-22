import { basename } from 'node:path'
import { escapeControl } from './component.js'

const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
const BEL = '\x07'

/**
 * What takes the user's eyes off the terminal and brings them back: a bell when a turn ends or an
 * approval starts waiting while the window is in the background, and a window title that says whether
 * the session is working or waiting. The title is saved on start and put back on stop, so the shell
 * gets its own title back. OSC 9 desktop notifications are left out: terminals disagree on what it means.
 */
export class TerminalSignals {
  private focused = true
  private started = false
  private wasBusy = false
  private seen = new Set<string>()
  private title = ''

  constructor(
    private readonly term: { write(s: string): void },
    private readonly cwd: string,
    private readonly busy: () => boolean,
    // Questions the permission dialog holds, and the approval cards by id.
    private readonly modal: { readonly count: number },
    private readonly cards: ReadonlyMap<string, { readonly pending: boolean }>,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.term.write('\x1b[22;0t')
    this.sync()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.term.write('\x1b[23;0t')
  }

  /** Consumes a focus report; true when `data` was one. */
  focus(data: string): boolean {
    if (data !== FOCUS_IN && data !== FOCUS_OUT) return false
    this.focused = data === FOCUS_IN
    return true
  }

  /** Called on every frame: acts on edges only, so repeating it changes nothing. */
  sync(): void {
    if (!this.started) return
    const busy = this.busy()
    const pending = new Set<string>()
    for (let i = 0; i < this.modal.count; i++) pending.add(`ask:${i}`)
    for (const [id, card] of this.cards) if (card.pending) pending.add(id)
    const arrived = [...pending].some((id) => !this.seen.has(id))
    const ended = this.wasBusy && !busy
    this.seen = pending
    this.wasBusy = busy
    if ((arrived || ended) && !this.focused) this.term.write(BEL)
    const mark = pending.size > 0 ? '! ' : busy ? '… ' : ''
    const name = escapeControl(basename(this.cwd)).replaceAll('\n', ' ')
    const title = `${mark}agh · ${name}`
    if (title === this.title) return
    this.title = title
    this.term.write(`\x1b]2;${title}\x07`)
  }
}
