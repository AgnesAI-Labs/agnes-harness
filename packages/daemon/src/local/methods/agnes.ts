import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  ActivationInProgressError,
  type QueuedActivationInvocation,
  SCAN_PAGE_MAX,
  type ScanRead,
  scanPages,
} from '@agnes/host'
import {
  type Ack,
  type Actor,
  type ComputerUseDoctorParams,
  type ComputerUseDoctorResult,
  type ComputerUseOperationResult,
  type ComputerUsePermissionsStatusResult,
  type ComputerUseStatusResult,
  type CostLedger,
  type EventEnvelope,
  type ExtUiResponseParams,
  type ParticipantListResult,
  type ParticipantParams,
  rpcError,
  type SessionProjectUIHistoryParams,
  type SessionProjectUIOpeningParams,
  type SessionProjectUIParams,
  type SessionProjectUIPatchParams,
  type ThinkingLevel,
  UI_HISTORY_DEFAULT_LIMIT,
  UI_HISTORY_MAX_LIMIT,
  UI_OPENING_DEFAULT_MAX_NODES,
  UI_OPENING_MAX_NODES,
  UI_PROJECTION_DEFAULT_MAX_BYTES,
  UI_PROJECTION_MAX_BYTES,
  UI_PROJECTION_MIN_MAX_BYTES,
  UI_PROJECTION_RESYNC_REQUIRED,
  type UINode,
  type UIProjectionNodeChange,
  type UIProjectionUpdate,
  type UITimeline,
  type UITimelinePatch,
  type UITurn,
} from '@agnes/protocol'
import type { TicketPort } from '../../storage/lister.js'
import type { WorkspaceBindingEnvelope } from '../../storage/workspaces.js'
import { AttachedFeed, type Limits } from '../attached.js'
import { commandAdmissionId, commandBinding } from '../command-binding.js'
import { runQueued } from '../command-queue.js'
import { createBlockedComputerUseControlPlane } from '../computer-use-control.js'
import { type CallContext, connActor, type LocalEndpoint } from '../endpoint.js'
import type {
  ClaimStore,
  CommandJournal,
  CompactOutcome,
  DirectoryPort,
  JobsPort,
  JournalResult,
  SessionLister,
} from '../ports.js'
import type { Feed, LocalContext } from './acp.js'

export type AuthKind = 'local' | 'jwt' | 'source-auth' | 'portal-identity' | 'surface'
export type CredentialKind = 'local' | 'jwt' | 'portal-identity' | 'sso' | 'channel'

export type AgnesContext = LocalContext & {
  configuration?: boolean
  profileHashForSession?: (key: string) => Promise<string | null>
  limits: Limits
  journal: CommandJournal
  claims: ClaimStore
  jobs?: JobsPort
  directory?: DirectoryPort
  lister?: SessionLister
  authKind: AuthKind
  credentialKind: CredentialKind
  artifactRead?: boolean
  /** Host-owned, read-only locked-package mutation readiness. Absence is reported as unknown. */
  lockedPackageMutations?: Readonly<{ status(): unknown }>
  /** Present only when Host completed platform-scoped production admission. */
  computerUse?: Readonly<{
    status(): unknown
    doctor?(params: ComputerUseDoctorParams): Promise<unknown>
    operationStart?(kind: 'install' | 'update' | 'restart'): unknown
    operationStatus?(operationId?: string): unknown
    operationCancel?(operationId: string): unknown
    setSessionYolo(session: Readonly<{ key: string; lane: string }>, enabled: boolean): Promise<void>
  }>
  forkSession: (
    sessionId: string,
    at: number,
    childKey?: string,
    credential?: unknown,
    principalId?: string,
  ) => Promise<JournalResult>
  /** Host's principals seam resolver. Optional for supervisor/transport adapters that do not fit
   * participant or approval identity support. */
  resolveActor?: (credential: unknown, surface: 'session' | 'approval', sessionId?: string) => Promise<Actor>
  /** Persistent in production, memory-backed in the embedded endpoint. A supervisor that has not
   * fitted the port keeps the bounded open-registry fallback below. */
  tickets?: TicketPort
}

export type Family = { name: string; methods: string[]; guidance: string }

/** Fold only a structurally usable parked approval into the package-owned lookup. `expiresAt` is a
 * protocol string rather than a date-time today, so an invalid value is deliberately not indexed:
 * persisting it as NaN/null would turn the index into an immortal or immediately-expired lie. */
export function indexApprovalTicket(
  tickets: TicketPort,
  sessionKey: string,
  event: EventEnvelope,
  cwd?: string,
): boolean {
  if (event.type !== 'approval/asked') return false
  const pending = (event.data as { pending?: { ticket?: unknown; expiresAt?: unknown } } | null)?.pending
  if (typeof pending?.ticket !== 'string' || typeof pending.expiresAt !== 'string') return false
  const expiresAt = Date.parse(pending.expiresAt)
  if (!Number.isFinite(expiresAt)) return false
  tickets.put(pending.ticket, sessionKey, expiresAt, cwd)
  return true
}

type ScannableSession = {
  scan(q: {
    type: string
    order: 'asc' | 'desc'
    limit: number
    toSeq?: number
    fromSeq?: number
  }): Promise<Array<{ seq: number; ts: string; type: string; data: unknown; actor: { id: string } }>>
}

type ScannedEvent = Awaited<ReturnType<ScannableSession['scan']>>[number]

const MAX_UI_PROJECTION_BASELINES_PER_CONNECTION = 32
const sessionMutationTails = new WeakMap<object, Map<string, Promise<void>>>()
type ProjectionBaseline = Pick<UITimeline, 'sessionId' | 'generation' | 'upto'> & {
  mode: 'full' | 'windowed'
}
const uiProjectionBaselines = new WeakMap<object, Map<string, ProjectionBaseline>>()
// Once a connection has opted into a bounded opening it must never receive an implicit full
// replacement merely because its per-session baseline aged out of the bounded LRU. The marker is
// connection-scoped and weak, so it has fixed memory and disappears with the connection. A missing
// baseline then conservatively asks the client to reopen; an extant full baseline remains usable.
const windowedProjectionConnections = new WeakSet<object>()

const uiProjectionKey = (sessionId: string, surface?: string): string =>
  JSON.stringify([sessionId, surface ?? null])

function projectionBaselinesFor(connection: object): Map<string, ProjectionBaseline> {
  let baselines = uiProjectionBaselines.get(connection)
  if (!baselines) {
    baselines = new Map()
    uiProjectionBaselines.set(connection, baselines)
  }
  return baselines
}

function rememberProjection(
  connection: object,
  key: string,
  timeline: Pick<UITimeline, 'sessionId' | 'generation' | 'upto'>,
  mode: ProjectionBaseline['mode'] = 'full',
): void {
  const baselines = projectionBaselinesFor(connection)
  // Map insertion order is the LRU queue. A connection may inspect arbitrary session ids, so the
  // weak outer key alone is insufficient. Only watermarks are retained now; Core owns the nodes.
  baselines.delete(key)
  baselines.set(key, {
    sessionId: timeline.sessionId,
    generation: timeline.generation,
    upto: timeline.upto,
    mode,
  })
  while (baselines.size > MAX_UI_PROJECTION_BASELINES_PER_CONNECTION) {
    const oldest = baselines.keys().next().value
    if (oldest === undefined) break
    baselines.delete(oldest)
  }
}

const UI_HISTORY_CURSOR_SECRET = randomBytes(32)
type UIHistoryCursorPayload = {
  sessionId: string
  generation: number
  surface: 'tui' | 'web' | 'channel' | null
  cut: number
  beforeIndex: number
  totalNodes: number
}

function encodeUIHistoryCursor(payload: UIHistoryCursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', UI_HISTORY_CURSOR_SECRET).update(`v1.${body}`).digest('base64url')
  return `v1.${body}.${signature}`
}

