// Adapted from dsh-superagent (MIT)
/** Serves paginated context resources to orchestrator_read so large bodies stay out of model prompts until requested. */
import type { TextCache } from '../app/cache.js'
import {
  ASSIGNMENTS,
  assignmentLine,
  decisionCard,
  decisionDetails,
  INPUTS,
  inputLine,
  newestPage,
  preview,
  type TicketThread,
  textPage,
  threadCard,
  ticketCard,
  ticketDetails,
  triggerCard,
} from '../app/cards.js'
import { triggerMessage } from '../app/messages.js'
import type { Prompts, PromptVersion } from '../app/prompts.js'
import { builtInParts, defaultPrompts } from '../app/prompts.js'
import type { Settings } from '../app/settings.js'
import type { Store } from '../app/store.js'
import { threadTitle } from '../app/views/records.js'
import {
  key,
  latestReport,
  reached,
  runningAssignment,
  type Ticket,
  type Trigger,
  threadKey,
  UserError,
} from '../core/index.js'
import type { Commands } from '../infra/commands.js'
import type { FeishuIo } from '../sources/feishu-io.js'
import { feishuRead, feishuReferences } from '../sources/feishu-read.js'
import { feishuRef, feishuTriggerId } from '../sources/feishu-trigger.js'
import { readGithub } from '../sources/github-read.js'
import { batchOf, inputMessage } from './assignment.js'
import { workerKey } from './sessions.js'

/** Resource descriptors exposed via orchestrator_read, marking which ones worker sessions may also read for their ticket. */
export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  {
    name: 'tickets',
    holds:
      "ticket cards, newest first; a card's state is person/review after a ready report, person/blocked or person/failed after those reports, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, else how the ticket ended",
  },
  { name: 'triggers', holds: 'trigger cards with where each went, newest first' },
  {
    name: 'threads',
    holds:
      'subscribed threads, newest activity first, with their labels, tickets, current assessment and polling errors',
  },
  {
    name: 'thread/<key>',
    holds: 'one thread: its label and link, its tickets and latest decisions, and its triggers, newest first',
    executor: true,
  },
  { name: 'decisions', holds: 'decisions, newest first' },
  { name: 'decision/<id>', holds: 'one decision with its audit' },
  {
    name: 'ticket/<id>',
    holds:
      "a ticket's card, the trigger, decision and threads it is tied to, its latest assignments with the start of each report, and its inputs, newest first",
    executor: true,
  },
  { name: 'ticket/<id>/assignment', holds: 'its assignment text', executor: true },
  {
    name: 'ticket/<id>/assignments',
    holds: 'its assignments, newest first, with the start of each report',
    executor: true,
  },
  { name: 'ticket/<id>/inputs', holds: 'its inputs, newest first', executor: true },
  { name: 'ticket/<id>/result', holds: 'its latest report', executor: true },
  { name: 'ticket/<id>/report/<id>', holds: 'the report of one of its assignments', executor: true },
  { name: 'ticket/<id>/transcript', holds: "its worker session's messages, newest first", executor: true },
  { name: 'ticket/<id>/message/<n>', holds: 'one message of that transcript', executor: true },
  { name: 'ticket/<id>/input/<id>', holds: 'one input it was delivered', executor: true },
  {
    name: 'trigger/<id>',
    holds:
      "a trigger's text, where it went, the message it replies to and the messages around it on its thread",
    executor: true,
  },
  {
    name: 'settings',
    holds:
      'settings by block, each with the revision a save names: the small blocks whole, the Policy and the Source instances summarized',
  },
  {
    name: 'settings/<block>',
    holds:
      'one settings block whole, as orchestrator_settings_save takes it: policy, eval, executor, pause or source:<id>',
  },
  { name: 'prompts', holds: 'the prompt revision each Session reads, the skills, and the saved versions' },
  {
    name: 'prompts/<revision>',
    holds: 'one prompt version by number, or current, the one the Session works under',
    executor: true,
  },
  {
    name: 'prompts/defaults',
    holds: 'the built-in prompt configuration, and the built-in parts by the key an override names',
  },
  { name: 'prompt-preview/<id>', holds: 'a composed prompt that orchestrator_prompts_save previewed' },
  { name: 'models', holds: "the model routes AGH has configured, its default and each role's model" },
  { name: 'models/<route>', holds: "one route's models" },
  {
    name: 'feishu/<trigger-id>/…',
    holds: 'a Feishu original, as the dsh-superagent-feishu skill describes',
    executor: true,
  },
  {
    name: 'github/…',
    holds: 'a GitHub original, as the dsh-superagent-github skill describes',
    executor: true,
  },
]
export const resourceGrammar = (executor: boolean): string =>
  RESOURCES.filter((resource) => !executor || resource.executor)
    .map((resource) => `${resource.name}: ${resource.holds}`)
    .join('; ')

