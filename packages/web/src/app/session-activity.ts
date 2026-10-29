import type { SessionActivity } from '@agnes/protocol'
import type { SessionListMark } from '@agnes/web-units/shell'

/**
 * What the session list shows about each session's run, from the daemon's own state: the
 * `session.activity` read on connect and the `session_activity` notices after it, which cover
 * every session the user owns, including turns started from the CLI, automation or another tab.
 * A session waiting for an approval or an answer is marked until it is answered. A turn that ends
 * while another session is on screen is marked done (or ended, when it did not complete) until the
 * session is opened; those marks live only in this page.
 */
export class SessionActivityView {
  private readonly active = new Map<string, SessionActivity>()
  private readonly finished = new Map<string, 'completed' | 'ended'>()
  private readonly listeners = new Set<() => void>()
  private shown: string | undefined
  private shownBusy = false

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The daemon's current running and waiting sessions; a reconnect replaces what was known. */
  reset(items: readonly SessionActivity[]): void {
    this.active.clear()
    for (const item of items) if (item.state !== 'idle') this.active.set(item.sessionId, item)
    this.notify()
  }

  apply(activity: SessionActivity): void {
    const id = activity.sessionId
    const was = this.active.get(id)
    if (activity.state === 'idle') {
      this.active.delete(id)
      if (was && id !== this.shown)
        this.finished.set(id, activity.reason === 'completed' ? 'completed' : 'ended')
    } else {
      this.active.set(id, activity)
      this.finished.delete(id)
    }
    this.notify()
  }

  /** The session on screen, and whether its turn is in flight. Looking at a session clears its done mark. */
  showing(id: string | undefined, busy: boolean): void {
    const changed =
      id !== this.shown || busy !== this.shownBusy || (id !== undefined && this.finished.has(id))
    this.shown = id
    this.shownBusy = id !== undefined && busy
    if (id !== undefined) this.finished.delete(id)
    if (changed) this.notify()
  }

  running(): readonly string[] {
    const ids = new Set<string>()
    for (const [id, activity] of this.active) if (activity.state === 'running') ids.add(id)
    if (this.shown !== undefined && this.shownBusy) ids.add(this.shown)
    return [...ids]
  }

  /** Waiting outranks done: a session that needs its owner says so first. */
  marks(): Readonly<Record<string, SessionListMark>> {
    const marks: Record<string, SessionListMark> = Object.fromEntries(this.finished)
    for (const [id, activity] of this.active)
      if (activity.state === 'waiting') marks[id] = activity.waiting ?? 'question'
    return marks
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