function decodeUIHistoryCursor(cursor: string): UIHistoryCursorPayload | null {
  if (cursor.length < 1 || cursor.length > 2048) return null
  const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(cursor)
  if (!match?.[1] || !match[2]) return null
  const expected = createHmac('sha256', UI_HISTORY_CURSOR_SECRET).update(`v1.${match[1]}`).digest()
  let given: Buffer
  try {
    given = Buffer.from(match[2], 'base64url')
    if (given.toString('base64url') !== match[2]) return null
  } catch {
    return null
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let value: unknown
  try {
    const decoded = Buffer.from(match[1], 'base64url')
    if (decoded.toString('base64url') !== match[1]) return null
    value = JSON.parse(decoded.toString('utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    Object.keys(raw).sort().join(',') !== 'beforeIndex,cut,generation,sessionId,surface,totalNodes' ||
    typeof raw.sessionId !== 'string' ||
    raw.sessionId.length < 1 ||
    raw.sessionId.length > 512 ||
    !Number.isSafeInteger(raw.generation) ||
    (raw.generation as number) < 1 ||
    !Number.isSafeInteger(raw.cut) ||
    (raw.cut as number) < 0 ||
    !Number.isSafeInteger(raw.beforeIndex) ||
    (raw.beforeIndex as number) < 0 ||
    !Number.isSafeInteger(raw.totalNodes) ||
    (raw.totalNodes as number) < (raw.beforeIndex as number) ||
    ![null, 'tui', 'web', 'channel'].includes(raw.surface as null | string)
  )
    return null
  return raw as UIHistoryCursorPayload
}

const boundedProjectionInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number => {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum)
    throw rpcError('INVALID_PARAMS', { reason: `invalid ${name}` })
  return Math.min(resolved, maximum)
}

const projectionResyncRequired = () => rpcError('INTERNAL_ERROR', { code: UI_PROJECTION_RESYNC_REQUIRED })

/**
 * Compares two authoritative Core projections. The daemon does not fold ledger events or invent UI
 * semantics: it only identifies which stable node ids changed position/value or disappeared.
 */
export function diffUITimeline(previous: UITimeline, next: UITimeline): UITimelinePatch {
  const previousById = new Map(previous.nodes.map((node, index) => [node.id, { node, index }]))
  const nextIds = new Set(next.nodes.map((node) => node.id))
  const changes: UIProjectionNodeChange[] = []
  for (const node of previous.nodes) {
    if (!nextIds.has(node.id)) changes.push({ op: 'remove', id: node.id })
  }
  for (const [index, node] of next.nodes.entries()) {
    const before = previousById.get(node.id)
    if (!before || before.index !== index || !isDeepStrictEqual(before.node, node))
      changes.push({ op: 'upsert', index, node: structuredClone(node) as UINode })
  }
  const previousTurnsById = new Map(previous.turns.map((turn, index) => [turn.id, { turn, index }]))
  const nextTurnIds = new Set(next.turns.map((turn) => turn.id))
  const turnChanges: UITimelinePatch['turnChanges'] = []
  for (const turn of previous.turns) {
    if (!nextTurnIds.has(turn.id)) turnChanges.push({ op: 'remove', id: turn.id })
  }
  for (const [index, turn] of next.turns.entries()) {
    const before = previousTurnsById.get(turn.id)
    if (!before || before.index !== index || !isDeepStrictEqual(before.turn, turn))
      turnChanges.push({ op: 'upsert', index, turn: structuredClone(turn) })
  }
  return {
    sessionId: next.sessionId,
    generation: next.generation,
    from: previous.upto,
    upto: next.upto,
    opState: structuredClone(next.opState),
    changes,
    turnChanges,
    ...(next.budget === undefined ? {} : { budget: structuredClone(next.budget) }),
    ...(next.usage === undefined ? {} : { usage: structuredClone(next.usage) }),
  }
}

type CoreUIProjectionUpdate =
  | { kind: 'patch'; patch: Omit<UITimelinePatch, 'generation'> }
  | { kind: 'replace'; timeline: Omit<UITimeline, 'generation'> }

async function scanNewest(
  session: ScannableSession,
  type: string,
  accept: (event: ScannedEvent) => boolean,
): Promise<ScannedEvent | undefined> {
  let toSeq: number | undefined
  for (;;) {
    const rows = await session.scan({
      type,
      order: 'desc',
      limit: SCAN_PAGE_MAX,
      ...(toSeq === undefined ? {} : { toSeq }),
    })
    const found = rows.find(accept)
    if (found || rows.length < SCAN_PAGE_MAX) return found
    const oldest = rows.at(-1)
    if (!oldest || oldest.seq <= 1) return undefined
    toSeq = oldest.seq - 1
  }
}

/** Every row of one type, oldest first, read to the end of the ledger one page at a time. */
async function rowsOfType(session: ScannableSession, type: string): Promise<ScannedEvent[]> {
  const events: ScannedEvent[] = []
  const read: ScanRead<ScannedEvent> = (q) =>
    session.scan({ type, order: 'asc', limit: q.limit ?? SCAN_PAGE_MAX, fromSeq: q.fromSeq ?? 1 })
  for await (const page of scanPages(read, { fromSeq: 1, type })) events.push(...page)
  return events
}

export async function compactOutcomeForRange(
  session: ScannableSession,
  markerSeq: number,
  endSeq: number,
): Promise<CompactOutcome> {
  try {
    const [completed, failed] = await Promise.all([
      rowsOfType(session, 'x/core/compaction-end'),
      rowsOfType(session, 'x/core/compaction-failed'),
    ])
    const inRun = (event: ScannedEvent): boolean => event.seq > markerSeq && event.seq <= endSeq
    const ends = completed.filter(inRun)
    const failures = failed.filter(inRun)
    if (ends.length === 1 && failures.length === 0) return { state: 'completed', endSeq }
    if (ends.length === 0 && failures.length === 1) return { state: 'failed', endSeq }
  } catch {
    // A missing/failed ledger read cannot certify success. The durable receipt records that fact.
  }
  return { state: 'unknown' }
}

/** Serializes one idempotency key across every endpoint sharing the same in-process session proxy. */
async function serializeSessionMutation<T>(session: object, key: string, work: () => Promise<T>): Promise<T> {
  let tails = sessionMutationTails.get(session)
  if (!tails) {
    tails = new Map()
    sessionMutationTails.set(session, tails)
  }
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  tails.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await work()
  } finally {
    release()
    if (tails.get(key) === current) tails.delete(key)
  }
}

const FAMILIES: Array<Family & { when?: (cx: AgnesContext) => boolean }> = [
  {
    name: 'computer-use',
    methods: ['_agnes/v1/computerUse.status'],
    guidance: 'read-only admission status; blocked reports never start or repair a driver',
  },
  {
    name: 'computer-use',
    methods: [
      '_agnes/v1/computerUse.permissions.status',
      '_agnes/v1/computerUse.permissions.grant',
      '_agnes/v1/computerUse.doctor',
      '_agnes/v1/computerUse.operation.start',
      '_agnes/v1/computerUse.operation.status',
      '_agnes/v1/computerUse.operation.cancel',
    ],
    guidance: 'local-owner diagnostics and explicit macOS system permission setup',
    when: (cx) => cx.authKind === 'local' && cx.credentialKind === 'local',
  },
  {
    name: 'diagnostics',
    methods: ['_agnes/v1/diagnostics.collect', '_agnes/v1/diagnostics.events'],
    guidance:
      'Local-owner support bundle: runtime info, redacted audit log tails, and sanitized ledger pages.',
    when: (cx) => cx.authKind === 'local' && cx.credentialKind === 'local',
  },
  {
    name: 'config',
    methods: ['config.get', 'config.providers', 'config.test', 'config.save', 'config.oauth'],
    guidance:
      'Local profile configuration; credentials are never returned. Check save effect before opening a session.',
    when: (cx) => cx.configuration === true && cx.authKind === 'local' && cx.credentialKind === 'local',
  },
  {
    name: 'session',
    methods: [
      'session.attach',
      'session.detach',
      'session.event',
      'session.steer',
      'session.followUp',
      'session.budget',
      'session.projectUI',
      'session.projectUIPatch',
      'session.projectUIOpening',
      'session.projectUIHistory',
      'session.list',
      'session.rename',
      'session.archive',
      'session.fork',
      'session.setPreset',
      'session.setModel',
      'session.setYolo',
    ].map((m) => `_agnes/v1/${m}`),
    guidance: 'attach before reading events; steer while a turn runs, followUp to queue',
  },
  {
    name: 'workspace',
    methods: ['_agnes/v1/workspace.list', '_agnes/v1/workspace.add'],
    guidance: 'validate and register canonical workspace directories before creating sessions',
  },
  {
    name: 'approval',
    methods: ['_agnes/v1/approval.decide'],
    guidance: 'decide a parked approval by ticket; the server mints the approver from the credential',
    when: (x) => !!x.resolveActor,
  },
  {
    name: 'approval-grants',
    methods: ['_agnes/v1/approvalGrants.list', '_agnes/v1/approvalGrants.revoke'],
    guidance: 'manage fully-bound permanent grants; actor and profile come from server authority',
    when: (x) => !!x.profileHashForSession && !!x.resolveActor,
  },
  {
    name: 'participant',
    methods: ['_agnes/v1/participant.join', '_agnes/v1/participant.leave', '_agnes/v1/participant.list'],
    guidance: 'credentials only; never an actor',
    when: (x) => !!x.resolveActor,
  },
  {
    name: 'jobs',
    methods: ['_agnes/v1/jobs.poll', '_agnes/v1/jobs.cancel', '_agnes/v1/artifact.job.status'],
    guidance: 'jobs are table rows; poll by id',
  },
  {
    name: 'artifact',
    methods: ['_agnes/v1/artifact.read'],
    guidance: 'authenticated content-addressed reads; session and lane are authorization targets',
    when: (x) => x.artifactRead === true,
  },
  // Local authentication is the whole condition. The old `|| !!x.jobs` advertised the protected
  // enqueue to every remote connection on any daemon that runs a jobs service, which is the opposite
  // of what enforcement does and of what this family's own guidance says.
  {
    name: 'jobs',
    methods: ['_agnes/v1/jobs.enqueue'],
    guidance: 'enqueue; protected names only from the local socket',
    when: (x) => x.authKind === 'local',
  },
  {
    name: 'ui',
    methods: ['_agnes/v1/ext.ui.response'],
    guidance: 'slot actions flow back here',
  },
  {
    name: 'extension',
    methods: ['_agnes/v1/extension.call', '_agnes/v1/extension.ack'],
    guidance: 'named Strict JSON Services with explicit effect receipt acknowledgement',
    when: (x) => x.authKind === 'surface',
  },
  {
    name: 'auth',
    methods: ['_agnes/v1/auth.claim'],
    guidance: 'server-side once / rate-limit buckets; fail closed',
  },
  {
    name: 'submit',
    methods: ['_agnes/v1/submit', '_agnes/v1/submit.ack'],
    guidance: 'idempotent writes and explicit receipt acknowledgement',
  },
  {
    name: 'daemon',
    methods: ['_agnes/v1/daemon.notice'],
    guidance: 'server notices; not ledger events',
  },
  // Installed AND presented with a directory-bearing credential: the kind is half the condition and
  // was missing from the predicate while being stated in the prose.
  {
    name: 'daemon',
    methods: ['_agnes/v1/directory.upsert'],
    guidance: 'enterprise directory sync',
    when: (x) => !!x.directory && (x.credentialKind === 'sso' || x.credentialKind === 'channel'),
  },
]

/**
 * The closed set of structural refusals a preset or model switch can raise, collapsed to one wire
 * error: `E_PRESET_UNSUPPORTED`/`E_PRESET_UNRESOLVED` are host's `validatePresetSwitch` (Task 27a,
 * `packages/host/src/session-switch.ts`), `E_MODEL_UNSUPPORTED` is host's `validateModelSwitch`'s own
 * policy refusal (the pair exists and the provider publishes it, but it is outside this deployment's
 * assembled route table), and `E_MODEL_UNKNOWN` is core's own structural double-check
 * (`packages/core/src/step/reentry.ts`'s `setModel`, reached if a caller ever skips the host gate).
 * A client only needs to know "this switch was refused"; `reason` carries which of the four it was,
 * so the four do not need four different RPC codes.
 *
 * Earlier drafts of this file had `mapCore` recognize a single `E_PRESET_SWITCH` code that no version
 * of core or host has ever thrown - fixed 2026-09-10 once host's real gate (commits `536aa18` ->
 * `ac4ca85` -> `3b10b07`) landed, to recognize the four codes the gate and core actually raise.
 *
 * Used by both `methods/acp.ts`'s `session/set_mode` and this file's own `_agnes/v1/session.setPreset`/
 * `session.setModel` handlers below, now that `@agnes/protocol` carries schemas for the latter two
 * (landed 2026-09-10) - so there is exactly one place that turns a host validation throw into the
 * wire's `PRESET_SWITCH_REJECTED`, not a drifting copy per call site.
 */
const REJECT_CODES = new Set([
  'E_PRESET_UNSUPPORTED',
  'E_PRESET_UNRESOLVED',
  'E_MODEL_UNSUPPORTED',
  'E_MODEL_UNKNOWN',
])
export function mapCore(e: unknown): never {
  const err = e as { code?: string; message?: string }
  if (err.code && REJECT_CODES.has(err.code))
    throw rpcError('PRESET_SWITCH_REJECTED', { reason: err.message ?? 'rejected' })
  throw e
}

/** Exported so both branches of every predicate are reachable from a table-driven test. */
export function apisFamilies(
  cx: AgnesContext,
  identity: Pick<AgnesContext, 'authKind' | 'credentialKind'> = cx,
): Family[] {
  const scoped = { ...cx, ...identity }
  const merged = new Map<string, Family>()
  for (const f of FAMILIES) {
    if (f.when && !f.when(scoped)) continue
    const m = merged.get(f.name)
    // A fresh array per call: pushing into the row's own methods array would grow the shared table
    // on every listing.
    if (m) m.methods.push(...f.methods)
    else merged.set(f.name, { name: f.name, methods: [...f.methods], guidance: f.guidance })
  }
  return [...merged.values()]
}

/** The session-owner gate every session method runs; exported so diagnostics.events runs the same one. */
export function requireSessionOwner(
  cx: Pick<AgnesContext, 'sessionOwnership' | 'registry' | 'workspaces'>,
): (method: string, sessionId: string, c: CallContext) => void {
  return (method, sessionId, c) => {
    let owner: ReturnType<NonNullable<AgnesContext['sessionOwnership']>['resolve']>
    try {
      owner = cx.sessionOwnership?.resolve(sessionId)
    } catch {
      // Missing/corrupt ownership and a mismatched authenticated principal are indistinguishable.
      throw rpcError('CAPABILITY_DENIED', { method, sessionId, reason: 'session owner unavailable' })
    }
    if (owner?.principalId === c.conn.principalId) return
    // Preserve not-found for ids with no live/durable session fact, but never return success: an
    // unknown id must not become an authorization grant while a queued mutation is waiting.
    if (
      !owner &&
      cx.registry.get(sessionId) === undefined &&
      cx.workspaces.sessionPath(sessionId) === undefined
    )
      throw rpcError('SESSION_NOT_FOUND', { sessionId })
    throw rpcError('CAPABILITY_DENIED', { method, sessionId, reason: 'session owner unavailable' })
  }
}

export function registerAgnes(
  ep: LocalEndpoint,
  cx: AgnesContext,
  _feeds: Map<string, Feed>,
  attached: Map<string, AttachedFeed>,
): void {
  const requireOwner = requireSessionOwner(cx)
  const computerUseControl = createBlockedComputerUseControlPlane(cx.lockedPackageMutations, cx.computerUse)
  type GrantBindingParams = {
    sessionId: string
    toolId: string
    scope: string
    policyVersion: string
  }
  const approvalGrantBinding = async (method: string, params: GrantBindingParams, c: CallContext) => {
    requireOwner(method, params.sessionId, c)
    if (!cx.profileHashForSession || !cx.resolveActor)
      throw rpcError('CAPABILITY_DENIED', {
        method,
        sessionId: params.sessionId,
        reason: 'session profile authority unavailable',
      })
    let profileHash: string | null
    try {
      profileHash = await cx.profileHashForSession(params.sessionId)
    } catch {
      throw rpcError('CAPABILITY_DENIED', {
        method,
        sessionId: params.sessionId,
        reason: 'session profile authority unavailable',
      })
    }
    if (!profileHash || !/^sha256-[a-f0-9]{64}$/.test(profileHash))
      throw rpcError('CAPABILITY_DENIED', {
        method,
        sessionId: params.sessionId,
        reason: 'session profile authority unavailable',
      })
    let actor: Actor
    try {
      actor = await cx.resolveActor(c.conn.credential, 'session', params.sessionId)
    } catch {
      throw rpcError('CAPABILITY_DENIED', {
        method,
        sessionId: params.sessionId,
        reason: 'session actor authority unavailable',
      })
    }
    return {
      profileHash,
      actorId: actor.id,
      actorOrg: actor.org,
      toolId: params.toolId,
      scope: params.scope,
      policyVersion: params.policyVersion,
    }
  }
  ep.register('_agnes/v1/approvalGrants.list', async (params, c) => {
    const p = params as GrantBindingParams
    return { grants: cx.host.approvalGrants.list(await approvalGrantBinding('approvalGrants.list', p, c)) }
  })
  ep.register('_agnes/v1/approvalGrants.revoke', async (params, c) => {
    const p = params as GrantBindingParams & { grantId: string }
    const grant = cx.host.approvalGrants.revoke(
      await approvalGrantBinding('approvalGrants.revoke', p, c),
      p.grantId,
      new Date(c.clock()).toISOString(),
    )
    if (!grant) throw rpcError('APPROVAL_REJECTED', { reason: 'grant unavailable' })
    return grant
  })
  ep.register('_agnes/v1/computerUse.status', async (_params, c): Promise<ComputerUseStatusResult> => {
    // This handler is deliberately a P0 gate report, not a probe. Authentication must have been
    // established by initialize/authGate, and answering it must never resolve, install or start a
    // driver. When the P0 evidence gate is complete a later contract may widen these closed states.
    return computerUseControl.status(c.conn, _params)
  })
  ep.register(
    '_agnes/v1/computerUse.permissions.status',
    async (params, c): Promise<ComputerUsePermissionsStatusResult> =>
      computerUseControl.permissionsStatus(c.conn, params),
  )
  ep.register(
    '_agnes/v1/computerUse.permissions.grant',
    async (params, c): Promise<ComputerUsePermissionsStatusResult> =>
      computerUseControl.permissionsGrant(c.conn, params),
  )
  ep.register(
    '_agnes/v1/computerUse.doctor',
    async (params, c): Promise<ComputerUseDoctorResult> => computerUseControl.doctor(c.conn, params),
  )
  ep.register(
    '_agnes/v1/computerUse.operation.start',
    async (params, c): Promise<ComputerUseOperationResult> =>
      computerUseControl.operationStart(c.conn, params),
  )
  ep.register(
    '_agnes/v1/computerUse.operation.status',
    async (params, c): Promise<ComputerUseOperationResult> =>
      computerUseControl.operationStatus(c.conn, params),
  )
  ep.register(
    '_agnes/v1/computerUse.operation.cancel',
    async (params, c): Promise<ComputerUseOperationResult> =>
      computerUseControl.operationCancel(c.conn, params),
  )
  const neverAbort = (): AbortSignal => new AbortController().signal
  const generationGuard =
    (sessionId: string, generation?: number): (() => void) =>
    () => {
      if (generation === undefined) return
      const current = cx.registry.require(sessionId).generation
      if (generation !== current) throw rpcError('GENERATION_STALE', { generation: current })
    }
  ep.register('_agnes/v1/approval.decide', async (params, c) => {
    if (!cx.resolveActor) throw rpcError('CAPABILITY_DENIED', { method: 'approval.decide' })
    const p = params as {
      ticket: string
      verdict: 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'
      approverCredential: unknown
    }
    type ApprovalSession = {
      resumeApproval?: (
        ticket: string,
        verdict: 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected',
        actor: Actor,
      ) => Promise<{ seq: number }>
      decideApproval?: (input: {
        ticket: string
        verdict: 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'
        decidedBy: Actor
      }) => Promise<{ seq: number }>
    }
    const matches: Array<{ sessionId: string; session: ApprovalSession }> = []
    // A ticket deliberately carries no session id. Prefer the event-built index; unlike an open
    // registry scan it survives daemon restart. Ticket cwd is history only: reopening must restore
    // the daemon-issued authority binding for the indexed session.
    const indexed = cx.tickets?.get(p.ticket)
    if (indexed)
      try {
        requireOwner('approval.decide', indexed, c)
      } catch {
        throw rpcError('APPROVAL_REJECTED', { reason: 'unknown ticket' })
      }
    if (indexed && !cx.registry.get(indexed)) {
      let binding: WorkspaceBindingEnvelope
      try {
        binding = await cx.workspaces.restoreBinding(indexed)
      } catch {
        throw rpcError('APPROVAL_REJECTED', {
          reason: 'ticket workspace unavailable',
        })
      }
      await cx.registry.open({ key: indexed, cwd: binding.canonicalRoot, binding })
    }
    const candidates = indexed ? [indexed] : cx.registry.keys()
    // An index miss retains Task 11's compatibility fallback over open sessions. Refuse ambiguity
    // rather than choosing whichever registry key happens to enumerate first.
    for (const sessionId of candidates) {
      try {
        requireOwner('approval.decide', sessionId, c)
      } catch {
        continue
      }
      const session = cx.registry.get(sessionId)?.session
      if (!session) continue
      const asked = await scanNewest(
        session as unknown as ScannableSession,
        'approval/asked',
        (event) => (event.data as { pending?: { ticket?: unknown } } | null)?.pending?.ticket === p.ticket,
      )
      if (asked) matches.push({ sessionId, session: session as ApprovalSession })
      if (matches.length > 1) break
    }
    if (matches.length !== 1)
      throw rpcError('APPROVAL_REJECTED', {
        reason: matches.length === 0 ? 'unknown ticket' : 'ambiguous ticket',
      })
    const match = matches[0] as (typeof matches)[number]
    const approver = await cx.resolveActor(p.approverCredential, 'approval', match.sessionId)
    const session = match.session
    try {
      if (session.resumeApproval) return session.resumeApproval(p.ticket, p.verdict, approver)
      if (session.decideApproval)
        return session.decideApproval({ ticket: p.ticket, verdict: p.verdict, decidedBy: approver })
      throw new Error('session has no approval callback')
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown }
      if (e.code === 'E_RELATION')
        throw rpcError('APPROVAL_REJECTED', {
          reason: typeof e.message === 'string' ? e.message : 'approval rejected',
        })
      throw error
    }
  })
  ep.register('_agnes/v1/session.budget', async (params, c) => {
    const sessionId = (params as { sessionId: string }).sessionId
    requireOwner('session.budget', sessionId, c)
    const session = cx.registry.require(sessionId).session
    const cut = session.lastSeq
    const state = structuredClone(session.latest('budget.state') ?? null)
    const rows = await session.scan({ toSeq: cut, type: 'cost/ledger', order: 'desc', limit: 200 })
    const ledger = rows.reverse().map((row) => {
      const cost = row.data as CostLedger
      return {
        seq: row.seq,
        creditSource: cost.creditSource,
        purpose: cost.purpose,
        ...(cost.credits !== undefined ? { credits: cost.credits } : {}),
      }
    })
    return { state, ledger }
  })
  ep.register('_agnes/v1/session.projectUI', async (params, c) => {
    const p = params as SessionProjectUIParams
    requireOwner('session.projectUI', p.sessionId, c)
    if (p.upto !== undefined && (!Number.isSafeInteger(p.upto) || p.upto < 0))
      throw rpcError('INVALID_PARAMS', { reason: 'invalid projection upper bound' })
    const entry = cx.registry.require(p.sessionId)
    const generation = entry.generation
    const timeline = await entry.session.projectUI(p.upto, p.surface ? { surface: p.surface } : {})
    const current = { ...timeline, generation } as UITimeline
    rememberProjection(c.conn, uiProjectionKey(p.sessionId, p.surface), current)
    return current
  })
  ep.register('_agnes/v1/session.projectUIOpening', async (params, c) => {
    const p = params as SessionProjectUIOpeningParams
    requireOwner('session.projectUIOpening', p.sessionId, c)
    const maxNodes = boundedProjectionInteger(
      p.maxNodes,
      UI_OPENING_DEFAULT_MAX_NODES,
      1,
      UI_OPENING_MAX_NODES,
      'opening node limit',
    )
    const maxBytes = boundedProjectionInteger(
      p.maxBytes,
      UI_PROJECTION_DEFAULT_MAX_BYTES,
      UI_PROJECTION_MIN_MAX_BYTES,
      UI_PROJECTION_MAX_BYTES,
      'projection byte limit',
    )
    const entry = cx.registry.require(p.sessionId)
    const core = (await entry.session.projectUIOpening({
      ...(p.surface ? { surface: p.surface } : {}),
      maxNodes,
      // Leave room for timeline metadata, history coordinates, cursor and JSON object keys. The
      // exact serialized result is checked below; this only avoids cloning avoidable nodes first.
      maxBytes: Math.max(1, maxBytes - 4096),
    })) as {
      timeline: Omit<UITimeline, 'generation'>
      hasEarlier: boolean
      startIndex: number
      totalNodes: number
    }
    let nodes = core.timeline.nodes
    let startIndex = core.startIndex
    for (;;) {
      const nodeIds = new Set(nodes.map((node) => node.id))
      const turns = core.timeline.turns.filter((turn) => turn.nodeIds.some((id) => nodeIds.has(id)))
      const hasEarlier = startIndex > 0
      const history = hasEarlier
        ? {
            hasEarlier: true as const,
            cursor: encodeUIHistoryCursor({
              sessionId: p.sessionId,
              generation: entry.generation,
              surface: p.surface ?? null,
              cut: core.timeline.upto,
              beforeIndex: startIndex,
              totalNodes: core.totalNodes,
            }),
            startIndex,
            totalNodes: core.totalNodes,
          }
        : { hasEarlier: false as const, startIndex, totalNodes: core.totalNodes }
      const result = {
        timeline: { ...core.timeline, generation: entry.generation, nodes, turns },
        history,
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes) {
        windowedProjectionConnections.add(c.conn)
        rememberProjection(c.conn, uiProjectionKey(p.sessionId, p.surface), result.timeline, 'windowed')
        return result
      }
      if (nodes.length <= 1) throw rpcError('INTERNAL_ERROR', { code: 'UI_PROJECTION_NODE_TOO_LARGE' })
      nodes = nodes.slice(1)
      startIndex += 1
    }
  })
  ep.register('_agnes/v1/session.projectUIHistory', async (params, c) => {
    const p = params as SessionProjectUIHistoryParams
    requireOwner('session.projectUIHistory', p.sessionId, c)
    const decoded = decodeUIHistoryCursor(p.cursor)
    if (!decoded || decoded.sessionId !== p.sessionId)
      throw rpcError('INVALID_PARAMS', { reason: 'invalid UI history cursor' })
    const entry = cx.registry.require(p.sessionId)
    if (decoded.generation !== entry.generation)
      throw rpcError('GENERATION_STALE', { generation: entry.generation })
    if (decoded.cut > entry.session.lastSeq)
      throw rpcError('CURSOR_OUT_OF_RANGE', { earliestSeq: 0, lastSeq: entry.session.lastSeq })
    const limit = boundedProjectionInteger(
      p.limit,
      UI_HISTORY_DEFAULT_LIMIT,
      1,
      UI_HISTORY_MAX_LIMIT,
      'history node limit',
    )
    const maxBytes = boundedProjectionInteger(
      p.maxBytes,
      UI_PROJECTION_DEFAULT_MAX_BYTES,
      UI_PROJECTION_MIN_MAX_BYTES,
      UI_PROJECTION_MAX_BYTES,
      'projection byte limit',
    )
    let core: {
      sessionId: string
      cut: number
      nodes: UINode[]
      turns: UITurn[]
      hasEarlier: boolean
      startIndex: number
      totalNodes: number
    }
    try {
      core = (await entry.session.projectUIHistory(decoded.cut, decoded.beforeIndex, {
        ...(decoded.surface ? { surface: decoded.surface } : {}),
        limit,
        maxBytes: Math.max(1, maxBytes - 4096),
      })) as typeof core
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'E_ENVELOPE')
        throw rpcError('CURSOR_OUT_OF_RANGE', { earliestSeq: 0, lastSeq: entry.session.lastSeq })
      throw error
    }
    if (
      core.sessionId !== p.sessionId ||
      core.cut !== decoded.cut ||
      core.totalNodes !== decoded.totalNodes ||
      core.startIndex + core.nodes.length !== decoded.beforeIndex
    )
      throw rpcError('CURSOR_OUT_OF_RANGE', { earliestSeq: 0, lastSeq: entry.session.lastSeq })

    let nodes = core.nodes
    let startIndex = core.startIndex
    for (;;) {
      const nodeIds = new Set(nodes.map((node) => node.id))
      const turns = core.turns.filter((turn) => turn.nodeIds.some((id) => nodeIds.has(id)))
      const hasEarlier = startIndex > 0
      const result = {
        sessionId: p.sessionId,
        generation: entry.generation,
        cut: decoded.cut,
        nodes,
        turns,
        hasEarlier,
        ...(hasEarlier
          ? {
              cursor: encodeUIHistoryCursor({
                ...decoded,
                beforeIndex: startIndex,
              }),
            }
          : {}),
        startIndex,
        totalNodes: core.totalNodes,
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes) return result
      if (nodes.length <= 1) throw rpcError('INTERNAL_ERROR', { code: 'UI_PROJECTION_NODE_TOO_LARGE' })
      nodes = nodes.slice(1)
      startIndex += 1
    }
  })
  ep.register('_agnes/v1/session.projectUIPatch', async (params, c): Promise<UIProjectionUpdate> => {
    const p = params as SessionProjectUIPatchParams
    requireOwner('session.projectUIPatch', p.sessionId, c)
    if (
      !Number.isSafeInteger(p.after) ||
      p.after < 0 ||
      (p.upto !== undefined && (!Number.isSafeInteger(p.upto) || p.upto < p.after))
    )
      throw rpcError('INVALID_PARAMS', { reason: 'invalid projection patch bounds' })
    const entry = cx.registry.require(p.sessionId)
    const baselines = projectionBaselinesFor(c.conn)
    const key = uiProjectionKey(p.sessionId, p.surface)
    const previous = baselines.get(key)
    if (
      !previous ||
      previous.sessionId !== p.sessionId ||
      previous.generation !== entry.generation ||
      previous.upto !== p.after
    ) {
      if (previous?.mode === 'windowed' || (!previous && windowedProjectionConnections.has(c.conn)))
        throw projectionResyncRequired()
      const timeline = await entry.session.projectUI(p.upto, p.surface ? { surface: p.surface } : {})
      const current = { ...timeline, generation: entry.generation } as UITimeline
      rememberProjection(c.conn, key, current)
      return { kind: 'replace', timeline: current }
    }
    const update = (await entry.session.projectUIPatch(
      p.after,
      p.upto,
      p.surface ? { surface: p.surface } : {},
    )) as CoreUIProjectionUpdate
    if (update.kind === 'replace') {
      if (previous.mode === 'windowed') throw projectionResyncRequired()
      const current = { ...update.timeline, generation: entry.generation } as UITimeline
      rememberProjection(c.conn, key, current)
      return { kind: 'replace', timeline: current }
    }
    const patch = { ...update.patch, generation: entry.generation } as UITimelinePatch
    const windowCoordinatesValid =
      previous.mode !== 'windowed' ||
      (Number.isSafeInteger(patch.totalNodes) &&
        (patch.totalNodes ?? -1) >= 0 &&
        patch.changes.every((change) => change.op !== 'upsert' || change.index < (patch.totalNodes ?? 0)))
    if (
      patch.sessionId === p.sessionId &&
      patch.generation === entry.generation &&
      patch.from === p.after &&
      patch.upto >= patch.from &&
      patch.upto <= entry.session.lastSeq &&
      windowCoordinatesValid
    ) {
      rememberProjection(c.conn, key, patch, previous.mode)
      return { kind: 'patch', patch }
    }
    if (previous.mode === 'windowed') throw projectionResyncRequired()
    // A corrupt or incompatible optimization result never crosses the client boundary. Rebuild
    // from Core's authoritative projection and repair this connection's baseline instead.
    const timeline = await entry.session.projectUI(p.upto, p.surface ? { surface: p.surface } : {})
    const current = { ...timeline, generation: entry.generation } as UITimeline
    rememberProjection(c.conn, key, current)
    return { kind: 'replace', timeline: current }
  })
  // `cx.lister` is declared optional on `AgnesContext` only because nothing outside this package's
  // own `createLocalEndpoint` constructs one directly; that one always supplies a `RegistryLister`
  // default (`index.ts`), so the guard below is defensive, not a real production path.
  ep.register('_agnes/v1/session.list', async (params, c) => {
    if (!cx.lister) throw rpcError('INTERNAL_ERROR', { code: 'NO_LISTER' })
    const p = params as {
      q?: { cwd?: string; prefix?: string; text?: string }
      cursor?: string
      limit?: number
    }
    // `text` wins over `prefix` because the internal lister has one free-text key query. cwd remains
    // separate and exact: every implementation either has a recorded session workspace or returns
    // no match, never silently widens the query to every session.
    const q = p.q?.text ?? p.q?.prefix
    // Sessions are bound to the workspace session/new canonicalized, so the filter is canonicalized the
    // same way (a symlink or trailing-slash spelling finds them). A path that no longer resolves, such as
    // a deleted workspace, is still compared as given against the paths its sessions were bound to.
    const typed = p.q?.cwd
    const resolved = typed ? await cx.workspaces.validate(typed).catch(() => undefined) : undefined
    const cwd = resolved?.path ?? typed
    let sessionIds: readonly string[]
    try {
      sessionIds = cx.sessionOwnership?.activeSessionIds(c.conn.principalId) ?? []
    } catch {
      throw rpcError('CAPABILITY_DENIED', {
        method: 'session.list',
        reason: 'session owner unavailable',
      })
    }
    const r = await cx.lister.list({
      ...(q !== undefined ? { q } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(p.cursor !== undefined ? { cursor: p.cursor } : {}),
      ...(p.limit !== undefined ? { limit: p.limit } : {}),
      sessionIds,
    })
    const scope = new Set(sessionIds)
    return {
      items: r.items.filter((item) => scope.has(item.sessionId)),
      ...(r.cursor !== undefined ? { next: r.cursor } : {}),
    }
  })
  ep.register('_agnes/v1/session.fork', async (params, c) => {
    const p = params as { sessionId: string; at: number; childKey?: string }
    requireOwner('session.fork', p.sessionId, c)
    const r = await runQueued(cx.commandQueue, p.sessionId, neverAbort(), () =>
      cx.forkSession(p.sessionId, p.at, p.childKey, c.conn.credential, c.conn.principalId),
    )
    return r.result as { sessionId: string }
  })
  ep.register('_agnes/v1/session.setPreset', async (params, c) => {
    const p = params as { sessionId: string; preset: string }
    requireOwner('session.setPreset', p.sessionId, c)
    const entry = cx.registry.require(p.sessionId)
    try {
      const resolved = cx.host.validatePresetSwitch(p.preset)
      return {
        effectiveFromSeq: await runQueued(cx.commandQueue, p.sessionId, neverAbort(), () =>
          entry.session.setPreset(resolved.view),
        ),
      }
    } catch (e) {
      return mapCore(e)
    }
  })
  ep.register('_agnes/v1/session.setModel', async (params, c) => {
    const p = params as {
      sessionId: string
      slot: string
      route: string
      model: string
      thinking?: ThinkingLevel
    }
    const sel = {
      slot: p.slot,
      route: p.route,
      model: p.model,
      ...(p.thinking === undefined ? {} : { thinking: p.thinking }),
    }
    requireOwner('session.setModel', p.sessionId, c)
    try {
      cx.host.validateModelSwitch(sel)
      return {
        effectiveFromSeq: await runQueued(cx.commandQueue, p.sessionId, neverAbort(), () =>
          cx.registry.require(p.sessionId).session.setModel(sel),
        ),
      }
    } catch (e) {
      return mapCore(e)
    }
  })
  // No host validation gate: unlike preset/model, there is no route table a boolean bypass flag
  // could fall outside of, so there is nothing here for `cx.host` to check before it lands.
  ep.register('_agnes/v1/session.setYolo', async (params, c) => {
    const p = params as { sessionId: string; enabled: boolean }
    requireOwner('session.setYolo', p.sessionId, c)
    const actor = connActor(c.conn)
    return {
      effectiveFromSeq: await runQueued(cx.commandQueue, p.sessionId, neverAbort(), async () => {
        const session = cx.registry.require(p.sessionId).session
        const computerUseSession = { key: session.key, lane: session.lane }
        if (!cx.computerUse) return session.setYolo(p.enabled, actor)
        if (!p.enabled) {
          // Tighten the driver before publishing approval enforcement. A ledger failure can then
          // only leave the native driver in the stricter standard mode.
          await cx.computerUse.setSessionYolo(computerUseSession, false)
          return session.setYolo(false, actor)
        }
        const effectiveFromSeq = await session.setYolo(true, actor)
        try {
          await cx.computerUse.setSessionYolo(computerUseSession, true)
          return effectiveFromSeq
        } catch (error) {
          const failures: unknown[] = [error]
          try {
            await cx.computerUse.setSessionYolo(computerUseSession, false)
          } catch (rollbackError) {
            failures.push(rollbackError)
          }
          try {
            await session.setYolo(false, actor)
          } catch (rollbackError) {
            failures.push(rollbackError)
          }
          throw new AggregateError(failures, 'Computer Use session YOLO mode switch failed')
        }
      }),
    }
  })
  ep.register('_agnes/v1/session.attach', async (params, c) => {
    const p = params as {
      sessionId: string
      cursor?: { fromSeq: number; generation: number }
      filter?: {
        types?: string[]
        lanes?: string[]
        preview?: boolean
        acpUpdates?: boolean
      }
    }
    requireOwner('session.attach', p.sessionId, c)
    const entry = cx.registry.require(p.sessionId)
    const gen = p.cursor?.generation ?? entry.generation
    if (gen !== entry.generation) throw rpcError('GENERATION_STALE', { generation: entry.generation })
    const observedLastSeq = entry.session.lastSeq
    // Exclusive cursor: fromSeq is the last row already applied. 0 is legal and
    // means nothing applied; fromSeq === lastSeq means caught up; only past lastSeq is out of range.
    // Clamping to 1 would skip seq 1 for exactly the client that has applied nothing.
    const fromSeq = p.cursor?.fromSeq ?? 0
    if (fromSeq > observedLastSeq)
      throw rpcError('CURSOR_OUT_OF_RANGE', { earliestSeq: 0, lastSeq: observedLastSeq })
    const prefs = {
      cursor: { fromSeq, generation: gen },
      filter: {
        ...(p.filter?.types ? { types: p.filter.types } : {}),
        ...(p.filter?.lanes ? { lanes: p.filter.lanes } : {}),
        preview: p.filter?.preview ?? false,
        acpUpdates: p.filter?.acpUpdates ?? false,
      },
    }
    c.conn.attached.set(p.sessionId, prefs)
    const feed = new AttachedFeed({
      ep,
      key: p.sessionId,
      generation: entry.generation,
      prefs,
      limits: cx.limits,
      clock: cx.clock,
      onDrop: () => {
        if (attached.get(p.sessionId) !== feed) return
        c.conn.attached.delete(p.sessionId)
        attached.delete(p.sessionId)
      },
      fetchPreview: () => cx.registry.previewSnapshot(p.sessionId),
    })
    feed.beginReplay()
    attached.get(p.sessionId)?.detach()
    attached.set(p.sessionId, feed)
    // Capture only after the live callback can see a holding feed. Rows appended before publication
    // are included in this replay cut; rows appended afterward are held and drained in order.
    const lastSeq = entry.session.lastSeq
    try {
      await feed.replay(entry.session, fromSeq, lastSeq)
    } catch (error) {
      if (attached.get(p.sessionId) === feed) {
        attached.delete(p.sessionId)
        c.conn.attached.delete(p.sessionId)
      }
      throw error
    }
    return {
      generation: gen,
      lastSeq,
      resolvedProfileHash: cx.profileHashForSession
        ? await cx.profileHashForSession(p.sessionId)
        : (cx.host.profile.hash ?? null),
    }
  })

  ep.register('_agnes/v1/session.detach', async (params, c) => {
    const { sessionId } = params as { sessionId: string }
    requireOwner('session.detach', sessionId, c)
    c.conn.attached.delete(sessionId)
    attached.get(sessionId)?.detach()
    attached.delete(sessionId)
    const baselines = uiProjectionBaselines.get(c.conn)
    if (baselines)
      for (const key of baselines.keys()) {
        if ((JSON.parse(key) as [string, string | null])[0] === sessionId) baselines.delete(key)
      }
    return {}
  })
  const jobs = (method: string): JobsPort => {
    if (!cx.jobs) throw rpcError('CAPABILITY_DENIED', { method })
    return cx.jobs
  }
  const requireOwnedJob = async (method: string, jobId: string, c: CallContext): Promise<void> => {
    const port = jobs(method)
    let sessionId: string | undefined
    try {
      sessionId = await port.sessionKey(jobId)
      if (!sessionId) throw new Error('missing')
      requireOwner(method, sessionId, c)
    } catch {
      // Missing and foreign jobs are indistinguishable; neither their session nor existence leaks.
      throw rpcError('SESSION_NOT_FOUND', { jobId })
    }
  }
  ep.register('_agnes/v1/jobs.enqueue', async (params, c) => {
    const sessionKey = (params as { sessionKey: string }).sessionKey
    if (typeof sessionKey === 'string') requireOwner('jobs.enqueue', sessionKey, c)
    return runQueued(cx.commandQueue, sessionKey, neverAbort(), () =>
      jobs('jobs.enqueue').enqueue(params, { local: c.conn.authKind === 'local' }),
    )
  })
  ep.register('_agnes/v1/jobs.poll', async (params, c) => {
    const jobId = (params as { jobId: string }).jobId
    await requireOwnedJob('jobs.poll', jobId, c)
    return jobs('jobs.poll').poll(jobId)
  })
  ep.register('_agnes/v1/jobs.cancel', async (params, c) => {
    const jobId = (params as { jobId: string }).jobId
    await requireOwnedJob('jobs.cancel', jobId, c)
    await jobs('jobs.cancel').cancel(jobId)
    return {}
  })
  const participantRows = async (session: ScannableSession): Promise<ParticipantListResult> => {
    const current = new Map<string, ParticipantListResult['participants'][number]>()
    for (const event of await rowsOfType(session, 'participant')) {
      const data = event.data as {
        action?: unknown
        participant?: Actor
        surface?: unknown
      } | null
      if (!data?.participant?.id) continue
      if (data.action === 'join')
        current.set(data.participant.id, {
          actor: structuredClone(data.participant),
          joinedAt: event.ts,
          ...(typeof data.surface === 'string' ? { surface: data.surface } : {}),
        })
      else if (data.action === 'leave') current.delete(data.participant.id)
    }
    return { participants: [...current.values()] }
  }
  const participantOp = (action: 'join' | 'leave') => async (params: unknown, c: CallContext) => {
    if (!cx.resolveActor) throw rpcError('CAPABILITY_DENIED', { method: `participant.${action}` })
    const p = params as ParticipantParams
    requireOwner(`participant.${action}`, p.sessionId, c)
    const actor = await cx.resolveActor(p.credential, 'session', p.sessionId)
    const session = cx.registry.require(p.sessionId).session
    const surface = p.credential.kind === 'channel' ? p.credential.channel : p.credential.kind
    return runQueued(cx.commandQueue, p.sessionId, neverAbort(), () =>
      serializeSessionMutation(session, JSON.stringify(['participant', actor.id]), async () => {
        const previous = await scanNewest(
          session as unknown as ScannableSession,
          'participant',
          (event) => (event.data as { participant?: { id?: unknown } } | null)?.participant?.id === actor.id,
        )
        if (previous && (previous.data as { action?: unknown } | undefined)?.action === action)
          return { seq: previous.seq }
        const written = await session.append([
          {
            type: 'participant',
            data: {
              action,
              participant: actor,
              surface,
              credentialKind: p.credential.kind,
            },
            actor,
            origin: 'principal',
            trust: 'untrusted',
          },
        ])
        return { seq: written.firstSeq }
      }),
    )
  }
  ep.register('_agnes/v1/participant.join', participantOp('join'))
  ep.register('_agnes/v1/participant.leave', participantOp('leave'))
  ep.register('_agnes/v1/participant.list', async (params, c) => {
    if (!cx.resolveActor) throw rpcError('CAPABILITY_DENIED', { method: 'participant.list' })
    const sessionId = (params as { sessionId: string }).sessionId
    requireOwner('participant.list', sessionId, c)
    const session = cx.registry.require(sessionId).session
    return participantRows(session as unknown as ScannableSession)
  })
  ep.register('_agnes/v1/artifact.job.status', async (params, c) => {
    const jobId = (params as { jobId: string }).jobId
    for (const sessionId of cx.registry.keys()) {
      try {
        requireOwner('artifact.job.status', sessionId, c)
      } catch {
        continue
      }
      const session = cx.registry.get(sessionId)?.session
      if (!session) continue
      // RemoteSession's synchronous latest() is only a tail-fed cache, so a just-loaded production
      // worker may not have replayed its durable register frames yet. Read the ledger itself here;
      // this also keeps the local and supervisor forms on one deterministic path.
      const event = await scanNewest(session as unknown as ScannableSession, 'artifact/job', (row) => {
        const data = row.data as { jobId?: unknown } | null
        return data?.jobId === jobId
      })
      if (event) return structuredClone(event.data)
    }
    throw rpcError('SESSION_NOT_FOUND', { jobId })
  })
  ep.register('_agnes/v1/directory.upsert', async (params, c) => {
    // authGate is authoritative. AgnesContext's construction-time identity predates that gate and
    // can disagree with the credential initialize actually verified.
    if (!cx.directory || (c.conn.credentialKind !== 'sso' && c.conn.credentialKind !== 'channel'))
      throw rpcError('CAPABILITY_DENIED', { method: 'directory.upsert' })
    return cx.directory.upsert((params as { entries: unknown[] }).entries)
  })
  ep.register('_agnes/v1/ext.ui.response', async (params, c) => {
    const p = params as ExtUiResponseParams
    requireOwner('ext.ui.response', p.sessionId, c)
    const session = cx.registry.require(p.sessionId).session
    const actor = connActor(c.conn)
    // requestSeq is per logical client, not global to the session. principalId is stable across
    // reconnects, so clientId must remain part of this operation's natural key.
    return runQueued(cx.commandQueue, p.sessionId, neverAbort(), () =>
      serializeSessionMutation(
        session,
        JSON.stringify(['ui', actor.id, c.conn.clientId, p.requestSeq]),
        async () => {
          const matching = await scanNewest(
            session as unknown as ScannableSession,
            'x/agnes/ui-response',
            (event) =>
              event.actor.id === actor.id &&
              (event.data as { clientId?: unknown } | null)?.clientId === c.conn.clientId &&
              (event.data as { requestSeq?: unknown } | null)?.requestSeq === p.requestSeq,
          )
          if (matching) {
            const data = matching.data as { action?: unknown; data?: unknown }
            if (data.action === p.action && isDeepStrictEqual(data.data, p.data)) return { seq: matching.seq }
            throw rpcError('SEMANTIC_REJECTED', {
              reason: 'requestSeq already has a different response',
              requestSeq: p.requestSeq,
            })
          }
          // Build EventInput directly: the production RemoteSession is intentionally only a proxy for
          // append/scan/etc. and has no HostSession.ev convenience method.
          const written = await session.append([
            {
              type: 'x/agnes/ui-response',
              data: {
                clientId: c.conn.clientId,
                requestSeq: p.requestSeq,
                action: p.action,
                ...(p.data === undefined ? {} : { data: p.data }),
              },
              actor,
              origin: 'principal',
              trust: 'untrusted',
              ignorable: true,
            },
          ])
          return { seq: written.firstSeq }
        },
      ),
    )
  })

  const dispatch = async (
    kind: string,
    commandId: string,
    payload: Record<string, unknown>,
    c: CallContext,
    admissionId: string,
  ): Promise<JournalResult> => {
    const sessionId = String(payload.sessionId)
    switch (kind) {
      case 'steer':
      case 'followUp': {
        const entry = cx.registry.require(sessionId)
        let queued: QueuedActivationInvocation
        try {
          queued = cx.activationBarrier.enqueue('turn')
        } catch (error) {
          if (error instanceof ActivationInProgressError)
            throw rpcError('OVERLOADED', {
              reason: error.reason,
              operationId: error.operationId,
              retryAfterMs: 500,
            })
          throw error
        }
        // commandId goes into the ledger too. core's EnqueueMsg accepts it, and without it the second
        // layer this plan claims does not exist: the journal would be the only thing deduping.
        try {
          const invocation = await queued.start()
          return await invocation.run(async () => {
            const seq = await entry.session.enqueue(kind === 'steer' ? 'next-step' : 'next-turn', {
              content: payload.content as never,
              actor: connActor(c.conn),
              kind: kind === 'steer' ? 'steer' : 'follow_up',
              commandId,
              admissionId,
            })
            return { seq }
          })
        } finally {
          queued.cancel()
        }
      }
      case 'compact': {
        const entry = cx.registry.require(sessionId)
        let queued: QueuedActivationInvocation
        try {
          queued = cx.activationBarrier.enqueue('turn')
        } catch (error) {
          if (error instanceof ActivationInProgressError)
            throw rpcError('OVERLOADED', {
              reason: error.reason,
              operationId: error.operationId,
              retryAfterMs: 500,
            })
          throw error
        }
        try {
          const invocation = await queued.start()
          return await invocation.run(async () => {
            const markerSeq = await entry.session.requestCompaction({
              actor: connActor(c.conn),
              admissionId,
              ...(typeof payload.instructions === 'string' ? { instructions: payload.instructions } : {}),
            })
            const outcome = await entry.session.run({
              until: 'turn-end',
              signal: new AbortController().signal,
            })
            const endSeq = Math.max(markerSeq, outcome.lastSeq)
            return {
              seq: endSeq,
              compact: await compactOutcomeForRange(
                entry.session as unknown as ScannableSession,
                markerSeq,
                endSeq,
              ),
            }
          })
        } finally {
          queued.cancel()
        }
      }
      case 'fork':
        return cx.forkSession(
          sessionId,
          Number(payload.at),
          payload.childKey as string | undefined,
          c.conn.credential,
          c.conn.principalId,
        )
      case 'jobs.enqueue': {
        if (!cx.jobs) throw rpcError('CAPABILITY_DENIED', { method: 'jobs.enqueue' })
        return { result: await cx.jobs.enqueue(payload, { local: c.conn.authKind === 'local' }) }
      }
      default:
        // SubmitParams pins the five kinds, so the wire cannot reach this. It stands for a caller
        // inside this process that passes something else.
        throw rpcError('SEMANTIC_REJECTED', { reason: `unknown submit kind ${kind}` })
    }
  }

  const recover = async (
    kind: string,
    payload: Record<string, unknown>,
    admissionId: string,
    c: CallContext,
  ): Promise<JournalResult | undefined> => {
    if (kind === 'steer' || kind === 'followUp') {
      const entry = cx.registry.get(String(payload.sessionId))
      if (!entry) return undefined
      const event = await scanNewest(entry.session as unknown as ScannableSession, 'inbox', (candidate) =>
        ((candidate.data as { items?: Array<{ admissionId?: unknown }> } | null)?.items ?? []).some(
          (item) => item.admissionId === admissionId,
        ),
      )
      return event ? { seq: event.seq } : undefined
    }
    if (kind === 'compact') {
      const entry = cx.registry.get(String(payload.sessionId))
      if (!entry) return undefined
      const event = await scanNewest(
        entry.session as unknown as ScannableSession,
        'x/core/manual-compaction',
        (candidate) => (candidate.data as { admissionId?: unknown } | null)?.admissionId === admissionId,
      )
      if (!event) return undefined
      requireOwner('submit.compact', String(payload.sessionId), c)
      const outcome = await entry.session.run({
        until: 'turn-end',
        signal: new AbortController().signal,
      })
      const endSeq = Math.max(event.seq, outcome.lastSeq)
      return {
        seq: endSeq,
        compact: await compactOutcomeForRange(
          entry.session as unknown as ScannableSession,
          event.seq,
          endSeq,
        ),
      }
    }
    if (kind === 'jobs.enqueue' && cx.jobs && typeof payload.idempotencyKey === 'string') {
      try {
        await cx.jobs.poll(payload.idempotencyKey)
        return { result: { jobId: payload.idempotencyKey } }
      } catch {
        return undefined
      }
    }
    if (kind === 'fork' && typeof payload.childKey === 'string')
      return cx.forkSession(
        String(payload.sessionId),
        Number(payload.at),
        payload.childKey,
        c.conn.credential,
        c.conn.principalId,
      )
    return undefined
  }

  const installationId = (requested: string, c: CallContext): string =>
    c.conn.authKind && c.conn.authKind !== 'local' ? c.conn.principalId : requested

  const submit = async (
    clientId: string,
    commandId: string,
    kind: string,
    payload: Record<string, unknown>,
    c: CallContext,
    generation?: number,
  ): Promise<Ack> => {
    const sessionId = String(payload.sessionId ?? payload.sessionKey ?? `command:${commandId}`)
    if (
      kind === 'steer' ||
      kind === 'followUp' ||
      kind === 'compact' ||
      kind === 'fork' ||
      kind === 'jobs.enqueue'
    )
      requireOwner(`submit.${kind}`, sessionId, c)
    const guard = () => {
      requireOwner(`submit.${kind}`, sessionId, c)
      generationGuard(sessionId, generation)()
    }
    guard()
    // A remote caller must not select an exactly-once namespace with SubmitParams.clientId. Until
    // the wire carries a separately authenticated installation id, the verified principal is the
    // only server-bound stable installation identity available. Local Unix keeps its historical
    // multi-install clientId namespace for compatibility.
    const identity = {
      principalId: c.conn.principalId,
      clientId: installationId(clientId, c),
      sessionId,
      commandId,
    }
    const binding = commandBinding(kind, sessionId, generation, payload)
    const admissionId = commandAdmissionId(identity, binding)
    const st = await cx.journal.begin(identity, binding)
    if (st.state === 'complete') return { ...st.result, replayed: true } as Ack
    if (st.state === 'uncertain') {
      guard()
      const recovered = await recover(kind, payload, admissionId, c)
      if (!recovered) return { replayed: false, status: 'uncertain' }
      await cx.journal.complete(identity, recovered)
      return { ...recovered, replayed: true } as Ack
    }
    if (st.state === 'conflict') throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT' })
    if (st.state === 'corrupt') throw rpcError('INTERNAL_ERROR', { code: 'JOURNAL_CORRUPT' })
    let result: JournalResult
    try {
      result = await runQueued(
        cx.commandQueue,
        sessionId,
        neverAbort(),
        () => dispatch(kind, commandId, payload, c, admissionId),
        guard,
      )
    } catch (e) {
      // The row is released, not left half-open: an un-completed row answers 'uncertain' forever,
      // so one bad dispatch would burn that commandId for the life of the journal.
      await cx.journal.abandon(identity)
      throw e
    }
    await cx.journal.complete(identity, result)
    return { ...result, replayed: false } as Ack
  }

  const sugar = async (
    kind: 'steer' | 'followUp',
    params: unknown,
    c: CallContext,
  ): Promise<{ seq: number }> => {
    const p = params as { sessionId: string; content: unknown[]; commandId: string; generation?: number }
    const payload = { sessionId: p.sessionId, content: p.content }
    const a = await submit(c.conn.clientId, p.commandId, kind, payload, c, p.generation)
    if (a.status === 'uncertain') throw rpcError('INTERNAL_ERROR', { code: 'UNCERTAIN' })
    // SessionSteerResult requires an integer seq, so an absent one is not a result that can ship.
    // enqueue always answers with one today; saying so in the type keeps the answer from silently
    // becoming a RESULT_INVALID if some future dispatch does not.
    if (a.seq === undefined) throw rpcError('INTERNAL_ERROR', { code: 'NO_SEQ', kind })
    return { seq: a.seq }
  }

  // Local Unix keeps SubmitParams.clientId for compatibility. Remote connections bind it to their
  // verified identity inside submit, so a caller cannot choose a fresh exactly-once namespace.
  ep.register('_agnes/v1/submit', async (params, c) => {
    const p = params as {
      clientId: string
      commandId: string
      kind: string
      payload: Record<string, unknown>
      generation?: number
    }
    return submit(p.clientId, p.commandId, p.kind, p.payload, c, p.generation)
  })
  ep.register('_agnes/v1/submit.ack', async (params, c) => {
    const p = params as { clientId: string; sessionId: string; commandId: string }
    requireOwner('submit.ack', p.sessionId, c)
    await cx.journal.ack({
      principalId: c.conn.principalId,
      clientId: installationId(p.clientId, c),
      sessionId: p.sessionId,
      commandId: p.commandId,
    })
    return {}
  })
  ep.register('_agnes/v1/session.steer', (params, c) => sugar('steer', params, c))
  ep.register('_agnes/v1/session.followUp', (params, c) => sugar('followUp', params, c))
  ep.register('_agnes/v1/apis.list', async (_params, c) => {
    const pr = cx.host.profile
    // ResolvedProfile has no branding field. ApisListResult keeps `branding` optional, so it is simply
    // omitted here rather than read off a key that does not exist; host owns branding and has to
    // publish it before this can be filled.
    return {
      profile: {
        name: pr.name,
        resolvedProfileHash: pr.hash ?? null,
        presets: pr.presets,
        models: (pr.provider.routes ?? []).flatMap((route) =>
          (route.models ?? []).map((model) => ({
            route: route.route,
            id: model.id,
            ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
            ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
          })),
        ),
      },
      // The verifier writes these during initialize. Missing values fail closed for a bare endpoint
      // that somehow bypassed registerAcp/authGate.
      families: apisFamilies(cx, {
        authKind: c.conn.authKind ?? 'jwt',
        credentialKind: c.conn.credentialKind ?? 'jwt',
      }),
    }
  })

  ep.register('_agnes/v1/auth.claim', async (params, c) => {
    const p = params as {
      kind: string
      value: string
      expiresAtMs?: number
      limit?: number
      windowMs?: number
    }
    // principalId, not clientId. clientId comes from initialize._meta and is written by the client, so
    // bucketing on it would let the caller pick its own bucket and claim the same value twice.
    const bucket = `${c.conn.authKind ?? 'unauthenticated'}:${c.conn.principalId}:${p.kind}`
    const now = cx.clock()
    if (p.limit !== undefined && p.windowMs !== undefined)
      return cx.claims.withinRateLimit(bucket, p.value, p.limit, p.windowMs, now)
    return { granted: await cx.claims.once(bucket, p.value, p.expiresAtMs ?? now + 5 * 60_000, now) }
  })
}
