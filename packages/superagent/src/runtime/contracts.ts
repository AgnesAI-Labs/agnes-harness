/**
 * Local declarations of the contracts the session adapter (`sessions.ts`) and the composed app (`app.ts`) provide. The
 * lifecycle codes against these; when those modules land, their own declarations replace this file.
 */
import type { Engine, Executor, Ticket } from '../core/index.js'

export interface SessionAdapter {
  ensureOrchestrator(): Promise<string>
  ensureWorker(ticket: Ticket, dir: string): Promise<string>
  cancel(sessionId: string): Promise<void>
  state(sessionId: string): Promise<{
    running: boolean
    pending: { commandId?: string; itemId: string }[]
    jobs: number
  }>
  dropPending(sessionId: string, itemIds: readonly string[]): Promise<void>
}

/** The Engine's Executor port, and the ids of the Sessions it opened (the main Session and each ticket's worker). */
export interface SuperagentExecutor extends Executor {
  sessionIds(): string[]
}

/** The composed Superagent: Engine, Sources, Outbox, assessor, settings, prompts and Executor. */
export interface SuperagentApp {
  /** Builds the parts and starts polling the Sources; it does not reconcile Sessions. */
  start(): Promise<void>
  /**
   * Stops polling the Sources, sending from the Outbox and launching or delivering, at once, and returns without waiting
   * for work already in flight. It leaves the Sessions alone.
   */
  stopSignal(reason: 'disable' | 'generation' | 'shutdown'): void
  /** Resolves once the work in flight when `stopSignal` was called has finished; the caller bounds the wait. */
  drain(): Promise<void>
  readonly executor: SuperagentExecutor
  /** The Engine, through which the startup reconcile reports interrupted Assignments. */
  readonly engine: Pick<Engine, 'assignmentInterrupted'>
}
