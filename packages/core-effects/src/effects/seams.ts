import type { Seq } from '@agnes/core-common/types'
import type { HarnessEdit } from '@agnes/core-ledger/reduce/shapes'
import type {
  ApprovalGrantQuery,
  ApprovalSeam,
  ArtifactsSeam,
  BillingSeam,
  CheckpointSeam,
  PrincipalsSeam,
  RepairSeam,
  VerifierSeam,
} from '@agnes/extension-api/seams'
import type { ApprovalGrant, ApprovalMode } from '@agnes/protocol'
import type { WorkspaceInvocationPort } from '../workspace/runtime.js'
import type { FsPolicy } from './fs-guard.js'

// The ten necessary parts a deployment fits, exactly one implementation each, assembled before the
// session opens. The kernel calls into them; they never call back in and never self-register, which
// is what separates a seam from an extension.

export type {
  ApprovalAnswer,
  ApprovalGrantQuery,
  ApprovalReason,
  ApprovalRequest,
  ApprovalSeam,
  Pending,
  Verdict,
} from '@agnes/extension-api/seams'

/**
 * Permanent approvals the Host stores. They are bound to the approver and the tool definition when
 * written; storage, listing and revocation live in the Host, not in the selected approval provider.
 */
export interface ApprovalGrantsPort {
  list(query: ApprovalGrantQuery): Promise<ApprovalGrant[]>
  put(grant: ApprovalGrant): Promise<void>
}

export type ResolvedApprovalMode = ApprovalMode

export type {
  BillingRow,
  BillingSeam,
  CheckpointSeam,
  CheckpointWorkspaceBinding,
  CheckpointWorkspaceFs,
} from '@agnes/extension-api/seams'
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
  /** Workspace invocation owner. Legacy fitting fields remain during the Host/Base migration only. */
  readonly invocation?: WorkspaceInvocationPort
  readonly policy: FsPolicy
  readonly readiness: SandboxReadinessCapability
  readonly signal?: AbortSignal
  readonly shell: 'posix' | 'powershell'
  readonly shellCommand?: (command: string) => string[]
  readonly execBackend: SandboxExecBackend
  readonly enforcement: Enforcement
  /** Provider-owned private files require isolation; explicit full-access only prefers it (Host decides). */
  readonly requiredFileIsolation?: boolean
  /**
   * Startup-selected sandbox provider. Absent or `local` keeps the host OS
   * confine. Any other id skips that confine and is copied onto the exec binding.
   */
  readonly providerId?: string
  readonly exec: (
    argv: string[],
    opts: {
      cwd: string
      env?: Record<string, string>
      stdin?: string
      bridge?: (frame: unknown) => Promise<unknown>
      timeoutMs?: number
      signal?: AbortSignal
      maxOutputBytes?: number
      sandbox: Readonly<{
        policyDigest: string
        backend: SandboxExecBackend
        provider?: string
        policy?: import('@agnes/extension-api').SandboxExecutionPolicy
        enforcement?: import('@agnes/extension-api').SandboxEnforcement
      }>
    },
  ) => Promise<import('@agnes/extension-api').ExecResult>
  readonly openProcess?: (
    argv: string[],
    opts: Parameters<SeamWorkspace['exec']>[1] & {
      pty?: NonNullable<import('@agnes/extension-api').SandboxProcessRequest['pty']>
    },
  ) => Promise<import('@agnes/extension-api').SandboxProcess>
  readonly binding: () => Readonly<{ policyDigest: string | null }>
}

/** The Host-built shell around the selected `sandbox` provider; not an author contract. */
export interface SandboxSeam {
  openProcess?: NonNullable<import('@agnes/extension-api').ToolContext['sandbox']['openProcess']>
  /** Fit this shell to one Host-authorized workspace. */
  forWorkspace(workspace: SeamWorkspace): Promise<SandboxSeam>
  exec(
    cmd: string[],
    opts: {
      cwd: string
      env?: Record<string, string>
      stdin?: string
      bridge?: (frame: unknown) => Promise<unknown>
      timeoutMs?: number
      signal?: AbortSignal
      maxOutputBytes?: number
    },
  ): Promise<import('@agnes/extension-api').ExecResult>
  // Wraps one argv into a confined argv. `exec` uses it internally, and it is the same opening a
  // tool that spawns its own process reaches through ToolContext.sandbox.
  confine(argv: string[]): Promise<string[]>
  // The full file policy: every rule with its canonical absolute path, the allow roots, the hard
  // denies, and the digest the host pinned when it bound this policy to its FsOps. A session open
  // refuses a seam whose answer stops agreeing with what was bound.
  fsPolicy(): FsPolicy
  enforcement(): Enforcement
}

export type {
  ArtifactsSeam,
  Decision,
  JobSchedule,
  JobSpec,
  PrincipalsSeam,
  RepairSeam,
  Target,
  VerifierSeam,
  VerifierVerdict,
} from '@agnes/extension-api/seams'

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
  billing: BillingSeam
  sandbox: SandboxSeam
  verifier: VerifierSeam
  repair: RepairSeam
  artifacts: ArtifactsSeam
  principals: PrincipalsSeam
  platform: PlatformSeam
}
/**
 * The seam names as data, for the assembly that reports which are fitted and the fail-closed check
 * that refuses to open a session without one. `satisfies` pins every entry to a real seam; a test
 * pins the other direction, that no seam is missing from the list.
 */
export const SEAM_NAMES = [
  'approval',
  'checkpoint',
  'billing',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'platform',
] as const satisfies readonly (keyof SeamImplementations)[]
export type SeamName = (typeof SEAM_NAMES)[number]
// A test harness fits everything but billing, which would otherwise bill a test run.
export type TestSeams = Omit<SeamImplementations, 'billing'>
