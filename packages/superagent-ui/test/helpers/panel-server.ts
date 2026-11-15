/**
 * Typed fake management API server for panel tests. Implements every route in `src/app/api.ts` and records any
 * undeclared query parameter or body mismatch in `server.misuse`, which `usePanelServer` asserts is empty after each test.
 */
import { afterEach, beforeEach, expect } from 'vitest'
import {
  builtInPart,
  composePrompt,
  composeSkill,
  environmentSection,
  policySection,
  promptParts,
} from '../../../superagent/src/app/prompts.js'
import { SETUP_FIELDS } from '../../../superagent/src/deployment.js'
import {
  EvalConfigSchema,
  ExecutorConfigSchema,
  PolicyConfigSchema,
  SettingsSchema,
} from '../../../superagent/src/policy.js'
import type { Api, ApiResponse, RouteParams } from '../../../superagent/src/runtime/panel-api.js'
import { PANEL_SERVICES } from '../../../superagent/src/runtime/services.js'
import { SetupError } from '../../../superagent/src/setup.js'
import type { Health } from '../../../superagent/src/sources/host.js'
import type { Choice } from '../../../superagent/src/sources/kind.js'
import type {
  DroppedReply,
  HistoryView,
  Problem,
  PromptsView,
  SetupView,
  SourceStatusRow,
  SourceView,
  StateView,
  ThreadPageView,
  ThreadRow,
  TicketPageView,
  TicketRow,
  TriggerRow,
} from '../../src/api.js'
import { SERVICES } from '../../src/api.js'
import { testDeployment } from './deployment.js'
import { problems } from './schema.js'

export * from './panel-fixtures.js'

import { acceptDecision, initial } from './panel-state.js'

export { acceptDecision }

import { actor, dayAgo, KINDS, promptVersion, threadSummary } from './panel-fixtures.js'

type Settings = ReturnType<typeof SettingsSchema.parse>
export interface PanelServer {
  /** The Source choices the settings carry, by Source and field key. */
  choices?: Record<string, Record<string, Choice[]>>
  joined?: Record<string, string>
  joining?: Record<string, string>
  joinError?: string
  settings: Settings
  revisions: Record<string, number>
  prompts: PromptsView
  tickets: { open: TicketRow[]; ended: TicketRow[] }
  ticketDetails: Record<string, TicketPageView>
  threads: ThreadRow[]
  threadPages: (key: string, query: { before?: string; around?: string }) => ThreadPageView | undefined
  person: TicketRow[]
  search: Pick<ApiResponse<'GET search'>, 'items' | 'threads'>
  history: HistoryView
  requests: { path: string; method: string; body?: unknown }[]
  /** The services called, with how: a query or an effect. */
  calls: [kind: 'query' | 'effect', service: string][]
  /** Requests with undeclared query params or invalid body presence; asserted empty after each test. */
  misuse: string[]
  queued: Set<string>
  searching?: (query: string) => Promise<void>
  setup: SetupView
  health: Record<string, Health>
  /** When true, all API requests return an empty 404 to simulate the host plugin being stopped. */
  down: boolean
  /** Count of responses not yet consumed by the client. */
  pending: number
  opened: string[]
  dropped: DroppedReply[]
  failing: Extract<Problem, { kind: 'outgoing' }>['outgoing'][]
}
export let server: PanelServer

function resolved() {
  const accounts = server.setup.accounts
  return accounts
    ? testDeployment({
        repository: accounts.repository,
        github: { cli: '/bin/false', login: accounts.agent, noreply: '' },
        ...(accounts.feishu ? { feishu: { cli: '/bin/false', ...accounts.feishu } } : { feishu: undefined }),
      })
    : undefined
}
/** Default source health: paused during setup; Feishu defaults to `socket closed` unless overridden or paused by setup. */
function healthOf(name: string): Health {
  if (server.setup.problem) return { state: 'paused', detail: 'Waiting for setup', code: 'setupPending' }
  if (server.health[name]) return server.health[name]
  if (name !== 'feishu') return { state: 'ready', detail: '' }
  return server.setup.feishuProblem
    ? { state: 'paused', detail: server.setup.feishuProblem.detail }
    : { state: 'error', detail: 'socket closed' }
}
const problemOf_ = (id: string) =>
  [server.setup.problem, server.setup.feishuProblem].find((item) => item?.place === id) ?? undefined
