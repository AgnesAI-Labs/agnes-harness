import { HOOK_TABLE, type HookEvent } from '@agnes/protocol'
import { withTimeout } from '../effects/wrap.js'
import type { Timers } from '../log/session-log.js'
import { presetDefaults } from '../step/preset.js'
import { HookBlockedError } from './block.js'

export type DispatchFailure = { event: HookEvent; source: string; message: string }
export type DispatchEntry<T> = {
  source: string
  /** Invocation must not commit shared state; commit runs only after successful bounded completion. */
  invoke: (context: { signal: AbortSignal; replayed: boolean }) => T | Promise<T>
}
export type DispatchOutcome<T> =
  | { kind: 'ok'; results: Array<{ source: string; value: T }> }
  | { kind: 'rejected'; source: string; reason: string; blocked?: HookBlockedError }

type Options = {
  eventsPerTurn?: number
  timers?: Timers
  onFailure: (failure: DispatchFailure) => unknown
  diag: (
    name: 'hook-failed' | 'hook-quota',
    data: { event: HookEvent; source?: string; message?: string },
  ) => unknown
}

/** Per-session scheduling only. The engine owns author/wire validation and event-specific commits. */
export class HookDispatch {
  private used = 0
  private quotaReported = false
  private readonly limit: number

  constructor(private readonly options: Options) {
    this.limit = options.eventsPerTurn ?? presetDefaults().ext.eventsPerTurn
    if (!Number.isSafeInteger(this.limit) || this.limit < 0) throw new Error('invalid hook event quota')
  }

  resetTurn(): void {
    this.used = 0
    this.quotaReported = false
  }

  private report(name: 'hook-failed' | 'hook-quota', event: HookEvent, source?: string): void {
    // Never await diagnostic sinks: a failed or stuck sink cannot disable a safety decision.
    const data = source === undefined ? { event } : { event, source, message: 'hook execution failed' }
    try {
      void Promise.resolve(this.options.diag(name, data)).catch(() => undefined)
    } catch {
      /* contained */
    }
    if (source !== undefined) {
      try {
        void Promise.resolve(
          this.options.onFailure({ event, source, message: 'hook execution failed' }),
        ).catch(() => undefined)
      } catch {
        /* contained */
      }
    }
  }

  private async call<T>(
    event: HookEvent,
    entry: DispatchEntry<T>,
    signal: AbortSignal,
    replayed: boolean,
  ): Promise<{ ok: true; value: T } | { ok: false; blocked?: HookBlockedError }> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      if (controller.signal.aborted) throw new Error('aborted hook')
      const pending = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('aborted hook')
        return entry.invoke({ signal: controller.signal, replayed })
      })
      return {
        ok: true,
        value: await withTimeout(
          pending,
          HOOK_TABLE[event].timeoutMs,
          event,
          controller.signal,
          this.options.timers,
        ),
      }
    } catch (error) {
      // Only the bundled prompt adapter may turn a context-first denial into a normal blocked turn.
      // Timeouts, other extensions, and every other context exception retain the fail-closed path.
      if (event === 'context' && entry.source === 'agnes/hooks-runner' && error instanceof HookBlockedError)
        return { ok: false, blocked: error }
      // Error text can contain extension credentials or input; record only trusted attribution.
      this.report('hook-failed', event, entry.source)
      return { ok: false }
    } finally {
      signal.removeEventListener('abort', abort)
      controller.abort()
    }
  }

  async run<T>(
    event: HookEvent,
    entries: readonly DispatchEntry<T>[],
    signal: AbortSignal,
    options: {
      replayed?: boolean
      commit?: (value: T, source: string) => void
      terminal?: (value: T) => boolean
    } = {},
  ): Promise<DispatchOutcome<T>> {
    const spec = HOOK_TABLE[event]
    const replayed = options.replayed ?? false
    if (replayed && !spec.replayOnResume) return { kind: 'ok', results: [] }
    if (spec.category === 'observe') {
      if (this.used >= this.limit) {
        if (!this.quotaReported) {
          this.quotaReported = true
          this.report('hook-quota', event)
        }
        return { kind: 'ok', results: [] }
      }
      this.used++
    }
    const snapshot = entries.map((entry) => ({ ...entry }))
    if (spec.mode === 'emit') {
      for (const entry of snapshot) void this.call(event, entry, signal, replayed)
      return { kind: 'ok', results: [] }
    }
    if (spec.mode === 'parallel') {
      const outcomes = await Promise.all(snapshot.map((entry) => this.call(event, entry, signal, replayed)))
      return {
        kind: 'ok',
        results: outcomes.flatMap((outcome, index) => {
          const entry = snapshot[index]
          return outcome.ok && entry ? [{ source: entry.source, value: outcome.value }] : []
        }),
      }
    }
    const results: Array<{ source: string; value: T }> = []
    for (const entry of snapshot) {
      const outcome = await this.call(event, entry, signal, replayed)
      if (!outcome.ok) {
        if (spec.failPolicy === 'closed')
          return {
            kind: 'rejected',
            source: entry.source,
            reason: 'hook execution failed',
            ...(outcome.blocked ? { blocked: outcome.blocked } : {}),
          }
        continue
      }
      try {
        // State changes happen after timeout arbitration, never inside an extension promise.
        if (spec.mode === 'waterfall') options.commit?.(outcome.value, entry.source)
        const terminal = spec.mode === 'serial' && options.terminal?.(outcome.value)
        results.push({ source: entry.source, value: outcome.value })
        if (terminal) break
      } catch {
        this.report('hook-failed', event, entry.source)
        if (spec.failPolicy === 'closed')
          return { kind: 'rejected', source: entry.source, reason: 'hook execution failed' }
      }
    }
    return { kind: 'ok', results }
  }
}
