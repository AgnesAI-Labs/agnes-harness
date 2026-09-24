import type { FsEntry, FsStat, ToolMeta } from '@agnes/extension-api'
import type { Actor, ApprovalGrant, ApprovalMode, ApprovalVerdict } from '@agnes/protocol'
// ArtifactRef is defined once, in reduce/shapes.ts, and is used here without re-exporting it: two
// star-export sources for one name make the package's root surface ambiguous about which it means.
import type { ArtifactJob, ArtifactRef, CostLedger, HarnessEdit, RepairDecision } from '../reduce/shapes.js'
import type { Seq } from '../types.js'
import type { WorkspaceInvocationPort } from '../workspace/runtime.js'
import type { FsPolicy } from './fs-guard.js'

// The ten necessary parts a deployment fits, exactly one implementation each, assembled before the
// session opens. The kernel calls into them; they never call back in and never self-register, which
// is what separates a seam from an extension.

export type Verdict = ApprovalVerdict
export type Pending = { ticket: string; expiresAt: string }
export type ApprovalRequest = {
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
  options?: Array<'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'>
  context?: string
}
export type ApprovalGuardianDecision = {
  decision: 'allow-once' | 'allow-session' | 'escalate' | 'reject'
  ruleVersion: string
  reasons: string[]
  model?: string
}
export type ApprovalGrantQuery = {
  profileHash: string
  actorId: string
  actorOrg: string
  toolId: string
  scope: string
  policyVersion: string
}
/** Host-authorized workspace identity used to fit an approval policy for one session. */
export type ApprovalWorkspaceBinding = Readonly<{ root: string }>
export interface ApprovalSeam {
  /** Dynamic seams fit the shared implementation to the session before it enters an invocation. */
  forWorkspace?(workspace: ApprovalWorkspaceBinding): ApprovalSeam | Promise<ApprovalSeam>
  ask(req: ApprovalRequest): Promise<Verdict | Pending>
  resume(
    ticket: string,
    verdict: Verdict,
  ): Promise<{ requestId: string; bindingHash: string; expiresAt: string } | null>
  /** Optional during migration: smart mode escalates and permanent grants fail closed when absent. */
  guard?(req: ApprovalRequest): Promise<ApprovalGuardianDecision>
  listGrants?(query: ApprovalGrantQuery): Promise<ApprovalGrant[]>
  putGrant?(grant: ApprovalGrant): Promise<void>
  revokeGrant?(grantId: string, revokedAt: string): Promise<ApprovalGrant | null>
  onGrantRevoked?(listener: (grantId: string) => void): () => void
}

export type ResolvedApprovalMode = ApprovalMode

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

export type LedgerRow = CostLedger & { sessionKey: string; lane: string; turn: number; step: number }
export interface LedgerSeam {
  record(row: LedgerRow): Promise<void>
  projected(next: {
    tokensEstimate: number
    model: string
  }): Promise<{ credits: number; creditSource: 'gateway' | 'estimated' }>
}

export type Enforcement = { level: 'full' | 'partial' | 'none'; scope: ('file' | 'network' | 'process')[] }

/** Opaque process boundary selected and cached by Host for one canonical workspace. */
export interface SandboxWorkspaceBackend {
  confine(
    request: Readonly<{ argv: readonly string[]; cwd: string }>,
  ): readonly string[] | Promise<readonly string[]>
}

/** Root-bound readiness. Callers cannot resubmit a root, backend id, policy, cache key or probe. */
export interface SandboxReadinessCapability {
  ready(signal?: AbortSignal): Promise<SandboxWorkspaceBackend>
}

export type SandboxExecBackend = 'none' | 'l1' | 'remote'

/**
 * Host-owned, already-authorized inputs for fitting a sandbox seam to one session workspace.
 * Base consumes this object; it neither compiles policy nor receives the raw probe capability.
 */