function sourceSettings(): SourceView[] {
  return KINDS.map((kind) => {
    const config = kind.schema.parse(server.settings.sources[kind.kind]?.config ?? {})
    const problem = problemOf_(kind.kind)
    const { admission: _admission, ...part } = server.settings.policy.sources[kind.kind] ?? {
      allowed: [],
      admission: {},
    }
    const sync = kind.policy?.sync && {
      label: kind.policy.sync.label,
      ready: kind.policy.sync.ready(kind.policy.schema.parse(part)),
      health: server.health[`sync:${kind.kind}`],
    }
    const policy = kind.policy && {
      fields: kind.policy.fields,
      explicit: kind.policy.explicit,
      ...(kind.policy.rows ? { rows: kind.policy.rows(config) } : {}),
      ...(sync ? { sync } : {}),
    }
    return {
      id: kind.kind,
      kind: kind.kind,
      title: kind.title,
      description: kind.description,
      installed: true,
      value: { enabled: server.settings.sources[kind.kind]?.enabled ?? true, config },
      revision: server.revisions[`source:${kind.kind}`] ?? 0,
      restarts: SETUP_FIELDS[kind.kind] ?? [],
      fields: kind.fields,
      facts: kind.facts?.(resolved()) ?? {},
      labels: kind.kind === 'feishu' ? { oc_team: '团队群', oc_other: '另一个群', ...server.joined } : {},
      choices: server.choices?.[kind.kind] ?? {},
      ...(problem ? { problem } : {}),
      ...(policy ? { policy } : {}),
    }
  })
}
function sourceStatuses(): SourceStatusRow[] {
  return KINDS.map((kind) => {
    const enabled = server.settings.sources[kind.kind]?.enabled ?? true
    const health = kind.health.map((name) => ({ name, ...healthOf(name) }))
    const problem = problemOf_(kind.kind)
    const state = !enabled
      ? 'off'
      : problem || health.some((item) => item.state === 'error')
        ? 'error'
        : server.setup.problem
          ? 'setup'
          : health.some((item) => item.state === 'starting')
            ? 'starting'
            : health.some((item) => item.state === 'paused')
              ? 'paused'
              : 'ready'
    const feishu = kind.kind === 'feishu'
    return {
      id: kind.kind,
      title: kind.title,
      installed: true,
      enabled,
      state,
      health,
      ...(problem ? { problem } : {}),
      stats: { received: feishu ? 12 : 0, filtered: feishu ? 2 : 0, lastAt: '2026-09-23T00:00:00Z' },
      filtered: feishu
        ? []
        : [
            {
              id: 'e9',
              at: '2026-09-23T00:02:00Z',
              actor: actor('github', 'someone'),
              preview: 'looks wrong',
              reason: { code: 'source_disabled' },
            },
          ],
      dropped: server.dropped.filter(
        (item) => item.channel.source === kind.kind && item.dropped.at >= dayAgo(),
      ),
    }
  })
}
const stateView = (): StateView => ({
  setup: server.setup,
  load: { running: server.setup.problem ? 0 : 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers },
  masterId: 'master',
  paused: server.settings.paused,
  // The panel does not read health; the service script does.
  health: {},
})
const settingsView = (): ApiResponse<'GET settings'> => ({
  policyVersion: 'abcdef1234567890',
  blocks: {
    policy: { value: server.settings.policy, revision: server.revisions.policy ?? 0 },
    eval: { value: server.settings.eval, revision: server.revisions.eval ?? 0 },
    executor: { value: server.settings.executor, revision: server.revisions.executor ?? 0 },
  },
  sources: sourceSettings(),
  environment: {
    root: '/srv/superagent/work',
    variables: [
      {
        owner: 'executor',
        enabled: true,
        variables: [
          { key: 'DSH_SUPERAGENT_DIR', description: { zh: '工单的执行目录', en: 'The ticket directory' } },
          { key: 'DSH_SUPERAGENT_NAME', description: { zh: '工单短名', en: 'Short name' } },
        ],
      },
      {
        owner: 'github',
        enabled: false,
        variables: [
          { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库', en: 'Repository' } },
        ],
      },
    ],
  },
})
const overviewView = (): ApiResponse<'GET overview'> => {
  const { problem, feishuProblem } = server.setup
  const setup = problem ?? feishuProblem
  return {
    problems: [
      ...(setup ? [{ kind: 'setup' as const, ...setup }] : []),
      ...(KINDS.some((kind) => server.settings.sources[kind.kind]?.enabled !== false)
        ? []
        : [{ kind: 'no-source' as const }]),
      ...(feishuProblem || server.settings.sources.feishu?.enabled === false
        ? []
        : [
            {
              kind: 'source-error' as const,
              source: {
                id: 'feishu',
                title: { zh: '飞书', en: 'Feishu' },
                health: { name: 'feishu', state: 'error' as const, detail: 'socket closed' },
              },
            },
          ]),
      ...server.threads
        .filter((thread) => thread.evaluating && thread.evaluating.deadline < new Date().toISOString())
        .map((thread) => ({ kind: 'eval-overdue' as const, thread })),
      {
        kind: 'eval-unavailable' as const,
        decisionId: 'u1',
        thread: threadSummary(),
        reason: [{ code: 'timeout' }],
        triggerId: 'e3',
      },
      ...(server.settings.paused ? [{ kind: 'executor-paused' as const }] : []),
      // As on the host, every entry in error that is not a Source's own, a Policy sync, or the individually listed unavailable Evals is a runtime-error.
      ...Object.entries(server.health)
        .filter(
          ([name, item]) =>
            item.state === 'error' &&
            !KINDS.some((kind) => kind.health.includes(name)) &&
            !name.startsWith('sync:') &&
            name !== 'evals',
        )
        .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
      ...(Object.values(server.settings.policy.sources).some((part) => part.allowed.length)
        ? []
        : [{ kind: 'no-allowed' as const }]),
      ...server.failing.map((outgoing) => ({ kind: 'outgoing' as const, outgoing })),
    ],
    person: server.person,
    executor: { running: 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers, idle: 1 },
    flow: {
      received: 12,
      filtered: 2,
      triggers: 10,
      judged: 5,
      accepted: 1,
      evaluating: 0,
      dropped: server.dropped.filter((item) => item.dropped.at >= dayAgo()).length,
    },
    policyVersion: 'abcdef1234567890',
  }
}
/** A refusal response carrying the host's HTTP status code and JSON error body. Returned by route handlers when a request is rejected. */
class Refusal {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    readonly body: Record<string, unknown>,
  ) {}
}
const refuse = (status: Refusal['status'], error: string, more: Record<string, unknown> = {}) =>
  new Refusal(status, { error, ...more })
