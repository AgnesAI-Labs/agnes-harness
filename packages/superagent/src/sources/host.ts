// Adapted from dsh-superagent (MIT)
/** Host and context interfaces connecting Source plugins to the application; also imported by the web panel, so it must not import Node-only modules. */
import type {
  ChannelRef,
  OutboundMessage,
  ReceiveResult,
  Thread,
  ThreadFact,
  ThreadRef,
  Ticket,
  Trigger,
} from '../core/index.js'
import type { Deployment } from '../deployment.js'
import type { Commands } from '../infra/commands.js'
import { fill } from '../infra/text.js'
import type { Family, Key } from '../kv.js'
import type { SetupProblem } from '../setup.js'
import type { SourceRegistry } from './registry.js'

/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuDedicatedBot:
    "Direct messages and other chats need a Feishu bot instance of Superagent's own; only the listed chats are received",
  feishuWaiting: 'Waiting for the channel subscription',
  feishuChannelUnset: 'Setup required: the Source is on, and its channel instance is not set',
  feishuChatsUnset: 'Setup required: no chat is listed to receive',
  feishuChannelRefused:
    'Setup required: the channel instance {channel} refused the chats ({reason}); retrying',
  feishuPluginUnset:
    'Setup required: to claim the whole instance, name it with its channel row, as <channel row id>/<instance id>',
  feishuInstanceShared:
    'Setup required: the channel instance {channel} already serves the owner or another feature; use a dedicated bot instance',
  feishuInstanceReleasing:
    'Setup required: the channel instance {channel} is in use; waiting for a previous Superagent run to release it',
  feishuInstanceRefused:
    'Setup required: the channel instance {channel} refused the claim ({reason}); retrying',
  feishuNoHistory:
    'The channel cannot read chat history, so nothing is recovered after a restart or disconnect',
  feishuNoMembers:
    'The channel cannot list chat members, so the allowlist is not synced and the allowlist in the settings applies',
  feishuNoReads:
    'The channel cannot read messages or threads, so orchestrator_feishu_read and context reads are unavailable',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export type Health = {
  state: 'starting' | 'ready' | 'paused' | 'error'
  detail: string
  at?: string
  code?: HealthCode
  values?: Record<string, string>
}
export function health(
  state: Health['state'],
  code: HealthCode,
  values: Record<string, string> = {},
): Health {
  return {
    state,
    detail: fill(HEALTH_TEXT[code], values),
    code,
    ...(Object.keys(values).length ? { values } : {}),
  }
}
export interface SourceHost {
  readonly sources: SourceRegistry
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
export interface ThreadDescription {
  label?: string
  url?: string
  facts?: Record<string, ThreadFact | null>
}
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly ready: Promise<void>
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean
  /** Setup problem keeping this Source's account from running; only the Feishu bot check reports one. */
  readonly problem?: SetupProblem | undefined
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: {
    get<V>(key: Key<V>): V | undefined
    set<V>(key: Key<V>, value: V | undefined): void
    keys<V>(family: Family<V, never>): Key<V>[]
  }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** Open tickets, newest first. */
    open(): Ticket[]
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: {
    get(id: string): Trigger | undefined /** The newest Trigger on a Thread. */
    latest(thread: string): Trigger | undefined
  }
  notify(message: OutboundMessage): void
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void
}
export const sourceContext = (
  host: SourceHost,
  kind: { kind: string; health: readonly string[] },
): SourceContext => host.context(kind)