export interface ModelCatalog {
  default: { route: string; model: string } | null
  groups: { id: string; name: string; models: { id: string; name: string }[] }[]
  failures: string[]
}
export interface ResourceHost {
  readonly store: Pick<
    Store,
    'get' | 'settings' | 'triggers' | 'tickets' | 'threads' | 'read' | 'decisions' | 'replyStatus'
  >
  readonly pages: TextCache
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'skills' | 'defaultChanged'>
  readonly commands: Commands
  readonly masterId: string
  promptVersion(sessionId: string): PromptVersion
  /** Whether a Session may read `revision` (the revision it currently runs under or any revision it ran under previously). */
  mayRead(sessionId: string, revision: number): boolean
  feishuPageSize(): number
  /** The Feishu Source's channel reads; throws while the Source is off or not connected. */
  feishu(signal?: AbortSignal): FeishuIo
  sourceLink(
    trigger: Trigger,
    signal?: AbortSignal,
  ): Promise<{ source_url?: string; source_url_read?: string }>
  /** A worker session's messages, oldest first. */
  transcript(sessionId: string): Promise<{ type: 'user' | 'assistant'; text: string }[]>
}
export interface MainResourceHost extends ResourceHost {
  readonly sessions: {
    status(): {
      revision: number
      sessions: { sessionId: string; revision: number }[]
      notificationPending: boolean
    }
    modelRetry(sessionId: string | false | undefined): object
  }
  readonly settings: Pick<Settings, 'view' | 'block'>
  models(): Promise<ModelCatalog>
}
interface Read {
  host: ResourceHost
  resource: string
  rest: string
  offset: number
  limit?: number
  sessionId: string
  ticketId?: string
  signal?: AbortSignal
}
type Route = readonly [name: string, read: (read: Read) => unknown]

