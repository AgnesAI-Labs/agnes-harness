// Adapted from dsh-superagent (MIT)
/**
 * The settings and panel services: the management routes of the original program, one service per route. A query
 * replaces a GET, an effect every other method. Path and query parameters are the service input.
 *
 * Handlers never throw for what a person did (a stale revision, a missing ticket, a refused setting): they answer
 * `{ failure: { status, error, … } }`, the status and body the route answered with, because the Host reports a thrown
 * effect only as an unknown outcome. The panel turns that answer back into an error.
 */
import type { PluginContextFacets, ServiceDef } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { z } from 'zod'
import { PromptConflict, savePrompts } from '../app/prompts.js'
import { SettingsConflict } from '../app/settings.js'
import { policyHistory } from '../app/settings-history.js'
import { overview } from '../app/views/overview.js'
import { settingsView } from '../app/views/settings.js'
import { sourcesStatus } from '../app/views/sources.js'
import { decisionList, search, THREAD_FILTERS, threadDetail, threadList } from '../app/views/threads.js'
import { executorLoad, ticketList } from '../app/views/tickets.js'
import { UserError } from '../core/index.js'
import { policyVersion } from '../policy.js'
import { SetupError } from '../setup.js'
import { NotReady } from './panel-host.js'
import { type PanelHost, promptsView, setupState, stateView, ticketPage, views } from './panel-views.js'

export type { ModelCatalog, PanelHost, PanelSessions } from './panel-views.js'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const

type Input = Record<string, unknown>
type Handler = (host: PanelHost, input: Input) => unknown
/** A route-shaped answer for something a person did that cannot be carried out. */
class RouteError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message)
  }
}

// What the routes accepted: out-of-range values were clamped or defaulted rather than refused.
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .catch(fallback)
    .transform((value) => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({
  filter: z.enum(THREAD_FILTERS).catch('subscribed'),
  offset,
  limit: limit(20, 1000),
})
const ThreadQuery = z.object({
  limit: limit(50, 100),
  before: z.string().optional(),
  around: z.string().optional(),
})
const DecisionsQuery = z.object({
  kind: z.string().default(''),
  window: z.literal('24h').optional().catch(undefined),
  offset,
  limit: limit(30, 200),
})
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SettingsBlockSchema = z.union([
  z.enum(['policy', 'eval', 'executor']),
  z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)]),
])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
const SETTINGS_BODY_BYTES = 128 * 1024

/** The size the original routes read a body up to; the services take the value as one input, so it is measured. */
function bounded(value: unknown, maxBytes: number): unknown {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > maxBytes)
    throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
  return value
}
const promptLimit = (host: PanelHost) => 4 * host.machine.promptMaxChars.get() + 4096
const text = (input: Input, key: string): string =>
  typeof input[key] === 'string' ? (input[key] as string) : ''

/** An action that changes something: refused as not ready before anything is read or applied, until every part is wired. */
const acting =
  (handler: Handler): Handler =>
  (host, input) => {
    if (host.wired === false) throw new NotReady('the other parts')
    return handler(host, input)
  }
const ACTIONS: readonly string[] = [
  'superagent.sources.refreshlabels',
  'superagent.settings.save',
  'superagent.threads.unsubscribe',
  'superagent.triggers.requeue',
  'superagent.decisions.dismiss',
  'superagent.tickets.retry',
  'superagent.tickets.stop',
  'superagent.executor.pause',
  'superagent.policy.sync',
  'superagent.setup.check',
  'superagent.prompts.save',
]

