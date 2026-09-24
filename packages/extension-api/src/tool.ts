import type { Action, Actor, Decision, JobSpec, JobStatus, JsonValue, Target } from '@agnes/protocol'
import type { Static, TSchema } from '@sinclair/typebox'
import type {
  ArtifactRef,
  Bytes,
  LeaseView,
  Logger,
  PlatformView,
  SandboxEnforcement,
  Seq,
  SessionRef,
} from './common.js'
import type { ProjectionReader } from './projections.js'

export type ReplayPolicy = 'safe' | 'never' | 'idempotent'
export type RiskClass = 'never' | 'destructive' | 'always'

/**
 * The complete safety policy for one validated tool call. This is deliberately limited to
 * call-level safety metadata: Host authority (execution domain/package identity) and transport
 * state are attestations from other layers and must never be minted by an extension classifier.
 */
export interface ResolvedToolCallPolicy {
  readonly isReadOnly: boolean
  readonly isDestructive: boolean
  readonly replay: ReplayPolicy
  readonly requiresApproval: RiskClass
  readonly approvalScopes: readonly string[]
}

export const TOOL_POLICY_VERSION_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
export const APPROVAL_SCOPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
export const RESOLVED_TOOL_CALL_POLICY_KEYS = [
  'isReadOnly',
  'isDestructive',
  'replay',
  'requiresApproval',
  'approvalScopes',
] as const
export const MAX_APPROVAL_SCOPES = 16

// All eight keys must be written out on every tool, including the ones a tool has nothing to
// say about: "no cost hint" is spelled `costHint: undefined`, not an omitted key. That is why
// the last three are required keys typed `T | undefined` rather than optional `?:` members —
// with exactOptionalPropertyTypes on, that is what forces the author to type the word. The
// runtime check in checkToolMeta enforces the same rule for tools that arrive as plain data.
export interface ToolMeta {
  isReadOnly: boolean
  isDestructive: boolean
  isConcurrencySafe: boolean
  isOpenWorld: boolean
  replay: ReplayPolicy
  costHint: { credits?: number; wallMs?: number } | undefined
  deferLoading: boolean | undefined
  requiresApproval: RiskClass | undefined
}
export const TOOL_META_KEYS = [
  'isReadOnly',
  'isDestructive',
  'isConcurrencySafe',
  'isOpenWorld',
  'replay',
  'costHint',
  'deferLoading',
  'requiresApproval',
] as const
export const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

// The author-facing content shape is deliberately not the ledger's tool-result shape; the
// kernel converts between them when it records the call.
export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; ref: ArtifactRef; mime: string }
    | { type: 'ref'; ref: ArtifactRef; mime?: string }
  >
  isError?: boolean
  details?: JsonValue // for the UI and slots only; never enters the model's view
  terminate?: boolean // end the turn after this call
  structured?: unknown // machine-readable payload alongside content; mirrors tool/result.data.structured on the wire
}

export type ExecResult = { code: number; stdout: string; stderr: string; truncated: boolean }
export type FsEntry = { name: string; kind: 'file' | 'dir' | 'symlink' | 'other' }
export type FsStat = { kind: FsEntry['kind']; size: number; mtimeMs: number }
export type FetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string | Bytes
  timeoutMs?: number
}
/** Bounded anonymous retrieval; response resources remain owned by the host. */
export interface PublicFetchResult {
  url: string
  statusCode: number
  contentType: string
  body: { kind: 'html' | 'text'; content: string } | { kind: 'zip'; base64: string }
  truncation: { bytes: boolean; decoded: boolean }
}
export type PublicFetch = (
  url: string,
  options: { signal: AbortSignal; timeoutMs: number; responseType?: 'zip' },
) => Promise<PublicFetchResult>
// Four states, matching the plan register the kernel keeps. A tool whose own surface exposes
// fewer states maps onto these in its implementation.
export type PlanItem = {
  id: string
  text: string
  status: 'todo' | 'doing' | 'done' | 'blocked'
  check?: string
}
export type ChildStatus = {
  childKey: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  text?: string
  credits?: number
  waitTimedOut?: boolean
}

