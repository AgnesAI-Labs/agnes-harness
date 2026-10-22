import type { Actor, ApprovalReason, ApprovalVerdict, ArtifactRef, Billing } from '@agnes/protocol'
import type { AttachmentStore } from './attachments.js'
import type { Logger, Seq } from './common.js'
import type { DecisionHandle } from './decisions.js'
import type { PersistenceMetadataNamespace } from './persistence.js'
import { defineKind, type ProviderIdentity } from './provider-kind.js'
import type { FsEntry, FsStat, ToolMeta } from './tool.js'
import type { ApprovalConstraints } from './tool-policy.js'

// The contracts of the runtime capabilities the kernel consumes as one typed object each. A seam
// provider registers like any other provider: `ctx.providers.register(checkpointKind, provider)`.

export type Verdict = ApprovalVerdict
export type Pending = { ticket: string; expiresAt: string }
export type { ApprovalReason }
/** answeredBy is supplied by the trusted connection/source adapter, separately from the requester. */
export type ApprovalAnswer = { verdict: Verdict; reason?: ApprovalReason; answeredBy?: Actor }
export type ApprovalRequest = {
  /** Present only for Core's already-persisted human gate; this is delivery metadata, not authority. */
  decision?: { handle: DecisionHandle; revision: number }
  /** Backend-only routing of a child's canonical human gate to its owning session surface. */
  delegation?: { role: string; childSessionKey: string; parentSessionKey: string; reason: string }
  requestId: string
  kind: 'tool' | 'budget' | 'unknown-outcome' | 'refine'
  sessionKey: string
  stepId: string
  toolUseId?: string
  tool?: { name: string; args: unknown; meta: ToolMeta }
  summary: string
  risk: 'destructive' | 'always' | 'budget' | 'unknown'
  actor: Actor
  taint: boolean
  bindingHash: string
  deadline: string
  scope: string
  profileHash?: string | null
  policyVersion?: string
  policyBinding?: string
  options?: Array<'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'>
  /** Core's offer of a command-prefix grant: shown by clients, never derived by them. */
  prefixGrant?: { tokens: string[]; scope: string }
  context?: string
  approval?: ApprovalConstraints
}
export type ApprovalGrantQuery = {
  policyDigest: string
  actorId: string
  actorOrg: string
  toolId: string
  scope: string
  policyVersion: string
}
/** How a question reaches a person and the answer comes back. Who may answer and what is durable is Core's. */
export interface ApprovalSeam {
  ask(req: ApprovalRequest, opts?: { signal: AbortSignal }): Promise<Verdict | ApprovalAnswer | Pending>
}

/** The richer fenced filesystem checkpoint needs; it remains inside the Host-owned runtime. */
export type CheckpointWorkspaceFs = Readonly<{
  realpath(path: string): Promise<string>
  read(path: string, opts?: { offset?: number; limit?: number }): Promise<Uint8Array>
  write(path: string, data: Uint8Array): Promise<void>
  stat(path: string): Promise<FsStat>
  list(path: string): Promise<FsEntry[]>
  mkdir(path: string): Promise<void>
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>
}>
export type CheckpointWorkspaceBinding = Readonly<{ root: string; fs: CheckpointWorkspaceFs }>
export interface CheckpointSeam {
  /** Dynamic seams fit storage and filesystem state to the session before invocation. */
  forWorkspace?(workspace: CheckpointWorkspaceBinding): CheckpointSeam | Promise<CheckpointSeam>
  snapshot(paths: string[], stepId: string): Promise<{ id: string }>
  rewind(id: string): Promise<void>
  list(): Promise<Array<{ id: string; stepId: string }>>
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
    | 'side-call'
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
  /** Route the call went to, when the row is for a side call. */
  route?: string
  /** Identity of the model adapter behind the route, when the provider publishes one. */
  adapter?: { id: string; version?: string }
  /** Host of the endpoint the call was sent to, as `URL.host` gives it: the name, and the port when the URL has one. */
  endpointHost?: string
}
export type BillingRow = CostLedger & { sessionKey: string; lane: string; turn: number; step: number }
export interface BillingSeam {
  record(row: BillingRow): Promise<void>
  projected(next: {
    tokensEstimate: number
    model: string
  }): Promise<{ credits: number; creditSource: 'gateway' | 'estimated' }>
}

