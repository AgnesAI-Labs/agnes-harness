/** Panel caller over the Superagent profile services, and the polling hook. */

import type { Api, ApiRequest, ApiResponse } from '@agnes/superagent/panel-api'
import type { ClientProfileServices } from '@agnes/web-client'
import { useCallback, useEffect, useRef, useState } from 'react'

export type { ApiResponse }

import { type SetupProblem, type TicketStage, USER_ERRORS, type UserErrorCode } from './shared.js'

/** Host rejection identified by a structured user error code and interpolation values. */
export interface UserFailure {
  code: UserErrorCode
  values: Record<string, string>
}
/**
 * Represents a failed panel request with a localized message and structured diagnostic details.
 * Thrown by API callers and inspected by UI views and draft state to distinguish validation issues, missing records,
 * and unreachable hosts (`details.unreachable` is set when the Superagent service did not answer at all, such as while it restarts,
 * in which case a 404 does not mean a record is missing).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: {
      issues?: { path: string; message: string }[]
      setup?: SetupProblem
      user?: UserFailure
      unreachable?: boolean
    } = {},
  ) {
    super(message)
  }
  get issues() {
    return this.details.issues ?? []
  }
  /** True when the host confirmed the record does not exist, rather than being unreachable. */
  get missing() {
    return this.status === 404 && !this.details.unreachable
  }
}
export interface ApiMessages {
  effectNotDone: (state: string) => string
  offline: string
  notRunning: string
  serverError: (status: number) => string
  requestFailed: (status: number) => string
  setup: (problem: SetupProblem) => string
  user: (failure: UserFailure) => string
}
const isUserError = (code: unknown): code is UserErrorCode => typeof code === 'string' && Object.hasOwn(USER_ERRORS, code)

/** The two calls a panel makes of the backend: its profile services, as the web client hands them over. */
export type Services = Pick<ClientProfileServices, 'query' | 'effect'>
type Failure = {
  status?: unknown
  error?: unknown
  issues?: unknown
  setup?: SetupProblem
  code?: unknown
  values?: Record<string, string>
}
/** The answer a service gives for what the original route answered with an error status; see the services' contract. */
const failureOf = (value: unknown): Failure | undefined => (value && typeof value === 'object' && !Array.isArray(value) && 'failure' in value ? ((value as { failure: Failure }).failure ?? {}) : undefined)

function refusal(messages: ApiMessages, failure: Failure): ApiError {
  const status = typeof failure.status === 'number' ? failure.status : 500
  const issues = Array.isArray(failure.issues) ? (failure.issues as { path: string; message: string }[]) : []
  const user = isUserError(failure.code) ? { code: failure.code, values: failure.values ?? {} } : undefined
  const message = failure.setup ? messages.setup(failure.setup) : user ? messages.user(user) : typeof failure.error === 'string' ? failure.error : status >= 500 ? messages.serverError(status) : messages.requestFailed(status)
  return new ApiError(message, status, {
    issues,
    ...(failure.setup ? { setup: failure.setup } : {}),
    ...(user ? { user } : {}),
  })
}
/** A call the Host refused or could not reach: the plugin is off or restarting, or the connection dropped. */
function unreachable(messages: ApiMessages, error: unknown): ApiError {
  const denied = /CAPABILITY_DENIED|not running/i.test(error instanceof Error ? error.message : String(error))
  return new ApiError(denied ? messages.notRunning : messages.offline, denied ? 404 : 0, {
    unreachable: true,
  })
}

/** The service each original route became, and whether it is a query (a GET) or an effect. */
export const SERVICES = {
  'GET state': ['superagent.state', 'query'],
  'GET overview': ['superagent.overview', 'query'],
  'GET search': ['superagent.search', 'query'],
  'GET sources': ['superagent.sources.list', 'query'],
  'POST sources/:id/labels': ['superagent.sources.refreshlabels', 'effect'],
  'GET settings': ['superagent.settings.get', 'query'],
  'PUT settings/:block': ['superagent.settings.save', 'effect'],
  'GET threads': ['superagent.threads.list', 'query'],
  'GET threads/:key': ['superagent.threads.get', 'query'],
  'POST threads/:key/unsubscribe': ['superagent.threads.unsubscribe', 'effect'],
  'POST triggers/:id/requeue': ['superagent.triggers.requeue', 'effect'],
  'GET decisions': ['superagent.decisions.list', 'query'],
  'POST decisions/:id/dismiss': ['superagent.decisions.dismiss', 'effect'],
  'GET tickets': ['superagent.tickets.list', 'query'],
  'GET tickets/:id': ['superagent.tickets.get', 'query'],
  'POST tickets/:id/retry': ['superagent.tickets.retry', 'effect'],
  'POST tickets/:id/stop': ['superagent.tickets.stop', 'effect'],
  'POST executor/pause': ['superagent.executor.pause', 'effect'],
  'GET policy/history': ['superagent.policy.history', 'query'],
  'POST policy-sync/:id': ['superagent.policy.sync', 'effect'],
  'POST setup/check': ['superagent.setup.check', 'effect'],
  'GET models': ['superagent.models.list', 'query'],
  'GET prompts': ['superagent.prompts.get', 'query'],
  'PUT prompts': ['superagent.prompts.save', 'effect'],
  'POST prompts/preview': ['superagent.prompts.preview', 'effect'],
} as const satisfies Record<keyof Api, readonly [string, 'query' | 'effect']>