// The programmable-runtime interface a tool can be handed. It lives here, rather than in the
// package that implements it, because this package may only depend on protocol — the runtime
// package re-exports it.
export interface CodeRuntime {
  readonly language: 'python' | 'typescript'
  readonly state: 'persistent' | 'stateless'
  readonly isolation: 'process' | 'worker-thread' | 'container'
  probe(): Promise<{ ok: true; version: string } | { ok: false; reason: string; installHint?: string }>
  start(opts: {
    cwd: string
    env: Record<string, string>
    confine: (argv: string[]) => Promise<string[]>
    signal?: AbortSignal
  }): Promise<void>
  run(req: {
    program: string
    bindings: (frame: unknown) => Promise<unknown>
    signal?: AbortSignal
    limits: { wallMs: number; maxOutputChars: number }
  }): Promise<{
    status: 'ok' | 'error' | 'aborted'
    stdout: string
    stderr: string
    result?: string
    error?: { name: string; message: string; traceback: string[] }
    durationMs: number
    subcalls: number
  }>
  interrupt(): Promise<void>
  snapshot?(): Promise<{ payload: Bytes; saved: string[]; skipped: { name: string; reason: string }[] }>
  restore?(payload: Bytes): Promise<{ restored: string[]; skipped: { name: string; reason: string }[] }>
  listNames?(): Promise<{ name: string; type: string; bytes: number }[]>
  shutdown(opts?: { timeoutMs?: number }): Promise<void>
  kill(): Promise<void>
}

export interface ToolContext {
  /** Active main-conversation request only; Host owns validation and native approval. */
  readonly mcpManage?: Readonly<{ request(input: unknown): Promise<unknown> }>
  readonly pluginManage?: Readonly<{ request(input: unknown): Promise<unknown> }>
  /** Ordinary trusted plugin tools only. Every mutation needs Host-generated user approval. */
  readonly skillInstall?: import('./skill-install.js').SkillInstallPort
  readonly projections: ProjectionReader
  readonly session: SessionRef & {
    readonly toolUseId: string
    readonly depth: number
    readonly generationDepth: number
  }
  readonly actor: Actor // recorded on the call; never the basis for an authorization decision
  readonly cwd: string
  exec(
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number },
  ): Promise<ExecResult>
  readonly fs: {
    read(path: string, opts?: { offset?: number; limit?: number }): Promise<Bytes>
    write(path: string, data: Bytes | string): Promise<void>
    list(path: string): Promise<FsEntry[]>
    stat(path: string): Promise<FsStat>
  }
  readonly net: {
    fetch(url: string, init?: FetchInit): Promise<Response>
    fetchPublic?(url: string, options?: { responseType: 'zip' }): Promise<PublicFetchResult>
  }
  // A tool that spawns its own process passes the launch argv through here first and spawns
  // what comes back. confine is the only sandbox opening a tool may act through; enforcement is a
  // read-only answer to "am I confined right now" (spec 2026-09-15 D4). The host wires both to
  // whichever sandbox implementation the deployment assembled. fsPolicy stays host-internal.
  readonly sandbox: { confine(argv: string[]): Promise<string[]>; enforcement(): SandboxEnforcement }
  // Read-only platform facts plus the capability probe. No manifest gate: facts, not effects.
  readonly platform: PlatformView
  authorize(action: Action, target: Target): Promise<Decision>
  readonly tools: {
    invoke(name: string, args: JsonValue, opts?: { signal?: AbortSignal }): Promise<ToolResult>
    list(): ToolDef[]
  }
  readonly runtime?: CodeRuntime
  readonly artifacts: {
    put(bytes: Bytes, meta?: { mime?: string; name?: string }): Promise<ArtifactRef>
    get(ref: ArtifactRef): Promise<Bytes>
    submitJob(
      spec: Omit<JobSpec, 'sessionKey' | 'schedule'> & { schedule?: JobSpec['schedule'] },
    ): Promise<string>
    poll(id: string): Promise<JobStatus>
    cancel(id: string): Promise<void>
  }
  readonly subagent: {
    fork(question: string, opts?: { model?: string }): Promise<string>
    spawn(
      task: string,
      opts?: {
        model?: string
        isolation?: 'worktree' | 'shared'
        budget?: number
        cwd?: string
        start?: boolean
      },
    ): Promise<{ childKey: string; worktree?: string }>
    collect(childKey: string, opts?: { wait?: boolean }): Promise<ChildStatus>
    cancel(childKey: string): Promise<ChildStatus>
    resume(childKey: string): Promise<{ childKey: string }>
  }
  readonly plan: { set(items: PlanItem[]): Promise<Seq> }
  requestCompaction(instructions?: string): void
  progress(note: string): void
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly lease: LeaseView
  readonly log: Logger
}

