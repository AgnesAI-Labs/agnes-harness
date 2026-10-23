import type { UITimeline } from '@agnes/protocol'
import type { Loader } from './components/loader.js'
import { formatTurnSummary } from './format-usage.js'

/**
 * The turn's spinner and wall clock: both key off the same two turn edges, so they are driven from
 * one place rather than two.
 */
export class TurnClock {
  active = false
  private startedAt: number | undefined
  private turn = 0
  private ticker: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly loader: Loader,
    /** Repaints once per tick; the host decides whether it is still running. */
    private readonly repaint: () => void,
    /** A turn just ended. */
    private readonly ended: () => void,
  ) {}

  /**
   * Turn-lifecycle edge detection: `value.opState` flips null↔non-null exactly at turn
   * boundaries (protocol's `UIOperationState`), and both the spinner (RP1) and the local wall
   * clock (RP3) key off the same two edges.
   *
   * A null↔non-null flip is not the only boundary that matters, though: `opState.turn` can also
   * change while `opState` stays non-null the whole time, because projection delivery is
   * debounced (projection.ts's `REPROJECT_DEBOUNCE_MS`) and can coalesce turn N's end and turn
   * N+1's start into one tick with no intervening `opState: null` ever reaching `apply()`. Left
   * undetected, that reads as "still turn N" and both fabricates turn N+1's elapsed time (it would
   * include turn N's own duration plus the idle gap between them) and drops turn N's own summary
   * silently. This re-baselines on `opState.turn` changing exactly like a fresh turn start, and
   * accepts that the coalesced turn N never gets its own `✓ turn N · Xs` line -- silently losing
   * that one summary is far less harmful than showing a fabricated number for the next one.
   */
  apply(opState: UITimeline['opState']): void {
    const active = opState !== null
    if (active && (!this.active || opState.turn !== this.turn)) {
      this.startedAt = Date.now()
      this.turn = opState.turn
      this.loader.restart(opState.phase)
      this.start()
    } else if (!active && this.active) {
      this.stop()
      const elapsedMs = this.startedAt !== undefined ? Date.now() - this.startedAt : undefined
      this.loader.stop(elapsedMs !== undefined ? formatTurnSummary(this.turn, elapsedMs) : undefined)
      this.startedAt = undefined
      this.ended()
    } else if (active) {
      this.loader.setLabel(opState.phase)
    }
    this.active = active
  }

  /** Back to exactly what a freshly constructed clock looks like. */
  reset(): void {
    this.stop()
    this.active = false
    this.startedAt = undefined
    this.turn = 0
    this.loader.hide()
  }

  // One shared 80ms ticker, not a timer per component (spec RP1, matching the reference
  // implementations surveyed for this design). RP1.1 measured Timeline.render() at well under
  // 1ms per tick even at 1,000 nodes, so this calls the same requestRender() every other repaint
  // uses rather than a narrower single-row redraw path.
  private start(): void {
    if (this.ticker !== undefined) return
    this.ticker = setInterval(() => {
      this.loader.tick()
      this.repaint()
    }, 80)
    this.ticker.unref()
  }

  stop(): void {
    if (this.ticker === undefined) return
    clearInterval(this.ticker)
    this.ticker = undefined
  }
}
