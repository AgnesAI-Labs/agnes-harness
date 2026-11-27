import { selectedRemoteOrigin } from './remote-frontend.js'

export type PreparationStage =
  | 'connection'
  | 'profile'
  | 'models'
  | 'workspaces'
  | 'sessions'
  | 'client_roster'
  | 'application'
  | 'client_modules'
  | 'client_script'
  | 'client_styles'
  | 'session_catalog'
  | 'session_open'
  | 'session_projection'
  | 'session_controls'
  | 'conversation_mount'
  | 'composer_mount'

/** Fixed stage names and numeric timings only: never URLs, keys, session IDs or exception text. */
export function createPreparationTiming(
  now: () => number,
  write: (record: {
    stage: PreparationStage
    span: number
    phase: 'start' | 'end'
    atMs: number
    durationMs?: number
    outcome?: 'ok' | 'error'
  }) => void,
) {
  let sequence = 0
  return (stage: PreparationStage) => {
    const started = now(),
      span = ++sequence
    try {
      write({ stage, span, phase: 'start', atMs: Math.round(started) })
    } catch {
      /* Recording a start must not prevent the operation. */
    }
    let ended = false
    return (outcome: 'ok' | 'error' = 'ok') => {
      if (ended) return
      ended = true
      try {
        const finished = now()
        write({
          stage,
          span,
          phase: 'end',
          atMs: Math.round(finished),
          durationMs: Math.max(0, Math.round(finished - started)),
          outcome,
        })
      } catch {
        /* Diagnostics must not change readiness or authorization. */
      }
    }
  }
}

const timing = createPreparationTiming(
  () => performance.now(),
  (record) => console.info('AGH_WEB_STARTUP', record),
)

export function beginPreparationTiming(stage: PreparationStage): (outcome?: 'ok' | 'error') => void {
  try {
    return selectedRemoteOrigin() ? timing(stage) : () => {}
  } catch {
    return () => {}
  }
}

export async function measurePreparation<T>(stage: PreparationStage, work: () => Promise<T>): Promise<T> {
  const finish = beginPreparationTiming(stage)
  try {
    const value = await work()
    finish()
    return value
  } catch (error) {
    finish('error')
    throw error
  }
}

/** Independent list reads should overlap rather than hold the first frame behind one another. */
export function readPreparationLists<W, S>(workspaces: { list(): Promise<W> }, sessions: () => Promise<S>) {
  return Promise.allSettled([
    measurePreparation('workspaces', () => workspaces.list()),
    measurePreparation('sessions', sessions),
  ])
}
