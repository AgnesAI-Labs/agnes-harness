import { type Component, escapeControl } from '../component.js'
import { fitLine } from './line.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * A single-row spinner. Construction is already visible (no separate start call) -- an existing
 * consumer builds `new Loader(label)` and reads its frame immediately -- so `hide()`/`restart()` are
 * additive: a caller that never touches them sees exactly today's behaviour.
 */
export class Loader implements Component {
  private i = 0
  private stopped = false
  private hidden = false
  constructor(private label: string) {}
  tick(): void {
    if (!this.stopped) this.i = (this.i + 1) % FRAMES.length
  }
  /** Freezes on the checkmark. `finalLabel`, when given, replaces the label in the same call --
   *  the caller does not need a separate `setLabel` after stopping. */
  stop(finalLabel?: string): void {
    this.stopped = true
    if (finalLabel !== undefined) this.label = finalLabel
  }
  /** Zero rows from here on, until the next `restart`. Ticking while hidden is harmless: it just
   *  advances a frame index nothing renders. */
  hide(): void {
    this.hidden = true
  }
  /** Un-hides and resumes spinning from frame 0 under a fresh label, whether the previous state
   *  was hidden, stopped, or already spinning. */
  restart(label: string): void {
    this.hidden = false
    this.stopped = false
    this.i = 0
    this.label = label
  }
  setLabel(label: string): void {
    this.label = label
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (this.hidden) return []
    return [fitLine(`${this.stopped ? '✓' : FRAMES[this.i]} ${escapeControl(this.label)}`, width)]
  }
}
