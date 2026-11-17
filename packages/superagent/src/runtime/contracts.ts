/**
 * What the lifecycle needs of the session adapter (`sessions.ts`) and the composed app (`app.ts`): the parts of their own
 * declarations it calls, so a test can stand in for them.
 */
import type { SetupProblem } from '../setup.js'
import type { SuperagentApp as ComposedApp } from './app.js'

export type { SessionAdapter } from './sessions.js'

/** The ids of the sessions the app opened: the main session and each ticket's worker, read live from its registry. */
export type SuperagentExecutor = Pick<ComposedApp['executor'], 'sessionIds'>

/** The composed Superagent as the lifecycle starts, reconciles and stops it. */
export type SuperagentApp = Pick<ComposedApp, 'start' | 'stopSignal' | 'drain' | 'engine'> & {
  readonly executor: SuperagentExecutor
  /** Resolves the deployment again and, once it resolves, opens what a start in setup left closed. */
  reconfigure?(): Promise<void>
  /** Why the started app waits for setup, such as a main session it did not open; undefined when it does not. */
  setupProblem?(): SetupProblem | undefined
}
