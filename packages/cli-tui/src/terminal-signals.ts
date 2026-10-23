import { basename } from 'node:path'
import { escapeControl } from './component.js'
import type { NotifyEvent, NotifyPreference } from './notify.js'

const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
const BEL = '\x07'
/** The same event inside this window is one notification. */
const COALESCE_MS = 3000

const byTerminal = new WeakMap<object, TerminalSignals>()

/** The signals the app built for this terminal output: how code outside the app says something happened. */
export const signalsFor = (term: object): TerminalSignals | undefined => byTerminal.get(term)

/**
 * What takes the user's eyes off the terminal and brings them back: while the window is in the
 * background (focus reports, DECSET 1004), a turn that ended, an approval that started waiting, an
 * error and a finished subagent each ring a bell or, on a terminal that documents OSC 9, post a
 * desktop notification (see notify.ts: `/notify`, `AGH_NOTIFY`; no `notify` means the plain bell).
 * Repeats of one event inside a few seconds count once. The window title says whether the session
 * is working or waiting; it is saved on start and put back on stop, so the shell gets its own title
 * back. Windows Terminal and ConEmu read OSC 9 as something else, so they only ever get the bell.
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
    private readonly notify?: NotifyPreference,
  ) {
    byTerminal.set(term, this)
  }
  private last = new Map<NotifyEvent, number>()
  private open = new Set<string>()

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

  /** Something worth a look happened; said out loud only while unfocused, and once per few seconds. */
  event(event: NotifyEvent, now = Date.now()): void {
    if (!this.started || this.focused || now - (this.last.get(event) ?? -COALESCE_MS) < COALESCE_MS) return
    this.last.set(event, now)
    const out = this.notify ? this.notify.alert(event, basename(this.cwd)) : BEL
    if (out) this.term.write(out)
  }

  /** Delegated subagent calls in the projected nodes: one that stops running is a finished subagent. */
  watch(nodes: readonly { kind: string; id: string; delegatedTask?: { status: string } }[]): void {
    const running = new Set<string>()
    let finished = false
    for (const node of nodes) {
      if (node.kind !== 'tool' || !node.delegatedTask) continue
      if (node.delegatedTask.status === 'running') running.add(node.id)
      else if (this.open.has(node.id)) finished = true
    }
    this.open = running
    if (finished) this.event('agent')
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
    if (arrived) this.event('approval')
    if (ended) this.event('done')
    const mark = pending.size > 0 ? '! ' : busy ? '… ' : ''
    const name = escapeControl(basename(this.cwd)).replaceAll('\n', ' ')
    const title = `${mark}agh · ${name}`
    if (title === this.title) return
    this.title = title
    this.term.write(`\x1b]2;${title}\x07`)
  }
}