export interface ToolDef<P extends TSchema = TSchema> {
  name: string
  description: string
  parameters: P
  meta: ToolMeta
  /**
   * Stable author-supplied classifier version used in the tool-definition fingerprint. Required
   * exactly when classify is present; changing classifier behaviour requires changing this value.
   */
  policyVersion?: string
  /**
   * Pure synchronous mapping from schema-validated arguments to call-level safety policy. The
   * kernel validates the returned value before using it and never accepts Host authority here.
   */
  classify?(args: Readonly<Static<P>>): ResolvedToolCallPolicy
  execute(args: Static<P>, ctx: ToolContext): Promise<ToolResult>
}

export function defineTool<P extends TSchema>(def: ToolDef<P>): ToolDef<P> {
  return def
}

const REPLAY = new Set<string>(['safe', 'never', 'idempotent'])
const RISK = new Set<string>(['never', 'destructive', 'always'])

type CheckResult = { ok: true } | { ok: false; problems: string[] }

function contradictorySafetyFlags(value: Record<string, unknown>, problems: string[]): void {
  if (value.isReadOnly === true && value.isDestructive === true)
    problems.push('isReadOnly/isDestructive: cannot both be true')
}

export function checkToolMeta(meta: unknown): CheckResult {
  if (typeof meta !== 'object' || meta === null) return { ok: false, problems: ['meta: expected object'] }
  const m = meta as Record<string, unknown>
  const problems: string[] = []
  for (const k of TOOL_META_KEYS) if (!Object.hasOwn(m, k)) problems.push(`missing key: ${k}`)
  if (problems.length) return { ok: false, problems }
  for (const k of ['isReadOnly', 'isDestructive', 'isConcurrencySafe', 'isOpenWorld'] as const)
    if (typeof m[k] !== 'boolean') problems.push(`${k}: expected boolean`)
  if (!REPLAY.has(String(m.replay))) problems.push('replay: expected safe | never | idempotent')
  // costHint feeds the budget estimate directly, and this function is the only runtime gate it
  // passes through, so the check is per-key rather than a bare typeof: `[]` and
  // `{ credits: 'lots' }` are both objects. Both keys are optional finite numbers and no other
  // key is allowed — a misspelled `credit` would otherwise be silently estimated as zero.
  const cost: unknown = m.costHint
  if (cost !== undefined) {
    if (typeof cost !== 'object' || cost === null || Array.isArray(cost))
      problems.push('costHint: expected { credits?: number; wallMs?: number } | undefined')
    else {
      for (const k of ['credits', 'wallMs'] as const) {
        const v = (cost as Record<string, unknown>)[k]
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v)))
          problems.push(`costHint.${k}: expected finite number | undefined`)
      }
      const extra = Object.keys(cost).filter((k) => k !== 'credits' && k !== 'wallMs')
      if (extra.length) problems.push(`costHint: unknown key ${extra.join(', ')}`)
    }
  }
  if (m.deferLoading !== undefined && typeof m.deferLoading !== 'boolean')
    problems.push('deferLoading: expected boolean | undefined')
  if (m.requiresApproval !== undefined && !RISK.has(String(m.requiresApproval)))
    problems.push('requiresApproval: expected never | destructive | always | undefined')
  return problems.length ? { ok: false, problems } : { ok: true }
}

/** Runtime validation for classifier output. Core calls this after invoking the classifier. */
export function checkResolvedToolCallPolicy(policy: unknown): CheckResult {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy))
    return { ok: false, problems: ['policy: expected object'] }
  const p = policy as Record<string, unknown>
  const problems: string[] = []
  for (const key of RESOLVED_TOOL_CALL_POLICY_KEYS)
    if (!Object.hasOwn(p, key)) problems.push(`missing key: ${key}`)
  if (typeof p.isReadOnly !== 'boolean') problems.push('isReadOnly: expected boolean')
  if (typeof p.isDestructive !== 'boolean') problems.push('isDestructive: expected boolean')
  contradictorySafetyFlags(p, problems)
  if (!REPLAY.has(String(p.replay))) problems.push('replay: expected safe | never | idempotent')
  if (!RISK.has(String(p.requiresApproval)))
    problems.push('requiresApproval: expected never | destructive | always')
  if (!Array.isArray(p.approvalScopes)) problems.push('approvalScopes: expected array')
  else {
    if (p.approvalScopes.length > MAX_APPROVAL_SCOPES)
      problems.push(`approvalScopes: expected at most ${MAX_APPROVAL_SCOPES} items`)
    const seen = new Set<string>()
    for (const [index, scope] of p.approvalScopes.entries()) {
      if (typeof scope !== 'string' || !APPROVAL_SCOPE_PATTERN.test(scope))
        problems.push(`approvalScopes[${index}]: must be a restricted identifier`)
      else if (seen.has(scope)) problems.push(`approvalScopes[${index}]: duplicate scope ${scope}`)
      else seen.add(scope)
    }
  }
  const known = new Set<string>(RESOLVED_TOOL_CALL_POLICY_KEYS)
  const extra = Object.keys(p).filter((key) => !known.has(key))
  if (extra.length) problems.push(`unknown key: ${extra.join(', ')}`)
  return problems.length ? { ok: false, problems } : { ok: true }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null && 'then' in value) ||
    (typeof value === 'function' && 'then' in value)
  )
}