export interface SeamWorkspace {
  readonly root: string
  /** Task 6 invocation owner. Legacy fitting fields remain during the Host/Base migration only. */
  readonly invocation?: WorkspaceInvocationPort
  readonly policy: FsPolicy
  readonly readiness: SandboxReadinessCapability
  readonly signal?: AbortSignal
  readonly shell: 'posix' | 'powershell'
  readonly shellCommand?: (command: string) => string[]
  readonly execBackend: SandboxExecBackend
  readonly enforcement: Enforcement
  readonly exec: (
    argv: string[],
    opts: {
      cwd: string
      env?: Record<string, string>
      stdin?: string
      timeoutMs?: number
      signal?: AbortSignal
      maxOutputBytes?: number
      sandbox: Readonly<{ policyDigest: string; backend: SandboxExecBackend }>
    },
  ) => Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>
  readonly binding: () => Readonly<{ policyDigest: string | null }>
}

export interface SandboxSeam {
  /** Fit this package-level seam factory to one Host-authorized workspace. */
  forWorkspace(workspace: SeamWorkspace): Promise<SandboxSeam>
  exec(
    cmd: string[],
    opts: {
      cwd: string
      env?: Record<string, string>
      stdin?: string
      timeoutMs?: number
      signal?: AbortSignal
      maxOutputBytes?: number
    },
  ): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>
  // Wraps one argv into a confined argv. `exec` uses it internally, and it is the same opening a
  // tool that spawns its own process reaches through ToolContext.sandbox.
  confine(argv: string[]): Promise<string[]>
  // The full file policy: every rule with its canonical absolute path, the allow roots, the hard
  // denies, and the digest the host pinned when it bound this policy to its FsOps. A session open
  // refuses a seam whose answer stops agreeing with what was bound.
  fsPolicy(): FsPolicy
  enforcement(): Enforcement
}

export type VerifierVerdict = { verdict: 'pass' | 'fail' | 'needs_revision'; reasons: string[] }
export interface VerifierSeam {
  verify(
    scope: 'tool' | 'step' | 'turn' | 'task',
    input: unknown,
    opts: { tier: 0 | 1 | 2; budget?: number; signal: AbortSignal },
  ): Promise<VerifierVerdict>
}

export interface RepairSeam {
  decide(
    view: { turn: number; round: number; history: RepairDecision[] },
    verdict: VerifierVerdict,
  ): Promise<'repair' | 'park' | 'escalate' | 'complete'>
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

export interface PlatformSeam {
  shell(): 'posix' | 'powershell'
  fs(): { caseSensitive: boolean; pathSep: string }
  terminal(): { color: boolean; width?: number }
  capability(id: string): { level: 'full' | 'partial' | 'unavailable'; scope: string[]; reason?: string }
}

export type RefineProposal = {
  proposalId: string
  // 'rollback' is a proposal `rollbackRefine` (refine/apply.ts) builds itself to invert an earlier
  // applied refine; it is not a trigger the Harness seam's own callers pick.
  trigger: 'auto' | 'manual' | 'compact' | 'rollback'
  edits: HarnessEdit[]
  baseline: { key: string; version: number }[]
  rationale: string
  evidenceSeqs: Seq[]
  // Set only on a `trigger: 'rollback'` proposal: the seq of the `harness/refine` event being undone.
  rollbackOf?: Seq
}
export interface HarnessSeam {
  propose(p: RefineProposal): Promise<'queued' | 'rejected'>
}

export type SeamImplementations = {
  approval: ApprovalSeam
  checkpoint: CheckpointSeam
  ledger: LedgerSeam
  sandbox: SandboxSeam
  verifier: VerifierSeam
  repair: RepairSeam
  artifacts: ArtifactsSeam
  principals: PrincipalsSeam
  platform: PlatformSeam
  harness: HarnessSeam
}
/**
 * The seam names as data, for the assembly that reports which are fitted and the fail-closed check
 * that refuses to open a session without one. `satisfies` pins every entry to a real seam; a test
 * pins the other direction, that no seam is missing from the list.
 */
export const SEAM_NAMES = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'platform',
  'harness',
] as const satisfies readonly (keyof SeamImplementations)[]
export type SeamName = (typeof SEAM_NAMES)[number]
// A test harness fits everything but the ledger, which would otherwise bill a test run.
export type TestSeams = Omit<SeamImplementations, 'ledger'>
