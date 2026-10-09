import type { Actor, AuthoringCandidate, EventEnvelope } from '@agnes/protocol'
import type { AdminFeedbackParams, AdminFeedbackResult, FeedbackItem } from '@agnes/protocol/gen/app-server'

export type { FeedbackGrowth, FeedbackItem, FeedbackTarget } from '@agnes/protocol/gen/app-server'
export type FeedbackRequest = Readonly<AdminFeedbackParams>
export type FeedbackResult = Readonly<AdminFeedbackResult>
export const FEEDBACK_EVENT = 'x/feedback/item'
export const FEEDBACK_GROWTH_EVENT = 'x/feedback/growth'

/** Replaceable local service. Authority and ledger writing remain owned by the platform. */
export interface FeedbackService {
  execute(input: FeedbackRequest, actor: Actor, signal: AbortSignal): Promise<FeedbackResult>
}
/** Explicit generation may use only local inference; feedback is never telemetry or model history. */
export interface FeedbackPorts {
  sessions(): Promise<{ ids: readonly string[]; truncated: boolean }>
  scan(sessionId: string, types: readonly string[]): Promise<readonly EventEnvelope[]>
  append(sessionId: string, type: string, data: Record<string, unknown>, actor: Actor): Promise<number>
  draft(
    sessionId: string,
    feedback: FeedbackItem,
    evidence: readonly EventEnvelope[],
    signal: AbortSignal,
  ): Promise<readonly { path: string; content: string }[]>
  /** Recover the stable, integrity-checked growth binding before invoking non-deterministic draft inference. */
  recoverCandidate(sessionId: string, feedback: FeedbackItem, signal: AbortSignal): Promise<AuthoringCandidate | null>
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
export type FeedbackServiceFactory = (ports: FeedbackPorts) => FeedbackService