function isDeclaredAsyncFunction(value: (...args: never[]) => unknown): boolean {
  try {
    return Object.prototype.toString.call(value) === '[object AsyncFunction]'
  } catch {
    // A callable Proxy must not turn registration validation into an exception. Treat an
    // uninspectable classifier as unsafe instead of guessing that it is synchronous.
    return true
  }
}

/**
 * Resolve one already-schema-validated call. Static tools retain their exact historical safety
 * meaning and receive no additional approval scopes. Invalid or asynchronous classifier output is
 * rejected instead of falling back to permissive metadata.
 */
export function resolveToolCallPolicy<P extends TSchema>(
  def: ToolDef<P>,
  args: Readonly<Static<P>>,
): ResolvedToolCallPolicy {
  if (!def.classify)
    return Object.freeze({
      isReadOnly: def.meta.isReadOnly,
      isDestructive: def.meta.isDestructive,
      replay: def.meta.replay,
      requiresApproval: def.meta.requiresApproval ?? (def.meta.isDestructive ? 'destructive' : 'never'),
      approvalScopes: Object.freeze([]),
    })
  const value: unknown = def.classify(args)
  if (isPromiseLike(value)) throw new TypeError('classify: expected synchronous function, received Promise')
  const checked = checkResolvedToolCallPolicy(value)
  if (!checked.ok) throw new TypeError(`classify: invalid resolved policy: ${checked.problems.join('; ')}`)
  const policy = value as ResolvedToolCallPolicy
  return Object.freeze({
    isReadOnly: policy.isReadOnly,
    isDestructive: policy.isDestructive,
    replay: policy.replay,
    requiresApproval: policy.requiresApproval,
    approvalScopes: Object.freeze([...policy.approvalScopes]),
  })
}

// The single definition of a well-formed tool: the kernel's registry and the author-facing
// CLI check both call this, so a tool that passes locally passes at registration.
export function checkToolDef(
  def: unknown,
  opts: { prefix?: string } = {},
): { ok: true } | { ok: false; problems: string[] } {
  if (typeof def !== 'object' || def === null) return { ok: false, problems: ['def: expected object'] }
  const d = def as Record<string, unknown>
  const problems: string[] = []
  if (typeof d.name !== 'string' || !TOOL_NAME_PATTERN.test(d.name))
    problems.push('name: must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$')
  else if (opts.prefix && !d.name.startsWith(opts.prefix))
    problems.push(`name: must start with prefix '${opts.prefix}'`)
  if (typeof d.description !== 'string' || d.description.length === 0)
    problems.push('description: expected non-empty string')
  if (typeof d.parameters !== 'object' || d.parameters === null)
    problems.push('parameters: expected schema object')
  if (typeof d.execute !== 'function') problems.push('execute: expected function')
  const hasClassifier = typeof d.classify === 'function'
  if (d.classify !== undefined && !hasClassifier) problems.push('classify: expected function | undefined')
  if (hasClassifier) {
    if (typeof d.policyVersion !== 'string') problems.push('policyVersion: required when classify is present')
    else if (!TOOL_POLICY_VERSION_PATTERN.test(d.policyVersion))
      problems.push('policyVersion: must be a restricted identifier')
    if (isDeclaredAsyncFunction(d.classify as (...args: never[]) => unknown))
      problems.push('classify: expected synchronous function, received Promise')
  } else if (d.policyVersion !== undefined) {
    problems.push('policyVersion: must be omitted when classify is absent')
  }
  const meta = checkToolMeta(d.meta)
  if (!meta.ok)
    problems.push(
      ...meta.problems.map((p) =>
        p.startsWith('missing key: ') ? `meta.${p.slice('missing key: '.length)}: missing` : `meta.${p}`,
      ),
    )
  return problems.length ? { ok: false, problems } : { ok: true }
}
