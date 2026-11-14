// Adapted from dsh-superagent (MIT)
/**
 * What the panel services read and call, and the three views that combine several parts (state, ticket page, prompts).
 * `PanelHost` is the structural contract of what the settings and panel services need from the running Superagent;
 * the runtime fills it in as its parts start, and the services answer from it.
 */

import type { TextCache } from '../app/cache.js'
import { sourceSkills } from '../app/context.js'
import type { Variable } from '../app/execution-environment.js'
import type { SessionNotices } from '../app/notices.js'
import {
  builtInBase,
  builtInParts,
  defaultPrompts,
  type Prompts,
  SKILL_NAME,
  SKILL_PREFIX,
  TEAM_SECTIONS,
} from '../app/prompts.js'
import type { Settings } from '../app/settings.js'
import type { Store } from '../app/store.js'
import type { LinkTarget, ViewHost } from '../app/views/records.js'
import type { SetupState } from '../app/views/sources.js'
import { executorLoad, ticketDetail } from '../app/views/tickets.js'
import type { EngineForPeople, Ticket } from '../core/index.js'
import type { Deployment, Machine } from '../deployment.js'
import type { SetupProblem } from '../setup.js'
import type { Health } from '../sources/host.js'
import type { SourceRegistry } from '../sources/registry.js'

/** The model groups the settings form offers; the entries come from what the AGH installation has configured. */
export interface ModelCatalog {
  default?: { provider: string; model: string; reasoningEffort?: string }
  groups: {
    id: string
    name: string
    models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[] } }[]
  }[]
}

/** The Sessions side of the panel: which prompt revision each Session runs under and the notices it is owed. */
export interface PanelSessions extends SessionNotices {
  status(): {
    revision: number
    sessions: { sessionId: string; revision: number }[]
    notificationPending: boolean
  }
}

/** Everything the panel services read and call; the runtime provides it once its parts are running. */
export interface PanelHost {
  readonly store: Store
  /** False until every part is wired; an action that changes something is refused until then. Absent means wired. */
  readonly wired?: boolean
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: PanelSessions
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: { activeCount(): number }
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** The resolved deployment; throws while setup is incomplete (`configured()` is false). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  /** The id of a ticket's worker session in the platform, the page the panel opens; none until the session exists. */
  workerSessionId(ticketId: string): string | undefined
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}

export const views = (host: PanelHost): ViewHost => ({
  store: host.store,
  sources: host.sources,
  links: host.links(),
})
export const setupState = (host: PanelHost): SetupState => ({
  deployment: host.configured() ? host.deployment : undefined,
  problem: host.setupProblem,
  feishuProblem: host.feishuProblem,
})

function machineView({
  stateDir,
  promptMaxChars,
  admissionContextMaxPages,
  admissionContextTimeoutMs,
}: Machine) {
  return {
    stateDir,
    promptMaxChars: promptMaxChars.get(),
    admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get(),
  }
}
function setupView(host: PanelHost) {
  const resolved = host.configured() ? host.deployment : undefined
  return {
    machine: machineView(host.machine),
    problem: host.setupProblem ?? null,
    feishuProblem: host.feishuProblem ?? null,
    accounts: resolved
      ? {
          repository: resolved.repository,
          agent: resolved.github.login,
          feishu: resolved.feishu
            ? {
                appId: resolved.feishu.appId,
                brand: resolved.feishu.brand,
                botId: resolved.feishu.botId,
                name: resolved.feishu.name,
              }
            : null,
        }
      : null,
  }
}
/** The `superagent.state` result: setup facts, Executor load, the pause switch and every component's health. */
export function stateView(host: PanelHost) {
  const settings = host.store.settings()
  return {
    setup: setupView(host),
    load: {
      ...executorLoad(host.store, host.executor.activeCount()),
      maxWorkers: settings.executor.maxWorkers,
    },
    masterId: host.masterId,
    paused: settings.paused,
    health: host.health,
  }
}
export type StateView = ReturnType<typeof stateView>

/** A ticket's detail view; `environment` is empty while waiting for setup because it needs the resolved deployment. */
export function ticketPage(host: PanelHost, id: string) {
  const detail = ticketDetail(views(host), id)
  const ticket = host.store.tickets.get(id)
  if (!detail || !ticket) return undefined
  const session = host.workerSessionId(id)
  return {
    ...detail,
    // The panel opens the session by its platform id; the worker's key is of no use to it.
    assignments: detail.assignments.map(({ ref: _key, ...assignment }) => ({
      ...assignment,
      ...(session && assignment.startedAt ? { ref: session } : {}),
    })),
    environment: host.configured() ? host.ticketEnvironment(ticket) : [],
  }
}
export type TicketPageView = NonNullable<ReturnType<typeof ticketPage>>

/** The prompts view: the chosen revision, every built-in part with the key of its text, the version history. */
export function promptsView(host: PanelHost, revision: number | undefined, offset: number) {
  const { prompts } = host
  const current = prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : prompts.version(revision)
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({
    key,
    ...part,
    base: builtInBase(part.text),
  }))
  return {
    masterId: host.masterId,
    current: shown,
    defaults: defaultPrompts(),
    sections: TEAM_SECTIONS,
    skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills),
    skillPrefix: SKILL_PREFIX,
    parts,
    defaultChanged: prompts.defaultChanged(shown.config),
    ...host.sessions.status(),
    ...prompts.history(offset),
  }
}
export type PromptsView = ReturnType<typeof promptsView>