const READS_AND_ACTIONS: Readonly<Record<string, Handler>> = {
  'superagent.state': (host) => stateView(host),
  'superagent.overview': (host) =>
    overview(
      views(host),
      host.health,
      policyVersion(host.store.settings()),
      executorLoad(host.store, host.executor.activeCount()),
      host.setupProblem ?? host.feishuProblem,
    ),
  'superagent.search': (host, input) => search(views(host), text(input, 'q'), host.sourceLinks),
  'superagent.sources.list': (host) => sourcesStatus(views(host), host.health, setupState(host)),
  'superagent.sources.refreshlabels': (host, input) => host.settings.refreshLabels(text(input, 'id')),
  'superagent.settings.get': (host) =>
    settingsView(host.store, host.sources, host.health, setupState(host), host.machine.stateDir),
  'superagent.settings.save': async (host, input) => {
    const block = SettingsBlockSchema.parse(input.block)
    const known =
      !block.startsWith('source:') ||
      host.sources.instances().some((instance) => `source:${instance.id}` === block)
    if (!known) throw new RouteError(404, 'Source not found')
    bounded(input.value, SETTINGS_BODY_BYTES)
    const request = SaveRequest.parse({ value: input.value, revision: input.revision })
    return host.settings.save(block, request.value, request.revision, 'panel')
  },
  'superagent.threads.list': (host, input) => {
    const { filter, offset, limit } = ThreadsQuery.parse(input)
    return threadList(views(host), filter, offset, limit)
  },
  'superagent.threads.get': (host, input) => {
    const { limit, before, around } = ThreadQuery.parse(input)
    const detail = threadDetail(views(host), text(input, 'key'), before, limit, around)
    if (!detail) throw new RouteError(404, 'Thread not found')
    return detail
  },
  'superagent.threads.unsubscribe': async (host, input) => {
    const key = text(input, 'key')
    const removed = host.engine.unsubscribe(key)
    return { removed, thread: key, context_delivery: await host.sessions.delivery(`subscription:${key}`) }
  },
  'superagent.triggers.requeue': (host, input) => {
    const queued = host.engine.reevaluate(text(input, 'id'))
    host.requestPass()
    return { queued }
  },
  'superagent.decisions.list': (host, input) => {
    const { kind, window, offset, limit } = DecisionsQuery.parse(input)
    const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
    return decisionList(views(host), kind.split(',').filter(Boolean), offset, limit, since)
  },
  'superagent.decisions.dismiss': (host, input) => {
    host.engine.dismiss(text(input, 'id'))
    return { dismissed: true }
  },
  'superagent.tickets.list': (host, input) => {
    const { state, offset, limit } = TicketsQuery.parse(input)
    return ticketList(views(host), state, offset, limit)
  },
  'superagent.tickets.get': (host, input) => {
    const page = ticketPage(host, text(input, 'id'))
    if (!page) throw new RouteError(404, 'Ticket not found')
    return page
  },
  'superagent.tickets.retry': (host, input) => {
    const id = existingTicket(host, text(input, 'id'))
    host.engine.retryTicket(id)
    return { retried: true }
  },
  'superagent.tickets.stop': (host, input) => {
    const id = existingTicket(host, text(input, 'id'))
    host.engine.stopTicket(id)
    return { stopped: true }
  },
  'superagent.executor.pause': (host, input) =>
    host.settings.pause(z.object({ paused: z.boolean() }).parse(input).paused, 'panel'),
  'superagent.policy.history': (host) =>
    policyHistory(host.store, host.sources, policyVersion(host.store.settings())),
  'superagent.policy.sync': async (host, input) => ({ policy: await host.settings.sync(text(input, 'id')) }),
  'superagent.setup.check': (host) => {
    host.checkSetup()
    return { restarting: true }
  },
  'superagent.models.list': (host) => host.models(),
  'superagent.prompts.get': (host, input) => {
    const { revision, offset } = PromptsQuery.parse(input)
    return promptsView(host, revision, offset)
  },
  'superagent.prompts.save': (host, input) => {
    bounded(input.config, promptLimit(host))
    const request = z
      .object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() })
      .parse(input)
    return savePrompts(host, request.config, request.baseRevision, 'panel')
  },
  'superagent.prompts.preview': (host, input) =>
    host.prompts.preview(bounded(input.config, promptLimit(host))),
}
const HANDLERS: Readonly<Record<string, Handler>> = Object.fromEntries(
  Object.entries(READS_AND_ACTIONS).map(([name, handler]) => [
    name,
    ACTIONS.includes(name) ? acting(handler) : handler,
  ]),
)
function existingTicket(host: PanelHost, id: string): string {
  if (!host.store.tickets.get(id)) throw new RouteError(404, 'Ticket not found')
  return id
}

/** Maps what a handler threw to the status and body the original route answered with. */
function failure(error: unknown): { status: number; error: string } & Record<string, unknown> {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    return { status: 400, error: `Invalid settings: ${issues.map((issue) => issue.path).join(', ')}`, issues }
  }
  if (error instanceof SetupError) return { status: 400, error: error.message, setup: error.problem }
  if (error instanceof RouteError) return { status: error.status, error: error.message }
  if (error instanceof NotReady) return { status: 503, error: error.message }
  if (error instanceof UserError)
    return { status: error.missing ? 404 : 400, error: error.message, code: error.code, values: error.values }
  if (error instanceof SettingsConflict || error instanceof PromptConflict)
    return { status: 409, error: error.message }
  return { status: 500, error: error instanceof Error ? error.message : String(error) }
}

