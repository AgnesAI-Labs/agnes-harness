import {
  defineServiceKind,
  type ServiceInstance,
  type ServicePortName,
  type ServicePorts,
} from '@agnes/extension-api'
import type { ServiceDescriptor } from '@agnes/host-common/assemble/service-binding'
import type { Actor, AuthoringCandidate, EventEnvelope } from '@agnes/protocol'
import type { AdminFeedbackParams, AdminFeedbackResult, FeedbackItem } from '@agnes/protocol/gen/app-server'

/** Reserved platform facts. They stay system/trusted, not an extension-owner namespace. */
export const FEEDBACK_EVENT = 'x/feedback/item'
export const FEEDBACK_GROWTH_EVENT = 'x/feedback/growth'

export const FEEDBACK_PROVIDER_ID = 'agh.feedback'
export const FEEDBACK_PROVIDER_VERSION = '1.0.0'
export const FEEDBACK_PACKAGE_ID = '@agnes/host'
/** Registry owner. Audience is host, so this is the call identity rather than a plugin manifest owner. */
export const FEEDBACK_OWNER = 'agnes/feedback'

export type FeedbackRequest = Readonly<AdminFeedbackParams>
export type FeedbackResult = Readonly<AdminFeedbackResult>

/**
 * One request's authority. The daemon builds a fresh object per call. Draft, candidate, and
 * multi-session reads stay here: they are not generic ledger, input, or projection operations.
 */
export interface FeedbackAuthority {
  sessions(): Promise<{ ids: readonly string[]; truncated: boolean }>
  scan(sessionId: string, types: readonly string[]): Promise<readonly EventEnvelope[]>
  /**
   * Only the two feedback events. The host re-checks the actor and the session.
   * New item ids come from id(). Envelope ids are minted by the host writer.
   */
  append(sessionId: string, type: string, data: Record<string, unknown>, actor: Actor): Promise<number>
  draft(
    sessionId: string,
    feedback: FeedbackItem,
    evidence: readonly EventEnvelope[],
    signal: AbortSignal,
  ): Promise<readonly { path: string; content: string }[]>
  /** Stable candidate binding, checked before non-deterministic draft inference. */
  recoverCandidate(
    sessionId: string,
    feedback: FeedbackItem,
    signal: AbortSignal,
  ): Promise<AuthoringCandidate | null>
  candidate(
    sessionId: string,
    feedback: FeedbackItem,
    files: readonly { path: string; content: string }[],
    signal: AbortSignal,
  ): Promise<AuthoringCandidate>
  evidence(candidateId: string): Promise<AuthoringCandidate>
  now(): string
  id(): string
}

export interface FeedbackInstance extends ServiceInstance {
  execute(input: FeedbackRequest, actor: Actor, signal: AbortSignal): Promise<FeedbackResult>
}

/**
 * Ceiling is the three standard ports. The installed descriptor grants ledger only:
 * feedback does not deliver to the agent, and candidate evidence is not a projection.
 * Workspace scope makes a code change restart-required. Instances are per request.
 */
export const feedbackKind = defineServiceKind<FeedbackInstance, ServicePorts>({
  kind: 'feedback',
  cardinality: 'single',
  instanceScope: 'request',
  scope: 'workspace',
  ports: ['ledger', 'input', 'projections'],
  versioned: true,
})

const feedbackPorts: readonly ServicePortName[] = Object.freeze(['ledger'])

export const FEEDBACK_DESCRIPTOR: ServiceDescriptor = Object.freeze({
  ports: feedbackPorts,
  audience: 'host',
  eventNames: Object.freeze(['item', 'growth']),
})
