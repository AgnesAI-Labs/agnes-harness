import type { EventEmitter } from 'node:events'
import type { SupervisorToWorker } from './frames.js'

/**
 * Keeps one session's stray error from taking down every session the shared worker hosts. Plugins
 * and MCP code run in-process, so a rejected promise nobody awaited, or a throw from a timer, reaches
 * the process. When the error carries a session context (an AsyncLocalStorage store survives into
 * these handlers), only that session is failed. An unattributed rejection is logged; an unattributed
 * exception leaves the process in an unknown state, so the worker exits and its owner restarts it.
 */
export function installWorkerProcessGuards(o: {
  sessionOf(): string | undefined
  failSession(sessionKey: string, error: unknown): void
  fatal(error: unknown): void
  log?: (message: string, error: unknown) => void
  target?: Pick<EventEmitter, 'on' | 'off'>
}): () => void {
  const target = o.target ?? process
  const log = o.log ?? ((message, error) => console.error(message, error))
  const handle = (kind: 'exception' | 'rejection') => (error: unknown) => {
    let sessionKey: string | undefined
    try {
      sessionKey = o.sessionOf()
    } catch {
      sessionKey = undefined
    }
    log(`agnes worker: uncaught ${kind}${sessionKey ? ` in session ${sessionKey}` : ''}:`, error)
    if (sessionKey) {
      try {
        o.failSession(sessionKey, error)
        return
      } catch (failure) {
        log('agnes worker: failing the session did not complete:', failure)
      }
    } else if (kind === 'rejection') return
    o.fatal(error)
  }
  const onException = handle('exception')
  const onRejection = handle('rejection')
  target.on('uncaughtException', onException)
  target.on('unhandledRejection', onRejection)
  return () => {
    target.off('uncaughtException', onException)
    target.off('unhandledRejection', onRejection)
  }
}

/**
 * Fails one session the way a lost tail does: the supervisor fails that session only, and the
 * worker stops its turn and closes it.
 */
export function sessionFailure(
  send: (frame: unknown) => void,
  close: (sessionKey: string) => Promise<void> | undefined,
): (sessionKey: string, error: unknown) => void {
  return (sessionKey, error) => {
    try {
      send({
        kind: 'session.interrupted',
        sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      })
    } finally {
      void close(sessionKey)?.catch((failure) =>
        console.error('agnes worker: closing a failed session failed:', failure),
      )
    }
  }
}

/**
 * A frame that fails outside its own reply path concerns at most the session it names. Only a
 * runtime target frame, which changes worker-wide state, still ends the process.
 */
export function frameFailure(o: {
  failSession(sessionKey: string, error: unknown): void
  fatal(error: unknown): void
}): (frame: SupervisorToWorker, error: unknown) => void {
  return (frame, error) => {
    if ('type' in frame) {
      o.fatal(error)
      return
    }
    console.error(`agnes worker: ${frame.kind} frame failed:`, error)
    // A reply is the supervisor's answer to this worker: dropping it leaves the request it names
    // pending, and failing the session it names would punish a session that did nothing.
    if (frame.kind === 'reply' || frame.kind === 'close' || !('sessionKey' in frame)) return
    try {
      o.failSession(frame.sessionKey, error)
    } catch {
      // The link is gone; its close handler shuts the worker down.
    }
  }
}
