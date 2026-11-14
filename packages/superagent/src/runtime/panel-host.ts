/**
 * The `PanelHost` of a running Superagent while its other parts start. The store is there from the first moment, and
 * everything that reads only the store answers right away; a part that does more (the Engine, the Settings that saves
 * and syncs, the Sessions, the Executor, the model list) is wired in by whatever starts it, and a service that needs
 * one that is not there yet answers that Superagent is not ready rather than failing in the middle of a call.
 */
import { TextCache } from '../app/cache.js'
import { Prompts } from '../app/prompts.js'
import type { Store } from '../app/store.js'
import { HealthBoard } from '../infra/health.js'
import { LIMITS } from '../limits.js'
import { SourceRegistry } from '../sources/registry.js'
import type { PanelHost } from './panel-views.js'

/** Answered (status 503) when a service needs a part that has not started or was stopped. */
export class NotReady extends Error {
  constructor(part: string) {
    super(`Superagent is not ready: ${part} has not started`)
  }
}

/** What the starting parts wire in; each is optional until its part is running. */
export type PanelWires = Partial<Omit<PanelHost, 'store'>>
/** The wiring handle: the host the services answer from, and the one call that fills it in. */
export interface PanelWiring {
  readonly host: PanelHost
  /** Adds parts to the host; a part wired again replaces the earlier one. */
  wire(parts: PanelWires): void
  /** Takes every part back out, as a stopped Superagent has none. */
  unwire(): void
}

export function createPanelWiring(store: Store, stateDirectory: string): PanelWiring {
  let wired: PanelWires = {}
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const prompts = new Prompts(
    store,
    () => LIMITS.promptMaxChars.max,
    () => undefined,
    () => false,
  )
  const fallback: PanelWires = {
    sourceLinks: new TextCache(0),
    sources,
    prompts,
    // Nothing runs before the Executor starts. Notices and their delivery need the main Session, so they are not faked.
    executor: { activeCount: () => 0 },
    sessions: {
      status: () => ({ revision: prompts.current().revision, sessions: [], notificationPending: false }),
      notify: () => {
        throw new NotReady('sessions')
      },
      delivery: () => Promise.reject(new NotReady('sessions')),
    },
    health: board.all,
    machine: {
      stateDir: stateDirectory,
      promptMaxChars: { get: () => 100_000 },
      admissionContextMaxPages: { get: () => 10 },
      admissionContextTimeoutMs: { get: () => 15_000 },
    },
    masterId: '',
    setupProblem: undefined,
    feishuProblem: undefined,
    configured: () => false,
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    workerSessionId: () => undefined,
    ticketEnvironment: () => [],
    requestPass: () => {},
  }
  const host = { store } as Record<string, unknown>
  const names = [
    'sourceLinks',
    'sources',
    'prompts',
    'sessions',
    'settings',
    'engine',
    'executor',
    'health',
    'machine',
    'masterId',
    'deployment',
    'setupProblem',
    'feishuProblem',
    'configured',
    'links',
    'workerSessionId',
    'ticketEnvironment',
    'checkSetup',
    'requestPass',
    'models',
  ] as const
  for (const name of names)
    Object.defineProperty(host, name, {
      enumerable: true,
      get() {
        if (name in wired) return wired[name]
        if (name in fallback) return fallback[name]
        throw new NotReady(name)
      },
    })
  return {
    host: host as unknown as PanelHost,
    wire: (parts) => {
      wired = { ...wired, ...parts }
    },
    unwire: () => {
      wired = {}
    },
  }
}