type Query<K extends keyof Api> = Api[K] extends { query?: infer Q } ? keyof NonNullable<Q> & string : never
type Body<K extends keyof Api> = Api[K] extends { body: infer B } ? B : undefined
interface Request<K extends keyof Api> {
  params: RouteParams<K>
  query: Partial<Record<Query<K>, string>>
  body: Body<K>
}
type Answer<K extends keyof Api> = ApiResponse<K> | Refusal
type Route<K extends keyof Api> = {
  query?: readonly Query<K>[]
  answer: (request: Request<K>) => Answer<K> | Promise<Answer<K>>
} & (Api[K] extends { body: unknown } ? { body: true } : { body?: never })
const page = <T>(items: T[]) => ({ items, total: items.length, next_offset: null })
const ticketOf = (id: string) =>
  [...server.tickets.open, ...server.person, ...server.tickets.ended].find((ticket) => ticket.id === id) ??
  server.ticketDetails[id]
const SourceSave = { parse: (value: unknown) => value as { enabled: boolean; config: unknown } }

const ROUTES: { [K in keyof Api]: Route<K> } = {
  'GET state': { answer: stateView },
  'GET overview': { answer: overviewView },
  'GET search': {
    query: ['q'],
    answer: async ({ query }) => {
      const q = query.q ?? ''
      await server.searching?.(q)
      return {
        tickets: [],
        threads: server.search.threads,
        items: server.search.items.filter((item) => item.preview.includes(q)),
      }
    },
  },
  'GET sources': { answer: sourceStatuses },
  'GET settings': { answer: settingsView },
  'POST sources/:id/labels': {
    answer: () => {
      // Label refresh failures come from the bot CLI and are returned verbatim.
      if (server.joinError) return refuse(500, server.joinError)
      const added = Object.values(server.joining ?? {})
      server.joined = { ...server.joined, ...server.joining }
      delete server.joining
      return { added }
    },
  },
  'GET threads': { query: ['filter', 'offset', 'limit'], answer: () => page(server.threads) },
  'GET threads/:key': {
    query: ['limit', 'before', 'around'],
    answer: ({ params, query }) => {
      const found = server.threadPages(params.key, query)
      if (!found) return refuse(404, 'Thread not found')
      // A Trigger sent to Eval again is queued and cannot be requeued.
      const queued = (item: TriggerRow) => ({
        ...item,
        disposition: { ...item.disposition, queued: true },
        actions: { requeue: false },
      })
      return {
        ...found,
        timeline: found.timeline.map((item) => (server.queued.has(item.id) ? queued(item) : item)),
      }
    },
  },
  'POST threads/:key/unsubscribe': {
    answer: ({ params }) => {
      const removed = server.threads.length > 0
      server.threads = []
      return { removed, thread: params.key, context_delivery: 'injected' }
    },
  },
  'POST triggers/:id/requeue': {
    answer: ({ params }) => {
      server.queued.add(params.id)
      return { queued: true }
    },
  },
  'GET decisions': {
    query: ['kind', 'window', 'offset', 'limit'],
    answer: ({ query }) => ({ items: query.kind === 'ignore' ? [] : [acceptDecision()], next_offset: null }),
  },
  'POST decisions/:id/dismiss': {
    answer: ({ params }) =>
      params.id === 'u1' ? { dismissed: true } : refuse(404, 'Unavailable Eval not found'),
  },
  'GET tickets': {
    query: ['state', 'offset', 'limit'],
    answer: ({ query }) => page(server.tickets[query.state === 'ended' ? 'ended' : 'open']),
  },
  'GET tickets/:id': {
    answer: ({ params }) => server.ticketDetails[params.id] ?? refuse(404, 'Ticket not found'),
  },
  'POST tickets/:id/retry': {
    answer: ({ params }) => {
      const ticket = ticketOf(params.id)
      if (!ticket) return refuse(404, 'Ticket not found')
      return ticket.actions.retry
        ? { retried: true }
        : refuse(
            400,
            'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed',
            {
              code: 'notRetryable',
              values: {},
            },
          )
    },
  },
  'POST tickets/:id/stop': {
    answer: ({ params }) => {
      if (!ticketOf(params.id)) return refuse(404, 'Ticket not found')
      server.tickets.open = []
      server.person = server.person.filter((ticket) => ticket.id !== params.id)
      return { stopped: true }
    },
  },
  'POST executor/pause': {
    body: true,
    answer: ({ body }) => {
      server.settings = { ...server.settings, paused: body.paused }
      server.revisions.pause = (server.revisions.pause ?? 0) + 1
      return { paused: body.paused }
    },
  },
  'PUT settings/:block': {
    body: true,
    answer: ({ params: { block }, body }) => {
      const source = block.startsWith('source:')
        ? KINDS.find((kind) => `source:${kind.kind}` === block)
        : undefined
      if (!['policy', 'eval', 'executor'].includes(block) && !source)
        return block.startsWith('source:')
          ? refuse(404, 'Source not found')
          : refuse(400, 'Invalid settings: block')
      if (body.revision !== (server.revisions[block] ?? 0))
        return refuse(409, 'Settings changed. Reload before saving.')
      let restarting = false
      if (block === 'policy')
        server.settings = { ...server.settings, policy: PolicyConfigSchema.parse(body.value) }
      else if (block === 'executor')
        server.settings = { ...server.settings, executor: ExecutorConfigSchema.parse(body.value) }
      else if (block === 'eval')
        server.settings = { ...server.settings, eval: EvalConfigSchema.parse(body.value) }
      else if (source) {
        const { enabled, config: value } = SourceSave.parse(body.value)
        const config = source.schema.parse(value)
        // As on the server, a changed CLI that fails its check refuses the save with the setup problem.
        if (config.cli === 'gh-broken') {
          const refused = new SetupError('agentCliMissing', { output: 'gh-broken: not found' })
          return refuse(400, refused.message, { setup: refused.problem })
        }
        restarting = (config.cli ?? '') !== (server.settings.sources[source.kind]?.config.cli ?? '')
        server.settings = {
          ...server.settings,
          sources: { ...server.settings.sources, [source.kind]: { enabled, config } },
        }
      }
      server.revisions[block] = (server.revisions[block] ?? 0) + 1
      return { restarting, revision: server.revisions[block] }
    },
  },
  'GET policy/history': { answer: () => server.history },
  'POST policy-sync/:id': { answer: ({ params }) => ({ policy: server.settings.policy.sources[params.id] }) },
  'POST setup/check': { answer: () => ({ restarting: true }) },
  'GET models': {
    answer: () => ({
      default: { provider: 'host', model: 'default' },
      routableProviders: [],
      failures: [],
      groups: [
        {
          id: 'worker-provider',
          name: 'Worker provider',
          models: [
            {
              id: 'worker-model',
              name: 'Worker model',
              reasoning: { efforts: [{ id: 'high', name: 'High' }] },
            },
          ],
        },
      ],
    }),
  },
  'GET prompts': { query: ['revision', 'offset'], answer: () => server.prompts },
  'PUT prompts': {
    body: true,
    answer: ({ body }) => {
      const { revision } = server.prompts
      if (body.baseRevision !== revision)
        return refuse(409, `Prompt version changed to ${revision}; compare the latest version before saving`)
      // As the host does: a template keeps its placeholders, and no overrides are stored as none.
      const { overrides = {}, ...config } = body.config as PromptsView['current']['config']
      for (const [part, override] of Object.entries(overrides)) {
        if (!builtInPart(part)) return refuse(400, 'refused', { code: 'unknownPromptPart', values: { part } })
        const missing = (builtInPart(part)?.placeholders ?? []).filter(
          (placeholder) => !override.text.includes(placeholder),
        )
        if (missing.length)
          return refuse(400, 'refused', {
            code: 'promptPlaceholders',
            values: { part, placeholders: missing.join(', ') },
          })
      }
      server.prompts.revision++
      server.prompts.current = promptVersion(
        server.prompts.revision,
        Object.keys(overrides).length ? { ...config, overrides } : config,
      )
      return { revision: server.prompts.revision, context_delivery: 'injected' }
    },
  },
  'POST prompts/preview': {
    body: true,
    answer: ({ body }) => {
      const skills = [
        ...(server.setup.accounts?.feishu ? ['feishu'] : []),
        'github',
        ...Object.keys(body.skills),
      ].map((name) => [name, composeSkill(body, name)])
      // The generated parts from their templates, without variables or rules.
      const environment = environmentSection(body, []),
        policy = policySection(SettingsSchema.parse({ policy: { rules: [] } }), body)
      return {
        parts: {
          orchestrator: promptParts(body, 'orchestrator', environment, policy),
          worker: promptParts(body, 'worker', environment),
        },
        skills: Object.fromEntries(skills),
        orchestrator: composePrompt(body, 'orchestrator'),
        worker: composePrompt(body, 'worker'),
        scope: '',
      }
    },
  },
}