const schema = (properties: Record<string, JsonValue>, required: readonly string[] = []) => ({
  type: 'object' as const,
  properties,
  ...(Object.keys(properties).length ? { required: [...required] } : {}),
  additionalProperties: false as const,
})
const id = { type: 'string', minLength: 1, maxLength: 256 } as const
const paging = (max: number) => ({
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: max },
})
const effect = (flags: { destructive?: boolean; openWorld?: boolean } = {}) => ({
  isDestructive: flags.destructive ?? false,
  isOpenWorld: flags.openWorld ?? false,
  replay: 'never' as const,
  // The owner is acting in their own panel; there is nobody else to ask.
  requiresApproval: 'never' as const,
  approvalScopes: [] as string[],
})
/** `[name, input schema, effect policy]`; a service with no effect policy is a query. */
const TABLE: readonly [string, ReturnType<typeof schema>, ReturnType<typeof effect>?][] = [
  ['superagent.state', schema({})],
  ['superagent.overview', schema({})],
  ['superagent.search', schema({ q: { type: 'string', maxLength: 1000 } })],
  ['superagent.sources.list', schema({})],
  ['superagent.sources.refreshlabels', schema({ id }, ['id']), effect({ openWorld: true })],
  ['superagent.settings.get', schema({})],
  [
    'superagent.settings.save',
    schema(
      {
        block: { type: 'string', pattern: '^(policy|eval|executor|source:[a-z][a-z0-9-]*)$', maxLength: 128 },
        value: {},
        revision: { type: 'integer', minimum: 0 },
      },
      ['block', 'value', 'revision'],
    ),
    effect(),
  ],
  ['superagent.threads.list', schema({ filter: { enum: [...THREAD_FILTERS] }, ...paging(1000) })],
  [
    'superagent.threads.get',
    schema(
      {
        key: { type: 'string', minLength: 1, maxLength: 1024 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        before: { type: 'string', maxLength: 1024 },
        around: { type: 'string', maxLength: 1024 },
      },
      ['key'],
    ),
  ],
  [
    'superagent.threads.unsubscribe',
    schema({ key: { type: 'string', minLength: 1, maxLength: 1024 } }, ['key']),
    effect(),
  ],
  ['superagent.triggers.requeue', schema({ id }, ['id']), effect()],
  [
    'superagent.decisions.list',
    schema({ kind: { type: 'string', maxLength: 1024 }, window: { const: '24h' }, ...paging(200) }),
  ],
  ['superagent.decisions.dismiss', schema({ id }, ['id']), effect()],
  ['superagent.tickets.list', schema({ state: { enum: [...TICKET_FILTERS] }, ...paging(1000) })],
  ['superagent.tickets.get', schema({ id }, ['id'])],
  ['superagent.tickets.retry', schema({ id }, ['id']), effect()],
  ['superagent.tickets.stop', schema({ id }, ['id']), effect({ destructive: true })],
  ['superagent.executor.pause', schema({ paused: { type: 'boolean' } }, ['paused']), effect()],
  ['superagent.policy.history', schema({})],
  ['superagent.policy.sync', schema({ id }, ['id']), effect({ openWorld: true })],
  ['superagent.setup.check', schema({}), effect({ openWorld: true })],
  ['superagent.models.list', schema({})],
  [
    'superagent.prompts.get',
    schema({ revision: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 } }),
  ],
  [
    'superagent.prompts.save',
    schema({ config: {}, baseRevision: { type: 'integer', minimum: 0 } }, ['config', 'baseRevision']),
    effect(),
  ],
  // The body of the original request is the `config` field: a service input is a closed object.
  ['superagent.prompts.preview', schema({ config: {} }, ['config']), effect()],
]

/** What a running Superagent answers a panel service call with. */
export interface PanelService {
  call(name: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue>
}
type PanelCall = (name: string, input: JsonValue, signal: AbortSignal) => Promise<JsonValue>
/** Every panel service as the manifest declares it, with the handler that forwards to `call`. */
const definitions = (call: PanelCall): (ServiceDef & { kind: 'query' | 'effect' })[] =>
  TABLE.map(([name, inputSchema, effectPolicy]) => ({
    name,
    scope: 'profile' as const,
    inputSchema,
    outputSchema: {},
    timeoutMs: 30_000,
    maxResultBytes: 1_048_576,
    ...(effectPolicy ? { kind: 'effect' as const, effectPolicy } : { kind: 'query' as const }),
    handler: (input: JsonValue, context) => call(name, input, context.signal),
  }))
/** The service definitions without a running service, for what reads the table. */
export const PANEL_SERVICES = definitions(() => Promise.reject(new Error('No running service')))

/** The panel services over one host; every answer is plain JSON. */
export function createPanelServices(host: PanelHost): PanelService {
  return {
    async call(name, input) {
      const run = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined
      try {
        if (!run) throw new RouteError(404, 'Unknown operation')
        // An undefined field (a view's optional value) is not JSON; a round trip drops it as a response body did.
        const answer = JSON.stringify(await run(host, (input ?? {}) as Input))
        return (answer === undefined ? null : JSON.parse(answer)) as JsonValue
      } catch (error) {
        return { failure: failure(error) } as JsonValue
      }
    },
  }
}

/**
 * Registers the panel services on the plugin. Each forwards to the running Superagent; while it is not current (not
 * started, stopped, or from an older generation) a call is refused as the Host refuses any service it cannot reach.
 */
export function registerPanelServices(
  plugin: Pick<PluginContextFacets, 'services'>,
  running: () => Promise<{
    callService(name: string, input: unknown, signal: AbortSignal): Promise<JsonValue>
  }>,
): () => void {
  const disposers: (() => void)[] = []
  try {
    for (const definition of definitions(async (name, input, signal) => {
      const service = await running().catch(() => {
        throw Object.assign(new Error('Superagent is not running'), { code: 'CAPABILITY_DENIED' })
      })
      return service.callService(name, input, signal)
    }))
      disposers.push(plugin.services.register(definition))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