export type VerifierVerdict = { verdict: 'pass' | 'fail' | 'needs_revision'; reasons: string[] }
export interface VerifierSeam {
  verify(
    scope: 'tool' | 'step' | 'turn' | 'task',
    input: unknown,
    opts: { tier: 0 | 1 | 2; budget?: number; signal: AbortSignal },
  ): Promise<VerifierVerdict>
}

export type RepairDecision = {
  round: number
  decision: 'repair' | 'park' | 'escalate' | 'complete'
  verdictSeq: Seq
}
export interface RepairSeam {
  decide(
    view: { turn: number; round: number; history: RepairDecision[] },
    verdict: VerifierVerdict,
  ): Promise<'repair' | 'park' | 'escalate' | 'complete'>
}

export type ArtifactJob = {
  jobId: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  ref?: ArtifactRef
  error?: string
}
export type JobSchedule =
  | { kind: 'once' }
  | { kind: 'at'; at: number }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string; staggerMs?: number }
export type JobSpec = {
  idempotencyKey: string
  sessionKey: string
  payload: unknown
  schedule?: JobSchedule
  maxAttempts?: number
  budget?: number
  protected?: boolean
}
export interface ArtifactsSeam {
  /** Absent providers retain inline input compatibility; supplied references fail closed. */
  readonly attachments?: AttachmentStore
  put(bytes: Uint8Array, meta?: { mime?: string; name?: string }): Promise<ArtifactRef>
  get(ref: ArtifactRef): Promise<Uint8Array>
  // The session key is filled in by the kernel, so a caller cannot submit work against a session
  // that is not its own; the implementation and the jobs table see a complete spec.
  submitJob(spec: Omit<JobSpec, 'sessionKey'>): Promise<string>
  poll(jobId: string): Promise<ArtifactJob>
  cancel(jobId: string): Promise<void>
}

export type Target = {
  kind: 'datasource' | 'db' | 'table' | 'field' | 'model' | 'skill' | 'mcp' | 'kb' | 'menu' | 'button'
  id: string
  parent?: string
}
export type Decision = {
  decisionId: string
  effect: 'allow' | 'deny' | 'require_approval'
  rowFilter?: string
  fieldMask?: { visible: string[]; masked: string[] }
  limits?: { maxRows?: number; exportRequiresGrant?: boolean }
  reason: string
}
export interface PrincipalsSeam {
  resolve(cred: unknown, surface: string): Promise<Actor>
  authorize(actor: Actor, action: string, target: Target): Promise<Decision>
}

/**
 * One table connection's worth of SQL. `name` is the table the handle was asked for; it is
 * advisory, because the statement text names its own table and the underlying connection carries
 * every table the same owner created.
 */
export type SeamTableHandle = {
  name: string
  exec(sql: string): void
  run(sql: string, params?: readonly unknown[]): { changes: number }
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined
  transaction<T>(fn: () => T): T
}

/** The file methods, each fenced by whoever built the handle. */
export type SeamFs = {
  realpath(p: string): Promise<string>
  read(p: string, opts?: { unit?: 'lines' | 'bytes'; offset?: number; limit?: number }): Promise<Uint8Array>
  write(p: string, data: Uint8Array): Promise<void>
  stat(p: string): Promise<FsStat>
  list(p: string): Promise<FsEntry[]>
  mkdir(p: string): Promise<void>
  rm(p: string, opts?: { recursive?: boolean }): Promise<void>
}

export type SeamExecResult = {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  signal?: string
}
export type SeamExec = (
  argv: string[],
  opts: {
    cwd: string
    env?: Record<string, string>
    stdin?: string
    timeoutMs?: number
    signal?: AbortSignal
    maxOutputBytes?: number
    sandbox?: { policyDigest: string; backend: 'none' | 'l1' }
  },
) => Promise<SeamExecResult>