async function run<K extends keyof Api>(
  key: K,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown,
): Promise<Answer<K>> {
  const route: Route<K> = ROUTES[key]
  const read: readonly string[] = route.query ?? []
  for (const name of query.keys())
    if (!read.includes(name)) server.misuse.push(`${key} with the query parameter ${name}`)
  if ((body !== undefined) !== !!route.body)
    server.misuse.push(`${key} ${body === undefined ? 'without' : 'with'} a body`)
  const values: Partial<Record<Query<K>, string>> = {}
  for (const name of route.query ?? []) {
    const value = query.get(name)
    if (value !== null) values[name] = value
  }
  return route.answer({ params: params as RouteParams<K>, query: values, body: body as Body<K> })
}
/** The route a service stands for, its path parameters and what is left of the input after them. */
function routeOf(name: string) {
  const entry = (Object.entries(SERVICES) as [keyof Api, readonly [string, 'query' | 'effect']][]).find(
    ([, [service]]) => service === name,
  )
  if (!entry) return undefined
  const [key, [, kind]] = entry
  return { key, kind }
}
/** Answers one service call from the route table, recording the request as the route it replaces. */
async function dispatch(
  name: string,
  kind: 'query' | 'effect',
  input: Record<string, unknown>,
): Promise<unknown> {
  if (server.down) throw new Error('CAPABILITY_DENIED')
  // The Host checks the input against the declared schema before the handler runs, and refuses what does not fit.
  const service = PANEL_SERVICES.find((item) => item.name === name)
  const invalid = service ? problems(service.inputSchema as never, input) : []
  if (invalid.length) {
    server.misuse.push(`${name}: ${invalid.join('; ')}`)
    // What `clientProfileCaller` throws for any refusal of the Host: one localized error, no code.
    throw new Error('The plugin backend service is currently unavailable.')
  }
  const route = routeOf(name)
  if (!route) return { failure: { status: 404, error: 'Unknown operation' } }
  server.calls.push([kind, name])
  if (route.kind !== kind) server.misuse.push(`${name} called as ${kind}`)
  const [method, pattern] = route.key.split(' ') as [string, string]
  const names = [...pattern.matchAll(/:(\w+)/g)].map((match) => match[1]!)
  const params = Object.fromEntries(names.map((field) => [field, String(input[field])]))
  const rest = Object.fromEntries(Object.entries(input).filter(([field]) => !names.includes(field)))
  const spec = ROUTES[route.key] as unknown as Route<keyof Api>
  // The preview takes the prompt configuration itself as its body; every other body is the rest of the input.
  const body = spec.body ? (route.key === 'POST prompts/preview' ? rest.config : rest) : undefined
  const query = new URLSearchParams(
    spec.body ? {} : Object.fromEntries(Object.entries(rest).map(([field, value]) => [field, String(value)])),
  )
  const path = pattern.replace(/:(\w+)/g, (_match, field: string) => params[field]!)
  server.requests.push({
    path: decodeURIComponent(`${path}${query.size ? `?${query}` : ''}`),
    method,
    ...(body === undefined ? {} : { body }),
  })
  const answer = await run(route.key, params, query, body)
  return answer instanceof Refusal ? { failure: { status: answer.status, ...answer.body } } : answer
}
/** The profile services the panel is given: the route table behind the services' names. */
export const services = {
  query: (name: string, input: Record<string, unknown>) => dispatch(name, 'query', input),
  effect: async (name: string, input: Record<string, unknown>, options: { operationId: string }) => ({
    state: 'completed',
    operationId: options.operationId,
    output: await dispatch(name, 'effect', input),
  }),
}

export function usePanelServer(cleanup: () => void) {
  beforeEach(() => {
    sessionStorage.clear()
    server = initial()
  })
  afterEach(() => {
    try {
      expect(server.misuse).toEqual([])
    } finally {
      cleanup()
    }
  })
}