/** The service input of a request: path parameters, query parameters and body fields as one closed object. */
export function inputOf(route: keyof Api, request: Record<string, unknown> | undefined): Record<string, unknown> {
  const { query, body, ...params } = (request ?? {}) as Record<string, unknown> & {
    query?: Record<string, unknown>
    body?: unknown
  }
  // The preview takes the prompt configuration itself as its body; a service input is a closed object.
  const fields = route === 'POST prompts/preview' ? { config: body } : { ...(body as object | undefined) }
  // A blank query parameter is no parameter, as it was in the URL.
  const asked = Object.entries(query ?? {}).filter(([, value]) => value !== '')
  return Object.fromEntries(Object.entries({ ...params, ...Object.fromEntries(asked), ...fields }).filter(([, value]) => value !== undefined))
}

export type Call = <K extends keyof Api>(route: K, ...request: {} extends ApiRequest<K> ? [request?: ApiRequest<K>] : [request: ApiRequest<K>]) => Promise<ApiResponse<K>>
/** Build a typed route caller over the profile services; it resolves localized error messages on each request. */
export function caller(messages: () => ApiMessages, services: Services): Call {
  return async (route, ...[request]) => {
    const [name, kind] = SERVICES[route]
    const input = inputOf(route, request as Record<string, unknown> | undefined)
    let value: unknown
    try {
      if (kind === 'query') value = await services.query(name, input)
      else {
        // One operation per click: a repeated click is a new operation, never a replay of the earlier one.
        const receipt = (await services.effect(name, input, { operationId: crypto.randomUUID() })) as {
          state?: string
          output?: unknown
        }
        if (receipt?.state !== 'completed') throw new ApiError(messages().effectNotDone(String(receipt?.state)), 500)
        value = receipt.output
      }
    } catch (error) {
      throw error instanceof ApiError ? error : unreachable(messages(), error)
    }
    const failure = failureOf(value)
    if (failure) throw refusal(messages(), failure)
    return value as ApiResponse<typeof route>
  }
}

const HIDDEN_FACTOR = 6
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
/**
 * Poll an endpoint while mounted, backing off when the document is hidden.
 * Preserves the last successful value across dependency changes and errors, skips state updates when the response is unchanged,
 * and drops stale responses when `deps` or `intervalMs` changes start a new subscription.
 */
export function usePoll<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs = 5000) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({})
  const loader = useRef(load)
  loader.current = load
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // Serialize requests so a manual reload after a mutation runs after the current poll finishes.
    let queue = Promise.resolve()
    const once = async () => {
      clearTimeout(timer)
      try {
        const value = await loader.current()
        if (active) setState((previous) => (same(previous.data, value) ? (previous.error ? { data: previous.data as T } : previous) : { data: value }))
      } catch (failure) {
        if (active)
          setState((previous) => ({
            ...previous,
            error: failure instanceof Error ? failure : new Error(String(failure)),
          }))
      } finally {
        if (active) timer = setTimeout(run, document.hidden ? intervalMs * HIDDEN_FACTOR : intervalMs)
      }
    }
    const run = () => (queue = queue.then(once))
    const shown = () => {
      if (!document.hidden) void run()
    }
    refresh.current = run
    void run()
    document.addEventListener('visibilitychange', shown)
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', shown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs])
  const reload = useCallback(() => refresh.current(), [])
  return { data: state.data, error: state.error, reload }
}

export const DECISION_FILTERS = ['work', 'stop', 'ignore', 'unavailable', 'all'] as const
export type DecisionFilter = (typeof DECISION_FILTERS)[number]
export const DECISION_KINDS: Readonly<Record<DecisionFilter, string>> = {
  work: 'accept,reopen',
  stop: 'stop',
  ignore: 'ignore',
  unavailable: 'unavailable',
  all: '',
}

export type StateView = ApiResponse<'GET state'>
export type SetupView = StateView['setup']
export type SettingsView = ApiResponse<'GET settings'>
export type Settings = { [B in keyof SettingsView['blocks']]: SettingsView['blocks'][B]['value'] }
export type SourceView = SettingsView['sources'][number]
export type SourceStatusRow = ApiResponse<'GET sources'>[number]
export type TicketRow = ApiResponse<'GET tickets'>['items'][number]
export type TicketPageView = ApiResponse<'GET tickets/:id'>
export type ThreadRow = ApiResponse<'GET threads'>['items'][number]
export type ThreadPageView = ApiResponse<'GET threads/:key'>
export type TriggerRow = ThreadPageView['timeline'][number]
export type DecisionRow = ApiResponse<'GET decisions'>['items'][number]
export type Problem = ApiResponse<'GET overview'>['problems'][number]
export type DroppedReply = SourceStatusRow['dropped'][number]
export type SearchView = ApiResponse<'GET search'>
export type TicketSummary = SearchView['tickets'][number]
export type { TicketStage }
export type HistoryView = ApiResponse<'GET policy/history'>
export type PromptsView = ApiResponse<'GET prompts'>
export type PromptConfig = PromptsView['defaults']
export type ThreadFacts = TicketRow['threads'][number]
export type Actor = TriggerRow['actor']
