// Adapted from dsh-superagent (MIT)
/**
 * The panel's view of the services: types only, so the browser panel is typed by what the services answer without
 * bundling any of this package. A request is a route key of the original management API (kept so the panel components
 * read as they did); the panel maps each route to its service (`superagent-ui/src/api.ts`).
 */

import type { PromptConfig, Prompts } from '../app/prompts.js'
import type { HistoryView } from '../app/settings-history.js'
import type { OverviewView } from '../app/views/overview.js'
import type { SettingsView } from '../app/views/settings.js'
import type { SourceStatusView } from '../app/views/sources.js'
import type {
  DecisionListView,
  SearchView,
  THREAD_FILTERS,
  ThreadDetailView,
  ThreadListView,
} from '../app/views/threads.js'
import type { TicketListView } from '../app/views/tickets.js'
import type { ModelCatalog, PromptsView, StateView, TicketPageView } from './panel-views.js'
import type { TICKET_FILTERS } from './services.js'

export type TicketFilter = (typeof TICKET_FILTERS)[number]
export type ThreadFilter = (typeof THREAD_FILTERS)[number]
interface Paged {
  offset?: number
  limit?: number
}
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': {
    query?: { limit?: number; before?: string; around?: string }
    response: ThreadDetailView
  }
  'POST threads/:key/unsubscribe': {
    response: { removed: boolean; thread: string; context_delivery: Delivery }
  }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': {
    body: { value: unknown; revision: number }
    response: { revision: number; restarting: boolean }
  }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': {
    body: { config: PromptConfig; baseRevision: number }
    response: { revision: number; context_delivery: Delivery }
  }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}`
    ? Record<Name, string>
    : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']

export type { TicketStage } from '../core/stage.js'
export type { SetupProblem } from '../setup.js'
export type { Health } from '../sources/host.js'
export type { AdmissionRowView, FieldSpec, Localized } from '../sources/kind.js'
export type { ModelCatalog, PromptsView, StateView, TicketPageView }