/** The way to put a question to whoever is connected. The deadline travels on the signal. */
export type SeamPrompter = {
  ask(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<Verdict | ApprovalAnswer>
}

/** The platform questions a seam may ask; it learns nothing else about the host. */
export type SeamPlatformView = {
  shell(): 'posix' | 'powershell'
  fs(): { caseSensitive: boolean; pathSep: string }
  terminal(): { color: boolean; width?: number }
  capability(id: string): { level: 'full' | 'partial' | 'unavailable'; scope: string[]; reason?: string }
}

/**
 * `fs` is the workspace and refuses everything outside workspaceRoot. `dataFs` is this
 * installation's own store under dataDir, unreachable through `fs`.
 */
export type SeamAdaptersView = {
  fs: SeamFs
  dataFs: SeamFs
  exec: SeamExec
  platform: SeamPlatformView
  storage: {
    table(name: string): SeamTableHandle
    namespace(name: string): PersistenceMetadataNamespace
  }
  prompter?: SeamPrompter
}

export type SeamProfileView = {
  name: string
  resolvedProfileHash: string | null
  dataDir: string
  workspaceRoot: string
  homeDir: string
  limits: Record<string, number>
  preset: Record<string, unknown>
}

/** What `create` is handed. Bundled packages may receive a wider, privileged view. */
export type SeamInit = {
  secrets(ref: string): string
  adapters: SeamAdaptersView
  profile: SeamProfileView
  log: Logger
  signal: AbortSignal
  /** Host startup bound for `create`. */
  seamTimeoutMs?: number
}

/**
 * The instance may carry a `close()`, called when its container is torn down. The Host races
 * `create` with a timer; an instance that arrives late is closed at once.
 */
export interface SeamProvider<T extends object> extends ProviderIdentity {
  create(init: SeamInit, signal: AbortSignal): T | Promise<T>
}

export type ApprovalProvider = SeamProvider<ApprovalSeam>
export type PrincipalsProvider = SeamProvider<PrincipalsSeam>
export type BillingProvider = SeamProvider<BillingSeam>
export type CheckpointProvider = SeamProvider<CheckpointSeam>
export type ArtifactsProvider = SeamProvider<ArtifactsSeam>
export type VerifierProvider = SeamProvider<VerifierSeam>
export type RepairProvider = SeamProvider<RepairSeam>

/** The seam kinds in their fixed order; the Host owns a binding row for each. */
export const SEAM_KINDS = [
  'approval',
  'principals',
  'billing',
  'checkpoint',
  'artifacts',
  'verifier',
  'repair',
] as const
export type SeamKind = (typeof SEAM_KINDS)[number]
/** Kinds whose selection is recorded per session and replaced only by an explicit repin. */
export const PINNED_SEAM_KINDS = ['approval', 'principals', 'billing', 'checkpoint', 'artifacts'] as const

function seamKind<T extends object>(kind: SeamKind) {
  return defineKind<SeamProvider<T>>({
    kind,
    required: true,
    pinned: (PINNED_SEAM_KINDS as readonly string[]).includes(kind),
    validate(provider) {
      if (typeof provider.create !== 'function')
        throw new Error(`invalid ${kind} provider: create() is required`)
    },
  })
}
export const approvalKind = seamKind<ApprovalSeam>('approval')
export const principalsKind = seamKind<PrincipalsSeam>('principals')
export const billingKind = seamKind<BillingSeam>('billing')
export const checkpointKind = seamKind<CheckpointSeam>('checkpoint')
export const artifactsKind = seamKind<ArtifactsSeam>('artifacts')
export const verifierKind = seamKind<VerifierSeam>('verifier')
export const repairKind = seamKind<RepairSeam>('repair')
/** The token each seam kind is installed and registered under. */
export const SEAM_KIND_TOKENS = {
  approval: approvalKind,
  principals: principalsKind,
  billing: billingKind,
  checkpoint: checkpointKind,
  artifacts: artifactsKind,
  verifier: verifierKind,
  repair: repairKind,
} as const
