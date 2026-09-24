import type { Actor, ApprovalVerdict, Billing, ContentBlock } from '@agnes/protocol'
import type { Seq } from '../types.js'

// The payload shapes of the event types protocol validates by envelope only. They are declared here
// so the reducer and its consumers agree on one reading of each row; the ledger itself still accepts
// any JSON for these types, so a value read out of `data` is a claim, not a guarantee.

export type PlanItem = {
  id: string
  text: string
  status: 'todo' | 'doing' | 'done' | 'blocked'
  check?: string
}
export type PlanItems = { items: PlanItem[]; customInstructions?: string }

export type BudgetState = {
  slot: string
  escalate: boolean
  creditsUsed: number
  creditsCap: number | null
  lastPreflight?: {
    tokens: number
    source: 'count' | 'estimate'
    boundHash?: string
    at?: string
    /**
     * The ledger position this count reflects — `s.lastSeq` at the moment the count was taken, not
     * a value `provider.count()` itself reports. Optional so an older `budget.state` row replayed
     * on resume (written before this field existed) is read as "no anchor," not as a crash.
     */
    seq?: Seq
  }
}

export type ArtifactRef = { sha256: string; size: number; mime: string }
export type ArtifactJob = {
  jobId: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  ref?: ArtifactRef
  error?: string
}

export type InboxItem = {
  itemId: string
  target: 'next-turn' | 'next-step'
  content: ContentBlock[]
  actor: Actor
  commandId?: string
  admissionId?: string
  enqueuedAt: string
  kind?: 'prompt' | 'steer' | 'follow_up'
  // Set by whoever enqueued the item, and defaulting to 'trusted' when absent. The accept path
  // stamps the resulting user/message with it.
  trust?: 'trusted' | 'untrusted'
}
export type Inbox = { items: InboxItem[] }

export type HarnessEntry = {
  kind: 'prompt' | 'memory' | 'skill' | 'subagent'
  id: string
  title: string
  content: string
  scope: 'local' | 'global'
  version: number
  source: string
  reference?: string
  arguments?: unknown
}
/**
 * How a harness entry says it is gone. Its cell is keyed by `kind` / `id` read out of `data`, so the
 * `data: null` tombstone every other register uses cannot name the key it removes.
 */
export type HarnessEntryTombstone = { kind: HarnessEntry['kind']; id: string; tombstone: true }

export type EffectIntent = {
  effectId: string
  parentEffectId?: string
  kind: 'inference' | 'tool' | 'compaction' | 'job' | 'approval-guardian' | 'media'
  tool?: { toolUseId: string; name: string }
  replay: 'safe' | 'never' | 'idempotent'
  argsSeq?: Seq
  slot?: string
}
export type EffectSettled = {
  effectId: string
  outcome: 'ok' | 'error' | 'aborted' | 'unknown'
  durationMs?: number
}

export type ApprovalAsked = {
  requestId: string
  kind: 'tool' | 'budget' | 'unknown-outcome' | 'refine'
  toolUseId?: string
  summary: string
  risk: 'destructive' | 'always' | 'budget' | 'unknown'
  bindingHash: string
  scope?: string
  policyVersion?: string
  profileHash?: string
  options?: Array<'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'>
  deadline?: string
  pending?: { ticket: string; expiresAt: string }
}
export type ApprovalDecided = {
  requestId: string
  verdict: ApprovalVerdict
  via: 'sync' | 'callback' | 'timeout' | 'guardian'
  scope?: string
  grantId?: string
  decidedBy?: Actor
  ticket?: string
}

export type TokenCounts = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
}
export type CostLedger = {
  purpose:
    | 'inference'
    | 'compaction'
    | 'subagent'
    | 'verifier'
    | 'media'
    | 'tool'
    | 'title'
    | 'approval-guardian'
  sourceTurn?: number
  effectId: string
  tokens: TokenCounts
  credits?: number
  creditSource: 'gateway' | 'estimated'
  model: string
  timing?: Record<string, number | string>
  interrupted?: boolean
  adjustment?: { of: Seq; delta: number; usdMicrosDelta?: number; reason: string }
  billing?: Billing
}

export type VerifierSignal = {
  scope: 'tool' | 'step' | 'turn' | 'task'
  tier: 0 | 1 | 2
  verdict: 'pass' | 'fail' | 'needs_revision'
  reasons: string[]
  toolUseId?: string
}
export type RepairDecision = {
  round: number
  decision: 'repair' | 'park' | 'escalate' | 'complete'
  verdictSeq: Seq
}
export type FormatDeviation = { rule: string; model: string; sampleHash: string; parserVersion: string }

export type HarnessEdit =
  | { op: 'upsert'; entry: HarnessEntry }
  | { op: 'delete'; kind: HarnessEntry['kind']; id: string }
export type HarnessRefine = {
  proposalId: string
  trigger: 'auto' | 'manual' | 'rollback' | 'compact'
  outcome: 'applied' | 'rejected:conflict' | 'rejected:limit' | 'rejected:evidence' | 'rejected:prefix'
  edits: HarnessEdit[]
  baseline: { key: string; version: number }[]
  rollbackOf?: Seq
  rationale: string
}

export type Participant = { action: 'join' | 'leave'; participant: Actor }
export type FeedbackRating = { targetSeq: Seq; rating: 'up' | 'down'; note?: string }
export type FeedbackImplicit = {
  kind: 'regenerate' | 'edit-resend' | 'reaction'
  targetSeq: Seq
  detail?: unknown
}