/** Enforces that main-Session-only resources cannot be read by worker Sessions. */
const main = ({ host, ticketId }: Read): MainResourceHost => {
  if (ticketId || !('settings' in host)) throw new Error('This resource belongs to the main Session')
  return host as MainResourceHost
}
const text = ({ resource, offset, limit }: Read, body: string) =>
  textPage(resource, body, offset, limit ?? 4000)
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? 20, 50)
  const items = fetch(offset, size + 1)
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}
/** Whether a worker session's ticket may read a trigger (via delivery, ticket origin, or followed thread). */
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean =>
  reached(ticket, trigger, (name) => host.store.threads.get(name)) ||
  ticket.origin.triggerIds.includes(trigger.id) ||
  trigger.threads.some((ref) => ticket.follows?.some((follow) => follow.thread === threadKey(ref)))
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  return found
}
/** Fetch and cache a source resource on offset 0, serving subsequent offsets from the session cache. */
async function sourcePage(read: Read, source: string, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`)
  if (body === undefined)
    throw new Error(`Read this ${source === 'feishu' ? 'Feishu' : 'GitHub'} resource from offset 0 first`)
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body)
  return text(read, body)
}
const THREAD_DECISIONS = 5
const triggerLine = (item: Trigger) => ({
  trigger_id: item.id,
  actor: item.actor.id,
  human: item.human,
  at: item.at,
  preview: preview(item.text),
  chars: item.text.length,
  read: `trigger/${item.id}`,
})

const ROUTES: readonly Route[] = [
  [
    'tickets',
    (read) => {
      const host = main(read)
      const tickets = host.store.tickets.list()
      const card = (item: Ticket) => ({
        ...ticketCard(item),
        ...host.sessions.modelRetry(runningAssignment(item) && workerKey(item.id)),
      })
      return list(read, (offset, count) => tickets.slice(offset, offset + count).map(card))
    },
  ],
  [
    'triggers',
    (read) => {
      const { store } = main(read)
      return list(read, (offset, count) =>
        store.read
          .recentTriggers(offset, count)
          .map((item) => triggerCard(item, store.triggers.disposition(item.id))),
      )
    },
  ],
  [
    'threads',
    (read) => {
      const { store } = main(read)
      const threads = store.read
        .subscribedThreads()
        .sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
      return list(read, (offset, count) =>
        threads.slice(offset, offset + count).map((item) => threadCard(item, threadTitle(store, item))),
      )
    },
  ],
  [
    'thread/',
    (read) => {
      const { host, rest, ticketId } = read
      const thread = host.store.threads.get(rest)
      const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
      // Worker Sessions may only read threads their own ticket subscribes to or follows.
      if (
        !thread ||
        (ticketId &&
          !(
            thread.subscriptions.includes(ticketId) ||
            ticket?.follows?.some((follow) => follow.thread === rest)
          ))
      )
        throw new Error('Unknown or inaccessible thread')
      const { store } = host
      const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread))
      const page = list(read, (offset, count) =>
        store.read.threadPage(thread.key, offset, count).map(triggerLine),
      )
      // Worker sessions cannot inspect other tickets or decisions on a shared thread.
      if (ticketId) return { ...card, ...page }
      const tickets = ids.flatMap((id) => {
        const found = store.tickets.get(id)
        return found ? [ticketCard(found)] : []
      })
      const decisions = store.decisions
        .byThread(thread.key)
        .slice(-THREAD_DECISIONS)
        .reverse()
        .map(decisionCard)
      return { ...card, tickets, decisions, ...page }
    },
  ],
  [
    'decisions',
    (read) =>
      list(read, (offset, count) => main(read).store.read.recentDecisions(offset, count).map(decisionCard)),
  ],
  [
    'decision/',
    (read) => {
      const decision = main(read).store.decisions.get(read.rest)
      if (!decision) throw new Error('Unknown decision')
      return decisionDetails(decision)
    },
  ],
  ['settings', (read) => main(read).settings.view()],
  ['settings/', (read) => text(read, JSON.stringify(main(read).settings.block(read.rest)))],
  [
    'prompts',
    (read) => {
      const host = main(read)
      const current = host.prompts.current()
      const status = host.sessions.status()
      const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50))
      const skills = host.prompts.skills(current.config).map(([name]) => name)
      const changes = host.prompts.defaultChanged(current.config)
      const changed = changes.filter((item) => !item.removed).map((item) => item.part)
      const removed = changes.filter((item) => item.removed).map((item) => item.part)
      return {
        revision: status.revision,
        read: `prompts/${current.revision}`,
        notification_pending: status.notificationPending,
        ...(changed.length ? { default_changed: changed } : {}),
        ...(removed.length ? { removed_parts: removed } : {}),
        sessions: status.sessions.map((session) => ({
          session_id: session.sessionId,
          revision: session.revision,
        })),
        skills: {
          built_in: skills
            .filter((name) => !(name in current.config.skills))
            .map((name) => `dsh-superagent-${name}`),
          team: Object.keys(current.config.skills).map((name) => `dsh-superagent-${name}`),
        },
        items: history.revisions.map(({ previousRevision, savedAt, ...version }) => ({
          ...version,
          previous_revision: previousRevision,
          saved_at: savedAt,
        })),
        next_offset: history.next_offset,
      }
    },
  ],
  // A worker Session may read only its current prompt revision and revisions it previously ran under.
  [
    'prompts/',
    (read) => {
      const { host, resource, rest, sessionId, ticketId } = read
      const prompts = host.prompts
      const bound = host.promptVersion(sessionId)
      const parts = () =>
        Object.fromEntries(Object.entries(builtInParts()).map(([name, part]) => [name, part.text]))
      const version =
        rest === 'current'
          ? bound
          : rest === 'defaults' && !ticketId
            ? { revision: 0, config: defaultPrompts(), parts: parts() }
            : /^\d+$/.test(rest)
              ? Number(rest) === 0 && prompts.current().revision === 0
                ? prompts.current()
                : prompts.version(Number(rest))
              : undefined
      if (!version || (ticketId && !host.mayRead(sessionId, version.revision)))
        throw new Error('Unknown or inaccessible prompt version')
      return text(
        { ...read, resource: rest === 'current' ? `prompts/${version.revision}` : resource },
        JSON.stringify(version),
      )
    },
  ],
  [
    'prompt-preview/',
    (read) => {
      const body = main(read).pages.get(`${read.sessionId}:${read.resource}`)
      if (body === undefined) throw new Error('Unknown preview for this Session')
      return text(read, body)
    },
  ],
  [
    'models',
    async (read) => {
      const host = main(read)
      const catalog = await host.models()
      const settings = host.store.settings()
      const roles = { orchestrator: settings.eval.model, worker: settings.executor.model }
      return {
        default: catalog.default,
        roles,
        failures: catalog.failures,
        providers: catalog.groups.map((group) => ({
          id: group.id,
          name: group.name,
          count: group.models.length,
          read: `models/${group.id}`,
        })),
      }
    },
  ],
  [
    'models/',
    async (read) => {
      const models = (await main(read).models()).groups.find((group) => group.id === read.rest)?.models
      if (!models) throw new Error('Unknown model route')
      return list(read, (offset, count) => models.slice(offset, offset + count))
    },
  ],
  [
    'feishu/',
    async (read) => {
      const source = trigger(read.host, read.rest.split('/')[0]!, read.ticketId)
      const ref = feishuRef(source)
      if (!ref) throw new Error('A Feishu source trigger is required')
      return sourcePage(read, 'feishu', () =>
        feishuRead(read.host.feishu(read.signal), ref, read.resource, read.host.feishuPageSize()),
      )
    },
  ],
  [
    'github/',
    (read) =>
      sourcePage(read, 'github', () => readGithub(read.host.commands.withSignal(read.signal), read.resource)),
  ],
  ['trigger/', (read) => triggerResource(read)],
  ['ticket/', (read) => ticketResource(read)],
]

async function triggerResource(read: Read) {
  const { host, rest, ticketId, offset, signal } = read
  if (!rest || rest.includes('/')) throw new Error('Unknown context resource')
  const found = trigger(host, rest, ticketId)
  const ref = feishuRef(found)
  // Redact decision IDs, other tickets, and unreachable neighbour triggers when a worker session reads a trigger.
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  const shown = (item: Trigger | undefined) =>
    item && (!ticket || readable(host, ticket, item)) ? item : undefined
  const disposition = host.store.triggers.disposition(found.id)
  const visible =
    disposition && ticket
      ? ({
          ...disposition,
          decisionId: undefined,
          fanout: disposition.fanout.filter((id) => id === ticket.id),
        } as unknown as typeof disposition)
      : disposition
  // Omit card preview and self-reference because this resource returns the full text.
  const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
  const parent =
    found.source === 'feishu' && typeof found.meta.parentId === 'string' ? found.meta.parentId : undefined
  const repliedTo = shown(parent ? host.store.triggers.get(feishuTriggerId(parent)) : undefined)
  const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
  const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
  return {
    ...card,
    ...(await host.sourceLink(found, signal)),
    acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
    ...(ref ? { context: feishuReferences(ref) } : {}),
    ...(offset === 0
      ? {
          ...(repliedTo ? { replied_to: triggerLine(repliedTo) } : {}),
          around: {
            ...(around.before ? { before: triggerLine(around.before) } : {}),
            ...(around.after ? { after: triggerLine(around.after) } : {}),
          },
        }
      : {}),
    ...text(read, found.text),
  }
}

async function ticketResource(read: Read) {
  const { host, resource, rest, ticketId, signal } = read
  const [id, section, part, ...more] = rest.split('/')
  if (!id || more.length) throw new Error('Unknown context resource')
  if (ticketId && ticketId !== id) throw new Error('Ticket does not belong to this worker')
  const ticket = host.store.tickets.get(id)
  if (!ticket) throw new UserError('unknownTicket')
  if (section === undefined) {
    const running = runningAssignment(ticket) && workerKey(ticket.id)
    const retry = 'sessions' in host ? (host as MainResourceHost).sessions.modelRetry(running) : {}
    // Merge subscribed threads (including context-only subscriptions) and source-bound threads without duplicates.
    const bound = new Set((ticket.follows ?? []).map((follow) => follow.thread))
    const subscribed = host.store.read
      .subscribedThreads()
      .filter((thread) => thread.subscriptions.includes(id))
    const marked = (name: string, context: boolean): TicketThread => ({
      thread: name,
      ...(context ? { context: true } : {}),
      ...(bound.has(name) ? { bound: true } : {}),
    })
    const threads = [
      ...subscribed.map((thread) => marked(thread.key, !!thread.context?.includes(id))),
      ...[...bound]
        .filter((name) => !subscribed.some((thread) => thread.key === name))
        .map((name) => marked(name, false)),
    ]
    return { ...ticketDetails(ticket, threads, batchOf(host, ticket), !!ticketId), ...retry }
  }
  if (section === 'assignments' || section === 'inputs') {
    if (part !== undefined) throw new Error('Unknown context resource')
    const size = Math.min(read.limit ?? (section === 'assignments' ? ASSIGNMENTS : INPUTS), 50)
    const { items, next_offset } =
      section === 'assignments'
        ? newestPage(ticket.assignments, read.offset, size, (item) => assignmentLine(ticket, item), resource)
        : newestPage(
            ticket.inputs,
            read.offset,
            size,
            (input) => inputLine(ticket, input, !!ticketId),
            resource,
          )
    return { items, next_offset: next_offset ?? null }
  }
  let body: string
  if (section === 'input' && part) {
    // Render the input on demand with its resolved source link, matching either its short key or full input ID.
    const input = ticket.inputs.find((item) => key(item.id) === part || item.id === part)
    const source = input?.kind === 'trigger' ? host.store.triggers.get(input.triggerId) : undefined
    const card =
      source && input?.kind === 'trigger'
        ? triggerMessage(source, await host.sourceLink(source, signal), input.note)
        : undefined
    const message = input && inputMessage(input, card)
    if (message === undefined) throw new Error('Unknown ticket input')
    body = message
  } else if (section === 'message' && part && /^\d+$/.test(part)) {
    const entry = (await host.transcript(workerKey(id)))[Number(part)]
    if (!entry) throw new Error('Unknown transcript entry')
    body = JSON.stringify(entry)
  } else if (section === 'report' && part) {
    const report = ticket.assignments.find((item) => item.id === part)?.report
    if (!report) throw new Error('Unknown assignment report')
    body = report.summary
  } else if (part !== undefined) throw new Error('Unknown context resource')
  else if (section === 'assignment') body = ticket.execution?.assignment ?? ''
  else if (section === 'result') body = latestReport(ticket)?.summary ?? ''
  else if (section === 'transcript') {
    body = (await host.transcript(workerKey(id)))
      .map((entry, index) =>
        JSON.stringify({
          type: entry.type,
          preview: preview(entry.text).slice(0, 80),
          chars: entry.text.length,
          read: `ticket/${id}/message/${index}`,
        }),
      )
      .reverse()
      .join('\n')
  } else throw new Error('Unknown context resource')
  return text(read, body)
}

/**
 * Read a paginated resource for the main Session or a ticket's worker Session. Legacy prefixes (`event/`, `task/`,
 * `observation/`) remain accepted so references in older Session history stay readable.
 */
export async function readResource(
  host: ResourceHost,
  resource: string,
  offset: number,
  limit: number | undefined,
  ticketId?: string,
  signal?: AbortSignal,
) {
  const name = resource
    .replace(/^event\//, 'trigger/')
    .replace(/^task\//, 'ticket/')
    .replace(/^observation\//, 'decision/')
  const route = ROUTES.find(([prefix]) => (prefix.endsWith('/') ? name.startsWith(prefix) : name === prefix))
  if (!route) throw new Error('Unknown context resource')
  const sessionId = ticketId ? workerKey(ticketId) : host.masterId
  const rest = route[0].endsWith('/') ? name.slice(route[0].length) : ''
  return route[1]({
    host,
    resource: name,
    rest,
    offset,
    sessionId,
    ...(limit ? { limit } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(signal ? { signal } : {}),
  })
}
