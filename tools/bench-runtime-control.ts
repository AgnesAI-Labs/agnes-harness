// Measures one shared set of turn inputs on the legacy ledger writer and on the
// state control path.
//
//   tsx tools/bench-runtime-control.ts --scenario k1 --mode baseline
//   tsx tools/bench-runtime-control.ts --campaign --rounds 20 --out samples.jsonl
//
// Candidate transaction time is the wall clock from the start of SQLite BEGIN to
// the return of COMMIT, observed by wrapping DatabaseSync.exec in this process.
// That is the same span storage.commit covers on the baseline, and it is the
// figure the commit-time gate uses. Call time wraps the public control method,
// so validation before BEGIN stays visible and is not the gate. The campaign
// leaves the in-process profiler off. approval-k1 and the nested scenario are
// reported as unmeasured.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { StorageAdapter } from '../packages/core/src/index.js'
import type { CommitTx } from '../packages/core/src/log/storage.js'
import { ToolRegistry } from '../packages/core/src/registry/tools.js'
import {
  actor,
  fakeProvider,
  openSession,
  readTool,
  type Script,
  sent,
  textTurn,
  usage,
} from '../packages/core/testkit/index.js'
import type {
  AdvanceRunRequest,
  CallContext,
  ClaimOutboxRequest,
  CloseInvocationRequest,
  CommitGuard,
  DispatchAdmissionRequest,
  InvocationAdmission,
  Outcome,
  PreparedAction,
  Receipt,
  ReceiptIntakeRequest,
  RunAdmission,
  StateAuthorityRef,
  UsageFact,
} from '../packages/extension-api/src/runtime/index.js'
import { createSqliteStorage } from '../packages/host/src/index.js'
import {
  createRuntimeStateStore,
  type RuntimeStateStore,
} from '../packages/host/src/runtime/providers/state.js'
import { canonicalJson } from '../packages/host/src/runtime/state/canonical-json.js'
import type { ControlPorts } from '../packages/host/src/runtime/state/control.js'
import {
  enterPhase,
  leavePhase,
  type ProfileSnapshot,
  resetProfile,
  setProfiling,
  snapshotProfile,
} from '../packages/host/src/runtime/state/profile.js'
import { digestOf, stableId } from '../packages/host/src/runtime/state/records.js'
import { type CommitNotice, RuntimeStateDatabase } from '../packages/host/src/runtime/state/transactions.js'
import { createAdmissionAcceptanceIssuer } from '../packages/host/test/helpers/runtime-admission-issuer.js'

const SEGMENT = 100
const CUT_FRAMES = 500
const AUTO_CHECKPOINT_FRAMES = 1000
const CLOCK_MS = 1_757_203_200_000
const ADMITTED_AT = '2026-04-01T00:00:00.000Z'
const DEADLINE = '2026-05-01T00:00:00.000Z'

export const MEASURED_SCENARIOS = ['k1', 'k4', 'k8', 'k16', 'chat'] as const
export const UNMEASURED_SCENARIOS = ['approval-k1', 'nested-m50+approval+abort'] as const
export type MeasuredScenario = (typeof MEASURED_SCENARIOS)[number]
export type Mode = 'baseline' | 'candidate'
export type ToolDispatchMode = 'each' | 'batch'

/** Candidate tool dispatch. `each` keeps one transaction per tool. `batch` is the measured shape. */
let toolDispatchMode: ToolDispatchMode = 'batch'

/** Rank used by the legacy ledger driver: index floor(p * n). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
}

export const TIMING_NOTE =
  'Candidate transaction time is BEGIN start through COMMIT return on DatabaseSync.exec, including in-transaction writes and the beforeCommit callback, excluding schema validation before BEGIN. Call time is the host method. Durability stays WAL, synchronous=NORMAL, and darwin checkpoint_fullfsync.'

export const BASELINE_ORACLE: Record<
  MeasuredScenario,
  { commits: number; rows: number; opCellBytes: number }
> = {
  k1: { commits: 19, rows: 36, opCellBytes: 4845 },
  k4: { commits: 25, rows: 51, opCellBytes: 26220 },
  k8: { commits: 33, rows: 71, opCellBytes: 86480 },
  k16: { commits: 49, rows: 111, opCellBytes: 317029 },
  chat: { commits: 10, rows: 19, opCellBytes: 1262 },
}

type ToolCall = { name: 'read'; args: { p: number } }
type ModelTurn = { kind: 'tools'; calls: ToolCall[] } | { kind: 'text'; text: string }

export type ScenarioInput = {
  name: MeasuredScenario
  userText: string
  offeredTools: ['read']
  modelTurns: ModelTurn[]
}

const userTextFor = (k: number): string => {
  if (k === 1) return 'one call'
  if (k === 4) return 'four calls'
  if (k === 8) return 'eight calls'
  if (k === 16) return 'sixteen calls'
  throw new Error(`no user text for k=${k}`)
}

const toolBatch = (k: number): ModelTurn => ({
  kind: 'tools',
  calls: Array.from({ length: k }, (_, ordinal) => ({ name: 'read' as const, args: { p: ordinal } })),
})

export function scenarioInput(name: string): ScenarioInput {
  if (name === 'chat') {
    return {
      name: 'chat',
      userText: 'one question',
      offeredTools: ['read'],
      modelTurns: [{ kind: 'text', text: 'done' }],
    }
  }
  const k = name === 'k1' ? 1 : name === 'k4' ? 4 : name === 'k8' ? 8 : name === 'k16' ? 16 : 0
  if (k === 0) throw new Error(`unknown measured scenario ${name}`)
  return {
    name: name as MeasuredScenario,
    userText: userTextFor(k),
    offeredTools: ['read'],
    modelTurns: [toolBatch(k), { kind: 'text', text: 'done' }],
  }
}

export function assertMeasuredSet(names: readonly string[]): void {
  for (const name of MEASURED_SCENARIOS) {
    if (!names.includes(name)) throw new Error(`missing scenario ${name}`)
  }
}

export type CommitRecord = {
  method: string
  requestId: string
  wrote: boolean
  /** preamble is outside the round. model and other non-tool writes are shared. */
  bucket: 'preamble' | 'shared' | 'model' | 'tool'
  toolKeys: string[]
  txMs: number
  callMs: number
}

export function reconcileAuthoritative(commits: readonly { wrote: boolean }[], attested: number): void {
  const wrote = commits.filter((commit) => commit.wrote).length
  if (wrote !== attested) {
    throw new Error(`commit counter ${wrote} does not match attested commits ${attested}`)
  }
}

export function assertToolWindows(commits: readonly CommitRecord[], toolKeys: readonly string[]): void {
  for (const key of toolKeys) {
    const methods = commits
      .filter((commit) => commit.wrote && commit.toolKeys.includes(key))
      .map((commit) => commit.method)
    for (const method of ['dispatchAdmission', 'intakeReceipt']) {
      if (!methods.includes(method)) throw new Error(`tool ${key} is missing ${method}`)
    }
  }
  if (!commits.some((commit) => commit.wrote && commit.method === 'claimOutbox')) {
    throw new Error('missing claim')
  }
  if (!commits.some((commit) => commit.wrote && commit.method === 'ackOutbox')) {
    throw new Error('missing ack')
  }
}

export type ToolWindow = {
  key: string
  exclusive: number
  shared: number
  amortized: number
  /** Exclusive commits plus shared commits that cover this tool. The gate uses this. */
  transactions: number
}

export type ClassifiedRound = {
  tools: ToolWindow[]
  tTool: number
  tShared: number
  tRound: number
  modelCommits: number
}

export function classifyCommits(commits: readonly CommitRecord[]): ClassifiedRound {
  const round = commits.filter((commit) => commit.wrote && commit.bucket !== 'preamble')
  const seen = new Set<string>()
  const keys: string[] = []
  for (const commit of round) {
    for (const key of commit.toolKeys) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  const tools = keys.map((key): ToolWindow => {
    const window = round.filter((commit) => commit.toolKeys.includes(key))
    const exclusive = window.filter((commit) => commit.toolKeys.length === 1).length
    const shared = window.filter((commit) => commit.toolKeys.length > 1).length
    const amortized = window.reduce((sum, commit) => sum + 1 / commit.toolKeys.length, 0)
    return { key, exclusive, shared, amortized, transactions: exclusive + shared }
  })
  const toolIds = new Set(
    round.filter((commit) => commit.toolKeys.length > 0).map((commit) => commit.requestId),
  )
  const roundIds = new Set(round.map((commit) => commit.requestId))
  return {
    tools,
    tTool: tools.reduce((max, tool) => Math.max(max, tool.transactions), 0),
    tShared: roundIds.size - toolIds.size,
    tRound: roundIds.size,
    modelCommits: round.filter((commit) => commit.bucket === 'model').length,
  }
}

export type LegacyPorts = { kind?: string; openSession?: unknown }

export function assertStateBackend(ports: LegacyPorts | undefined): void {
  if (ports && (ports.kind === 'legacy-kernel' || typeof ports.openSession === 'function')) {
    throw new Error('candidate refused the legacy kernel')
  }
}

let kernelSessions = 0

export function kernelSessionCount(): number {
  return kernelSessions
}

const say = (text: string) => ({ content: [{ type: 'text' as const, text }], actor })
const turnEnd = () => ({ until: 'turn-end' as const, signal: new AbortController().signal })

function scriptFor(turn: ModelTurn): Script {
  if (turn.kind === 'text') return textTurn(turn.text)
  return [
    sent(),
    ...turn.calls.map((call, ordinal) => ({
      type: 'toolcall_end' as const,
      call: { toolUseId: '', name: call.name, args: call.args, ordinal },
      via: 'native' as const,
    })),
    usage(),
    { type: 'done' as const, reason: 'toolUse' as const },
  ]
}

function registryOf(tool: unknown): ToolRegistry {
  const registry = new ToolRegistry()
  registry.add(tool as never, { source: 's', trust: 'builtin' })
  return registry
}

const ROW_BYTES = `COALESCE(LENGTH(session_key),0)+8+LENGTH(ts)+LENGTH(id)+LENGTH(type)+LENGTH(lane)+8+LENGTH(actor)+
  LENGTH(origin)+LENGTH(trust)+COALESCE(LENGTH(register),0)+COALESCE(LENGTH(surface_op),0)+
  COALESCE(LENGTH(source_event_seqs),0)+LENGTH(data)+COALESCE(LENGTH(integrity_mode),0)+
  COALESCE(LENGTH(integrity_prev),0)+COALESCE(LENGTH(integrity_digest),0)`

type Op = { phase: { kind: string; batch?: { calls: Array<Record<string, unknown>> } } } | null
const TRACKED = ['status', 'dispatchPhase', 'dispatchAttempt'] as const

function movedCalls(prev: Op, next: Op): string[] {
  if (prev?.phase.kind !== 'tools' || next?.phase.kind !== 'tools') return []
  const before = new Map((prev.phase.batch?.calls ?? []).map((call) => [call.toolUseId, call]))
  return (next.phase.batch?.calls ?? [])
    .filter((call) => {
      const was = before.get(call.toolUseId)
      return !was || TRACKED.some((field) => was[field] !== call[field])
    })
    .map((call) => String(call.toolUseId))
}

type WalProbe = {
  pageSize: number
  note(wrote: boolean): void
  finish(): { walBytes: number; walSegments: number; walMaxFrames: number }
  close(): void
}

function openWalProbe(file: string): WalProbe {
  const side = new DatabaseSync(file)
  const pageSize = (side.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
  let walBytes = 0
  let walSegments = 0
  let walMaxFrames = 0
  let written = 0
  const walSize = () => statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0
  const framesOf = (size: number) => (size > 32 ? Math.round((size - 32) / (pageSize + 24)) : 0)
  const cut = () => {
    const size = walSize()
    const frames = framesOf(size)
    walMaxFrames = Math.max(walMaxFrames, frames)
    walBytes += size
    walSegments++
    const checkpoint = side.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
    if (checkpoint.busy !== 0) throw new Error('WAL checkpoint was blocked')
  }
  cut()
  walBytes = 0
  walSegments = 0
  return {
    pageSize,
    note(_wrote: boolean) {
      // Every COMMIT advances the segment, including a wrote:false commit. The baseline passes
      // true for each storage.commit. Frames from an idle commit still belong in the next cut.
      written += 1
      if (written % SEGMENT === 0 || framesOf(walSize()) >= CUT_FRAMES) cut()
    },
    finish() {
      cut()
      if (walMaxFrames >= AUTO_CHECKPOINT_FRAMES) {
        throw new Error(`a WAL segment reached ${walMaxFrames} frames; the measure is not exact`)
      }
      return { walBytes, walSegments, walMaxFrames }
    },
    close() {
      side.close()
    },
  }
}

export type Sample = {
  mode: Mode
  scenario: string
  status: 'measured'
  pageSize: number
  commits: number
  rows?: number
  opCellBytes?: number
  rowsByType?: Record<string, number>
  walBytes: number
  walSegments: number
  walMaxFrames: number
  commitMs: { p50: number; p95: number; max: number; total: number }
  callMs?: { p50: number; p95: number; max: number; total: number }
  wallMs: number
  tTool?: number
  tShared?: number
  tRound?: number
  modelCommits?: number
  tools?: ToolWindow[]
  bytes?: ByteReport
  commitsDetail?: CommitRecord[]
  timingNote?: string
  dispatchMode?: ToolDispatchMode
  backend: 'legacy-kernel' | 'state'
}

const roundMs = (ms: number) => Math.round(ms * 1000) / 1000

function timingOf(values: number[]): { p50: number; p95: number; max: number; total: number } {
  return {
    p50: roundMs(percentile(values, 0.5)),
    p95: roundMs(percentile(values, 0.95)),
    max: roundMs(values.length === 0 ? 0 : Math.max(...values)),
    total: roundMs(values.reduce((sum, value) => sum + value, 0)),
  }
}

export async function runBaseline(name: string): Promise<Sample> {
  const spec = scenarioInput(name)
  const directory = mkdtempSync(join(tmpdir(), 'agnes-bench-rc-base-'))
  const file = join(directory, 'sessions.db')
  const kernelBefore = kernelSessions
  try {
    const storage = createSqliteStorage({ file, tablesDir: join(directory, 'tables') })
    const probe = openWalProbe(file)
    let counting = false
    let commits = 0
    let opCellBytes = 0
    const commitMs: number[] = []
    const lastOp = new Map<string, Op>()
    const counted = new Proxy(storage, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (property === 'commit') {
          return (key: string, tx: CommitTx) => {
            const started = performance.now()
            const result = (value as StorageAdapter['commit']).call(target, key, tx)
            const elapsed = performance.now() - started
            if (counting) {
              commits += 1
              commitMs.push(elapsed)
              if (tx.opState) {
                opCellBytes += JSON.stringify(tx.opState.data).length
                const lane = `${key}\u0000${tx.opState.lane}`
                movedCalls(lastOp.get(lane) ?? null, tx.opState.data as Op)
                lastOp.set(lane, tx.opState.data as Op)
              }
            }
            probe.note(true)
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const open = async (over: Record<string, unknown>) => {
      kernelSessions += 1
      const opened = await openSession({
        ...over,
        storage: counted as never,
        clock: () => CLOCK_MS,
      })
      counting = true
      return opened
    }
    const started = performance.now()
    const session = await open({
      provider: fakeProvider(spec.modelTurns.map(scriptFor)),
      registry: registryOf(readTool()),
    })
    await session.session.enqueue('next-turn', say(spec.userText))
    await session.session.run(turnEnd())
    const wallMs = performance.now() - started
    await storage.close()
    const wal = probe.finish()
    probe.close()
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const rowsByType: Record<string, number> = {}
      for (const row of db
        .prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY type')
        .all() as Array<{
        type: string
        n: number
      }>) {
        rowsByType[row.type] = row.n
      }
      const all = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
      if (kernelSessions === kernelBefore) throw new Error('baseline did not open the legacy kernel')
      return {
        mode: 'baseline',
        scenario: spec.name,
        status: 'measured',
        pageSize: probe.pageSize,
        commits,
        rows: all.n,
        opCellBytes,
        rowsByType,
        ...wal,
        commitMs: timingOf(commitMs),
        wallMs: roundMs(wallMs),
        backend: 'legacy-kernel',
      }
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const authority: StateAuthorityRef = { authorityId: 'authority-1', tenantId: 'tenant-1', authorityEpoch: 1 }
const scope = { installationId: 'install-1', kind: 'installation' as const }
const toolBinding = {
  bindingId: 'binding-1',
  contract: 'agh.test/tool',
  logicalName: 'tool',
  providerId: 'provider-1',
}
const externalRequest = { system: 'ext', requestId: 'ext-1', requestDigest: 'e'.repeat(64) }
const schemaDocument = { $id: 'agh.test/json@1', type: 'object' }

function inline(value: unknown) {
  const canonical = canonicalJson(value)
  return {
    kind: 'inline' as const,
    schema: { typeId: 'agh.test/json@1', revision: 1, digest: digestOf(schemaDocument) },
    value,
    digest: digestOf(value),
    bytes: Buffer.byteLength(canonical),
  }
}

function callContext(): CallContext {
  return {
    principalRef: 'principal-1',
    scope,
    bindingId: 'binding-1',
    invocationId: 'invocation-bench',
    deadline: DEADLINE,
    traceRef: 'trace-bench',
    authorizationRef: 'auth-bench',
    signal: new AbortController().signal,
  }
}

function admissionFor(text: string): RunAdmission {
  const ticketId = 'ticket-1'
  return {
    ticketId,
    fingerprint: digestOf({ ticketId, text }),
    releaseSetId: 'release-1',
    bindingId: 'binding-1',
    packagePinReceipt: inline({ pin: 'package' }),
    runId: 'run-1',
    sessionId: 'session-1',
    lane: 'main',
    workspaceId: 'workspace-1',
    input: inline({ text }),
    admittedAt: ADMITTED_AT,
    deadline: DEADLINE,
    conversation: null,
  }
}

function commitGuard(invocationId: string, expectedRunRevision: number): CommitGuard {
  return {
    authority,
    sessionId: 'session-1',
    runId: 'run-1',
    writerId: 'writer-a',
    writerEpoch: 1,
    expectedRunRevision,
    bindingId: 'binding-1',
    invocationId,
    readGuards: [],
    queryUsage: null,
  }
}

function continuation(phase: string, cursor: number) {
  return {
    namespace: 'agh.runtime/control-bench',
    codecVersion: '1',
    data: inline({ phase, cursor }),
    provenance: { sourceRefs: [] as string[], producer: toolBinding, trustLabels: [] as string[] },
    createdAt: ADMITTED_AT,
    references: [],
  }
}

function preparedAction(key: string, inputValue: unknown): PreparedAction {
  const input = inline(inputValue)
  const body = {
    key,
    target: toolBinding,
    method: 'run',
    input,
    dependencies: [],
    retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] as number[] },
    obligation: 'mandatory' as const,
    deadline: DEADLINE,
    resultSchema: input.schema,
    references: [],
  }
  return { ...body, intentFingerprint: digestOf(body) }
}

/** Source owned by this local, non-billable benchmark adapter, never a production settlement owner. */
export function createBenchmarkUsageSource(producer: typeof toolBinding = toolBinding) {
  const originals = new Map<string, string>()
  return {
    observe(request: DispatchAdmissionRequest, authorizationId: string, intake: ReceiptIntakeRequest): void {
      if (
        request.budget.reservation !== null ||
        intake.sourceAuthorizationRef !== authorizationId ||
        intake.receipt.actionId !== request.actionId ||
        intake.receipt.attemptId !== request.attemptId ||
        intake.receipt.bindingId !== request.guard.bindingId ||
        intake.evidence.length !== 0
      )
        throw new Error('benchmark usage source does not prove an unreserved local dispatch')
      for (const fact of intake.usage) {
        if (
          fact.actionId !== request.actionId ||
          fact.attemptId !== request.attemptId ||
          canonicalJson(fact.source) !== canonicalJson(producer) ||
          !intake.receipt.usageRefs.includes(fact.usageId)
        )
          throw new Error('benchmark usage differs from the actual local producer')
        const original = canonicalJson({ fact, receipt: intake.receipt, evidence: intake.evidence })
        const prior = originals.get(fact.originKey)
        if (prior && prior !== original) throw new Error('benchmark usage source identity conflicts')
        originals.set(fact.originKey, original)
      }
    },
    verify: ((fact, receipt, evidence) =>
      originals.get(fact.originKey) === canonicalJson({ fact, receipt, evidence })
        ? { settlementRef: null }
        : undefined) satisfies NonNullable<ControlPorts['verifyUsageSettlement']>,
  }
}

const benchmarkUsageSources = new WeakMap<RuntimeStateStore, ReturnType<typeof createBenchmarkUsageSource>>()
function observeBenchmarkUsage(
  store: RuntimeStateStore,
  request: DispatchAdmissionRequest,
  authorizationId: string,
  intake: ReceiptIntakeRequest,
): void {
  const source = benchmarkUsageSources.get(store)
  if (!source) throw new Error('benchmark usage source owner is absent')
  source.observe(request, authorizationId, intake)
}

const originalExec = DatabaseSync.prototype.exec

async function measureCall<T>(body: () => Promise<T>): Promise<{ value: T; txMs: number; callMs: number }> {
  const started = performance.now()
  let beginAt: number | null = null
  let txMs = 0
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    const text = String(sql).trimStart()
    if (beginAt === null && /^BEGIN\b/i.test(text)) {
      beginAt = performance.now()
      return originalExec.call(this, sql)
    }
    if (beginAt !== null && /^COMMIT\b/i.test(text)) {
      const result = originalExec.call(this, sql)
      txMs += performance.now() - beginAt
      beginAt = null
      return result
    }
    if (beginAt !== null && /^ROLLBACK\b/i.test(text)) {
      beginAt = null
      return originalExec.call(this, sql)
    }
    return originalExec.call(this, sql)
  }
  try {
    const value = await body()
    return { value, txMs, callMs: performance.now() - started }
  } finally {
    DatabaseSync.prototype.exec = originalExec
  }
}

function unwrap<T>(result: Outcome<T>, label: string): T {
  if (!result.ok) {
    throw new Error(`${label}: ${result.error.code}/${result.error.detailCode} ${result.error.message}`)
  }
  return result.value
}

type ActionSlot = { key: string; action: PreparedAction; receiptId: string; toolKeys: string[] }

function toolAdmission(invocationId: string, revision: number, slot: ActionSlot): DispatchAdmissionRequest {
  const admissionId = `admission-${slot.key}`
  return {
    admissionId,
    commitId: `commit-${admissionId}`,
    guard: commitGuard(invocationId, revision),
    atomicDomain: {
      domainId: 'domain-1',
      revision: 1,
      stateAuthority: authority,
      budgetAuthority: authority,
      stateBinding: {
        bindingId: 'binding-1',
        contract: 'agh.runtime/run-admission',
        logicalName: 'run',
        providerId: 'runtime-state',
      },
      budgetBinding: {
        bindingId: 'binding-1',
        contract: 'agh.runtime/run-admission',
        logicalName: 'run',
        providerId: 'runtime-state',
      },
    },
    actionId: stableId('act', `run-1\0${slot.key}`),
    expectedActionRevision: 1,
    decisionRef: inline({ allow: admissionId }),
    attemptId: `attempt-${admissionId}`,
    requestIdentity: {
      system: 'tool',
      aghRequestId: `agh-${admissionId}`,
      idempotencyKey: null,
      requestDigest: digestOf(slot.action.input),
    },
    budget: { reservation: null, quota: [{ name: 'parallel-action', amount: 1 }] },
    deadline: DEADLINE,
  }
}

async function runAction(
  store: RuntimeStateStore,
  record: (commit: CommitRecord) => void,
  invocationId: string,
  revision: number,
  slot: ActionSlot,
  bucket: 'model' | 'tool',
  result: unknown,
): Promise<void> {
  const request = toolAdmission(invocationId, revision, slot)
  const admitted = unwrap(
    await timed(record, 'dispatchAdmission', request.admissionId, bucket, slot.toolKeys, () =>
      store.dispatchAdmission(request, callContext()),
    ),
    `dispatch ${slot.key}`,
  )
  if (admitted.state !== 'admitted') throw new Error(`dispatch ${slot.key} was not admitted`)
  const actionId = stableId('act', `run-1\0${slot.key}`)
  const usageFact: UsageFact = {
    usageId: `usage-${slot.key}`,
    originKey: `origin-${slot.key}`,
    actionId,
    attemptId: request.attemptId,
    source: toolBinding,
    dimensions: inline({ tokens: 1 }),
    externalRequest,
    observedAt: ADMITTED_AT,
    certainty: 'measured',
  }
  const receipt: Receipt = {
    receiptId: slot.receiptId,
    actionId,
    attemptId: request.attemptId,
    bindingId: 'binding-1',
    inputDigest: digestOf(slot.action.input),
    outcome: 'succeeded',
    result: inline(result),
    externalRequests: [],
    usageRefs: [usageFact.usageId],
    references: [],
    provenance: { sourceRefs: [], producer: toolBinding, trustLabels: [] },
    completedAt: ADMITTED_AT,
  }
  const intake: ReceiptIntakeRequest = {
    intakeId: `intake-${slot.key}`,
    receipt,
    usage: [usageFact],
    evidence: [],
    sourceAuthorizationRef: admitted.authorizationId,
    queryUsage: null,
    resultHandling: { kind: 'no-hook' },
  }
  observeBenchmarkUsage(store, request, admitted.authorizationId, intake)
  unwrap(
    await timed(record, 'intakeReceipt', intake.intakeId, bucket, slot.toolKeys, () =>
      store.intakeReceipt(intake, callContext()),
    ),
    `intake ${slot.key}`,
  )
}

async function runToolBatch(
  store: RuntimeStateStore,
  record: (commit: CommitRecord) => void,
  invocationId: string,
  revision: number,
  ordinal: number,
  slots: readonly ActionSlot[],
): Promise<void> {
  const requests = slots.map((slot) => toolAdmission(invocationId, revision, slot))
  const admitted = unwrap(
    await timed(
      record,
      'dispatchAdmission',
      `tools-${ordinal}`,
      'tool',
      slots.map((slot) => slot.key),
      () => store.commitDispatchBatch(`commit-tools-${ordinal}`, requests, callContext()),
    ),
    `dispatch tools-${ordinal}`,
  )
  if (admitted.length !== slots.length)
    throw new Error(`dispatch tools-${ordinal} returned ${admitted.length}`)
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]
    const result = admitted[index]
    if (!slot || !result || result.state !== 'admitted')
      throw new Error(`dispatch ${slot?.key ?? index} was not admitted`)
    const actionId = stableId('act', `run-1\0${slot.key}`)
    const usageFact: UsageFact = {
      usageId: `usage-${slot.key}`,
      originKey: `origin-${slot.key}`,
      actionId,
      attemptId: requests[index]?.attemptId ?? '',
      source: toolBinding,
      dimensions: inline({ tokens: 1 }),
      externalRequest,
      observedAt: ADMITTED_AT,
      certainty: 'measured',
    }
    const intake: ReceiptIntakeRequest = {
      intakeId: `intake-${slot.key}`,
      receipt: {
        receiptId: slot.receiptId,
        actionId,
        attemptId: requests[index]?.attemptId ?? '',
        bindingId: 'binding-1',
        inputDigest: digestOf(slot.action.input),
        outcome: 'succeeded',
        result: inline({ text: 'read' }),
        externalRequests: [],
        usageRefs: [usageFact.usageId],
        references: [],
        provenance: { sourceRefs: [], producer: toolBinding, trustLabels: [] },
        completedAt: ADMITTED_AT,
      },
      usage: [usageFact],
      evidence: [],
      sourceAuthorizationRef: result.authorizationId,
      queryUsage: null,
      resultHandling: { kind: 'no-hook' },
    }
    const dispatched = requests[index]
    if (!dispatched) throw new Error('benchmark source dispatch is absent')
    observeBenchmarkUsage(store, dispatched, result.authorizationId, intake)
    unwrap(
      await timed(record, 'intakeReceipt', intake.intakeId, 'tool', slot.toolKeys, () =>
        store.intakeReceipt(intake, callContext()),
      ),
      `intake ${slot.key}`,
    )
  }
}

async function timed<T>(
  record: (commit: CommitRecord) => void,
  method: string,
  requestId: string,
  bucket: CommitRecord['bucket'],
  toolKeys: string[],
  body: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  let notice: CommitNotice | undefined
  const previous = storeNotice
  storeNotice = (commit) => {
    notice = commit
  }
  try {
    const measured = await measureCall(body)
    if (!notice) {
      if (
        measured.value &&
        typeof measured.value === 'object' &&
        'ok' in measured.value &&
        'error' in measured.value &&
        !measured.value.ok
      )
        throw new Error(`${method} ${requestId}: ${JSON.stringify(measured.value.error)}`)
      throw new Error(`${method} ${requestId} produced no commit notice`)
    }
    if (notice.wrote && measured.txMs <= 0) {
      throw new Error(`${method} ${requestId} wrote a commit with no BEGIN/COMMIT span`)
    }
    record({
      method: notice.method,
      requestId: notice.requestId,
      wrote: notice.wrote,
      bucket,
      toolKeys,
      txMs: measured.txMs,
      callMs: measured.callMs,
    })
    return measured.value
  } finally {
    storeNotice = previous
  }
}

let storeNotice: ((commit: CommitNotice) => void) | undefined

async function advance(
  store: RuntimeStateStore,
  record: (commit: CommitRecord) => void,
  revision: number,
  phase: string,
  actions: PreparedAction[],
  consume: string[],
): Promise<number> {
  const invocationId = `inv-${phase}`
  const admit: InvocationAdmission = {
    requestId: `admit-${invocationId}`,
    runId: 'run-1',
    targetActionId: null,
    baseRevision: revision,
    bindingId: 'binding-1',
    writerEpoch: 1,
    invocationId,
    deadline: DEADLINE,
    queryAllowance: 0,
  }
  const close: CloseInvocationRequest = {
    requestId: `close-${invocationId}`,
    invocationId,
    state: 'prepared',
    readGuards: [],
    domainReads: [],
    unresolvedInflightIds: [],
    observedQueryCount: 0,
  }
  const request: AdvanceRunRequest = {
    commitId: `advance-${phase}`,
    guard: commitGuard(invocationId, revision),
    transition: {
      expectedRevision: revision,
      continuation: continuation(phase, revision + 1),
      consumeSignals: consume,
      actions,
      next: { kind: 'continue' },
    },
  }
  const committed = unwrap(
    await timed(record, 'commitPreparedAdvance', request.commitId, 'shared', [], () =>
      store.commitPreparedAdvance(request.commitId, admit, close, request, callContext()),
    ),
    `advance ${phase}`,
  )
  return committed.runRevision
}

function signalId(receiptId: string): string {
  return stableId('sig', `${authority.authorityId}\0${receiptId}\0run`)
}

async function drainOutbox(store: RuntimeStateStore, record: (commit: CommitRecord) => void): Promise<void> {
  const destination = stableId('obxdst', authority.authorityId)
  for (let batch = 0; batch < 100; batch += 1) {
    const request: ClaimOutboxRequest = {
      requestId: `claim-${batch}`,
      destination,
      ownerId: 'owner-1',
      limit: 10_000,
      leaseMs: 60_000,
    }
    const claimed = unwrap(
      await timed(record, 'claimOutbox', request.requestId, 'shared', [], () =>
        store.claimOutbox(request, callContext()),
      ),
      `claim ${batch}`,
    )
    if (claimed.length === 0) return
    const acks = claimed.map((item, index) => ({
      requestId: `ack-${batch}-${index}`,
      claim: item.claim,
      acknowledgement: inline({ acked: true }),
    }))
    unwrap(
      await timed(record, 'ackOutbox', `ack-${batch}`, 'shared', [], () =>
        store.ackOutboxMany(acks, callContext()),
      ),
      `ack ${batch}`,
    )
  }
  throw new Error('outbox did not drain')
}

export type ByteReport = {
  versionBodyBytes: number
  versionBodyBySchema: Record<string, number>
  manifestBytes: number
  sideEntryBytes: number
  ledgerProof: {
    stateCommitRowBytes: number
    formatRowBytes: number
    stateCommitPayload: number
    formatPayload: number
  }
  indexBytes: Record<string, number>
  auxiliary: Record<string, { payloadBytes: number; indexBytes: number }>
  headPayloadBytes: number
  packedProofBytes: number
  versionBodyPhysicalBytes: number
  headPhysicalBytes: number
  tablePages: Record<string, number>
  continuationBytes: number
  continuationVersions: number
  providerState: { present: false; note: string } | { present: true; bytes: number }
  pageSize: number
}

const AUXILIARY = [
  'runtime_request_results',
  'runtime_signal_seq',
  'runtime_active_invocation_target',
  'runtime_leases',
  'runtime_session_meta',
  'runtime_dispatch_domains',
  'runtime_outbox_delivery',
  'runtime_admissions',
  'runtime_aux_commits',
  'runtime_commit_fingerprints',
]

function scalar(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

function payloadOf(db: DatabaseSync, table: string): number {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>
  const text = columns.filter((column) => column.type === '' || /CHAR|CLOB|TEXT|BLOB/i.test(column.type))
  if (text.length === 0) return 0
  const expression = text.map((column) => `COALESCE(LENGTH("${column.name}"),0)`).join('+')
  const row = db.prepare(`SELECT COALESCE(SUM(${expression}),0) AS n FROM "${table}"`).get() as { n: number }
  return row.n
}

function eventRowBytes(db: DatabaseSync, type: string): { rows: number; payload: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(${ROW_BYTES}),0) AS b, COALESCE(SUM(LENGTH(data)),0) AS p FROM events WHERE type = ?`,
    )
    .get(type) as { n: number; b: number; p: number }
  return { rows: row.n, payload: row.p }
}

export function readByteReport(file: string, pageSize: number): ByteReport {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const versions = db
      .prepare(
        `SELECT record_id, schema_json, value_json, owner_json, digest, commit_id
         FROM runtime_record_versions`,
      )
      .all() as Array<{
      record_id: string
      schema_json: string
      value_json: string
      owner_json: string
      digest: string
      commit_id: string
    }>
    const versionBodyBySchema: Record<string, number> = {}
    let versionBodyBytes = 0
    let continuationBytes = 0
    let continuationVersions = 0
    let providerBytes = 0
    let providerPresent = false
    for (const version of versions) {
      const bytes =
        version.schema_json.length +
        version.value_json.length +
        version.owner_json.length +
        version.digest.length +
        version.commit_id.length +
        version.record_id.length
      versionBodyBytes += bytes
      // A version row stores a SchemaRef. Its typeId is the codec id; document $id is not on the row.
      const parsed = JSON.parse(version.schema_json) as { $id?: string; typeId?: string }
      const schema = parsed.$id ?? parsed.typeId ?? 'unknown'
      versionBodyBySchema[schema] = (versionBodyBySchema[schema] ?? 0) + bytes
      if (version.record_id.startsWith('run:')) {
        const value = JSON.parse(version.value_json) as { continuation?: unknown }
        continuationBytes += Buffer.byteLength(canonicalJson(value.continuation))
        continuationVersions += 1
      }
      if (version.record_id.includes('provider-state') || version.record_id.startsWith('provider:')) {
        providerPresent = true
        providerBytes += bytes
      }
      if (version.record_id.startsWith('action:')) {
        const value = JSON.parse(version.value_json) as { providerStateId?: unknown }
        if (value.providerStateId != null) {
          providerPresent = true
          providerBytes += bytes
        }
      }
    }
    const indexes = db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{
      name: string
      tbl_name: string
    }>
    const indexBytes: Record<string, number> = {}
    for (const index of indexes) {
      const row = db
        .prepare('SELECT COALESCE(SUM(pgsize),0) AS n FROM dbstat WHERE name = ?')
        .get(index.name) as {
        n: number
      }
      indexBytes[index.name] = row.n
    }
    const auxiliary: ByteReport['auxiliary'] = {}
    for (const table of AUXILIARY) {
      const indexTotal = indexes
        .filter((index) => index.tbl_name === table)
        .reduce((sum, index) => sum + (indexBytes[index.name] ?? 0), 0)
      auxiliary[table] = { payloadBytes: payloadOf(db, table), indexBytes: indexTotal }
    }
    const stateCommit = eventRowBytes(db, 'runtime/state-commit')
    const format = eventRowBytes(db, 'runtime/format')
    const stateRow = db
      .prepare(`SELECT COALESCE(SUM(${ROW_BYTES}),0) AS n FROM events WHERE type = 'runtime/state-commit'`)
      .get() as { n: number }
    const formatRow = db
      .prepare(`SELECT COALESCE(SUM(${ROW_BYTES}),0) AS n FROM events WHERE type = 'runtime/format'`)
      .get() as { n: number }
    return {
      versionBodyBytes,
      versionBodyBySchema,
      manifestBytes: scalar(
        db,
        `SELECT COALESCE(SUM(LENGTH(commit_id) + LENGTH(record_id) + COALESCE(LENGTH(next_json), 0)), 0) AS n
           FROM runtime_mutation_manifests`,
      ),
      sideEntryBytes: scalar(
        db,
        `SELECT COALESCE(SUM(LENGTH(commit_id) + LENGTH(kind) + LENGTH(identity) + LENGTH(entry_json)), 0) AS n
           FROM runtime_side_entries`,
      ),
      ledgerProof: {
        stateCommitRowBytes: stateRow.n,
        formatRowBytes: formatRow.n,
        stateCommitPayload: stateCommit.payload,
        formatPayload: format.payload,
      },
      indexBytes,
      auxiliary,
      headPayloadBytes: scalar(
        db,
        `SELECT COALESCE(SUM(
            LENGTH(record_id) + LENGTH(schema_json) + LENGTH(last_commit_id) + LENGTH(created_at) +
            LENGTH(updated_at) + LENGTH(owner_json) + LENGTH(value_json) + LENGTH(body_digest)
          ), 0) AS n FROM runtime_records`,
      ),
      packedProofBytes: scalar(
        db,
        `SELECT COALESCE(SUM(
            LENGTH(commit_id) + LENGTH(manifests_json) + LENGTH(sides_json) + LENGTH(versions_json)
          ), 0) AS n FROM runtime_commit_proofs`,
      ),
      versionBodyPhysicalBytes: scalar(
        db,
        `SELECT COALESCE(SUM(LENGTH(record_id) + LENGTH(value_json)), 0) AS n FROM runtime_version_bodies`,
      ),
      tablePages: Object.fromEntries(
        (
          db.prepare('SELECT name, COALESCE(SUM(pgsize), 0) AS n FROM dbstat GROUP BY name').all() as Array<{
            name: string
            n: number
          }>
        ).map((row) => [row.name, row.n]),
      ),
      headPhysicalBytes: scalar(
        db,
        `SELECT COALESCE(SUM(
            LENGTH(record_id) + LENGTH(schema_json) + LENGTH(last_commit_id) + LENGTH(created_at) +
            LENGTH(updated_at) + LENGTH(owner_json) + LENGTH(body_digest)
          ), 0) AS n FROM runtime_record_heads`,
      ),
      continuationBytes,
      continuationVersions,
      providerState: providerPresent
        ? { present: true, bytes: providerBytes }
        : {
            present: false,
            note: 'this prototype stores no ProviderState record; action.providerStateId stays null',
          },
      pageSize,
    }
  } finally {
    db.close()
  }
}

/** Authoritative commits are `runtime/state-commit` events plus one aux token for each
 * claim, ack, or fail transaction. Those call `noteWrite` and COMMIT without a state-commit.
 * An empty claim stores `[]` and does not note a write, so it stays out of both sides. */
function attestedCommits(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM events WHERE type = 'runtime/state-commit')
           + (SELECT COUNT(*) FROM runtime_aux_commits) AS n`,
      )
      .get() as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

/** Install and issue on the original State connection before starting any measurement. */
async function openBenchmarkState(file: string, text: string) {
  const frozen = Date.parse(ADMITTED_AT)
  const usageSource = createBenchmarkUsageSource()
  const options = {
    verifyUsageSettlement: usageSource.verify,
    file,
    authority,
    now: () => frozen,
    onCommit: (commit: CommitNotice) => storeNotice?.(commit),
  }
  const database = new RuntimeStateDatabase(options)
  try {
    const issuer = createAdmissionAcceptanceIssuer(database, authority, options.now)
    try {
      const store = createRuntimeStateStore(options, database)
      benchmarkUsageSources.set(store, usageSource)
      const admission = admissionFor(text)
      const context = await issuer.issue(admission, callContext())
      return {
        store,
        admission,
        context,
        close() {
          issuer.close()
          store.close()
        },
      }
    } catch (error) {
      issuer.close()
      throw error
    }
  } catch (error) {
    database.close()
    throw error
  }
}

export async function runCandidate(name: string, ports?: LegacyPorts): Promise<Sample> {
  assertStateBackend(ports)
  const spec = scenarioInput(name)
  const kernelBefore = kernelSessions
  const directory = mkdtempSync(join(tmpdir(), 'agnes-bench-rc-state-'))
  const file = join(directory, 'state.sqlite')
  const commits: CommitRecord[] = []
  try {
    const benchmark = await openBenchmarkState(file, spec.userText)
    const { store, admission, context } = benchmark
    const probe = openWalProbe(file)
    const record = (commit: CommitRecord) => {
      commits.push(commit)
      probe.note(commit.wrote)
    }
    const started = performance.now()
    try {
      unwrap(
        await timed(record, 'createRun', 'ticket-1', 'preamble', [], () =>
          store.createRun(admission, context),
        ),
        'createRun',
      )
      unwrap(
        await timed(record, 'open', 'open-write', 'preamble', [], () =>
          store.open(
            {
              requestId: 'open-write',
              authority,
              sessionId: 'session-1',
              mode: 'write',
              writerId: 'writer-a',
              ttlMs: 60_000,
            },
            callContext(),
          ),
        ),
        'open',
      )
      let revision = 0
      let modelOrdinal = 0
      let pendingTools: ToolCall[] = []
      for (const turn of spec.modelTurns) {
        const phase = `model-${modelOrdinal}`
        const modelKey = phase
        const modelAction = preparedAction(modelKey, {
          role: 'model',
          offered: spec.offeredTools,
          userText: spec.userText,
          cursor: modelOrdinal,
        })
        revision = await advance(
          store,
          record,
          revision,
          phase,
          [modelAction],
          modelOrdinal === 0 ? [] : pendingTools.map((call) => signalId(`receipt-read:${call.args.p}`)),
        )
        pendingTools = []
        const modelResult = turn.kind === 'tools' ? { calls: turn.calls } : { text: turn.text }
        await runAction(
          store,
          record,
          `inv-${phase}`,
          revision,
          { key: modelKey, action: modelAction, receiptId: `receipt-${modelKey}`, toolKeys: [] },
          'model',
          modelResult,
        )
        if (turn.kind === 'tools') {
          const actions = turn.calls.map((call) =>
            preparedAction(`read:${call.args.p}`, { name: call.name, args: call.args }),
          )
          revision = await advance(store, record, revision, `tools-${modelOrdinal}`, actions, [
            signalId(`receipt-${modelKey}`),
          ])
          const slots: ActionSlot[] = turn.calls.map((call) => {
            const key = `read:${call.args.p}`
            const action = actions.find((item) => item.key === key)
            if (!action) throw new Error(`missing prepared action ${key}`)
            return { key, action, receiptId: `receipt-${key}`, toolKeys: [key] }
          })
          if (toolDispatchMode === 'batch') {
            await runToolBatch(store, record, `inv-tools-${modelOrdinal}`, revision, modelOrdinal, slots)
          } else {
            for (const slot of slots) {
              await runAction(store, record, `inv-tools-${modelOrdinal}`, revision, slot, 'tool', {
                text: 'read',
              })
            }
          }
          pendingTools = turn.calls
        } else {
          revision = await advance(store, record, revision, 'complete', [], [signalId(`receipt-${modelKey}`)])
        }
        modelOrdinal += 1
      }
      if (pendingTools.length > 0) {
        revision = await advance(
          store,
          record,
          revision,
          'complete',
          [],
          pendingTools.map((call) => signalId(`receipt-read:${call.args.p}`)),
        )
      }
      await drainOutbox(store, record)
      void revision
    } finally {
      benchmark.close()
    }
    const wallMs = performance.now() - started
    const wal = probe.finish()
    probe.close()
    if (kernelSessions !== kernelBefore) throw new Error('candidate opened a legacy kernel session')
    reconcileAuthoritative(commits, attestedCommits(file))
    const toolKeys = spec.modelTurns.flatMap((turn) =>
      turn.kind === 'tools' ? turn.calls.map((call) => `read:${call.args.p}`) : [],
    )
    assertToolWindows(commits, toolKeys)
    const classified = classifyCommits(commits)
    const bytes = readByteReport(file, probe.pageSize)
    const wrote = commits.filter((commit) => commit.wrote && commit.bucket !== 'preamble')
    return {
      mode: 'candidate',
      scenario: spec.name,
      status: 'measured',
      pageSize: probe.pageSize,
      commits: wrote.length,
      ...wal,
      commitMs: timingOf(wrote.map((commit) => commit.txMs)),
      callMs: timingOf(wrote.map((commit) => commit.callMs)),
      wallMs: roundMs(wallMs),
      dispatchMode: toolDispatchMode,
      tTool: classified.tTool,
      tShared: classified.tShared,
      tRound: classified.tRound,
      modelCommits: classified.modelCommits,
      tools: classified.tools,
      bytes,
      commitsDetail: commits,
      timingNote: TIMING_NOTE,
      backend: 'state',
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function runSample(mode: Mode, name: string): Promise<Sample> {
  if ((UNMEASURED_SCENARIOS as readonly string[]).includes(name)) {
    throw new Error(`${name} is unmeasured in this slice`)
  }
  return mode === 'baseline' ? runBaseline(name) : runCandidate(name)
}

export type GateRow = { pass: boolean; detail: Record<string, unknown> }

export type Report = {
  rounds: number
  pageSize: number
  timingNote: string
  percentile: 'floor(p * n), same rank as the legacy ledger driver'
  unmeasured: string[]
  scenarios: Record<string, Record<string, unknown>>
  gates: {
    toolCommits: GateRow
    batchWal: GateRow
    batchCommitMs: GateRow
    batchCallMs: { gated: false; detail: Record<string, unknown> }
    linear: GateRow
    chat: GateRow
  }
}

function median(values: number[]): number {
  return percentile(values, 0.5)
}

function sameNumber(values: number[], label: string): number {
  const first = values[0]
  if (first === undefined || values.some((value) => value !== first)) {
    throw new Error(`${label} is not stable across samples: ${values.join(',')}`)
  }
  return first
}

export function buildReport(samples: readonly Sample[], rounds: number): Report {
  const names = [...new Set(samples.map((sample) => sample.scenario))]
  assertMeasuredSet(names)
  for (const name of MEASURED_SCENARIOS) {
    for (const mode of ['baseline', 'candidate'] as const) {
      const found = samples.filter((sample) => sample.scenario === name && sample.mode === mode)
      if (found.length < rounds)
        throw new Error(`${mode} ${name} has ${found.length} samples, need ${rounds}`)
    }
  }
  const pageSize = sameNumber(
    samples.map((sample) => sample.pageSize),
    'page size',
  )
  const scenarios: Report['scenarios'] = {}
  for (const name of MEASURED_SCENARIOS) {
    const baseline = samples.filter((sample) => sample.scenario === name && sample.mode === 'baseline')
    const candidate = samples.filter((sample) => sample.scenario === name && sample.mode === 'candidate')
    const baselineCommits = sameNumber(
      baseline.map((sample) => sample.commits),
      `${name} baseline commits`,
    )
    const oracle = BASELINE_ORACLE[name]
    if (baselineCommits !== oracle.commits)
      throw new Error(`${name} baseline commits ${baselineCommits} != ${oracle.commits}`)
    const baselineRows = sameNumber(
      baseline.map((sample) => sample.rows ?? -1),
      `${name} baseline rows`,
    )
    const baselineOp = sameNumber(
      baseline.map((sample) => sample.opCellBytes ?? -1),
      `${name} baseline opCellBytes`,
    )
    if (baselineRows !== oracle.rows || baselineOp !== oracle.opCellBytes) {
      throw new Error(
        `${name} baseline rows/opCellBytes ${baselineRows}/${baselineOp} != ${oracle.rows}/${oracle.opCellBytes}`,
      )
    }
    const candidateCommits = sameNumber(
      candidate.map((sample) => sample.commits),
      `${name} candidate commits`,
    )
    const tTool = sameNumber(
      candidate.map((sample) => sample.tTool ?? -1),
      `${name} T_tool`,
    )
    const tShared = sameNumber(
      candidate.map((sample) => sample.tShared ?? -1),
      `${name} T_shared`,
    )
    const tRound = sameNumber(
      candidate.map((sample) => sample.tRound ?? -1),
      `${name} T_round`,
    )
    if (candidateCommits !== tRound)
      throw new Error(`${name} candidate commits ${candidateCommits} != T_round ${tRound}`)
    const continuation = candidate.map((sample) => sample.bytes?.continuationBytes ?? -1)
    const versions = candidate.map((sample) => sample.bytes?.versionBodyBytes ?? -1)
    scenarios[name] = {
      baselineCommits,
      baselineRows,
      baselineOpCellBytes: baselineOp,
      candidateCommits,
      tTool,
      tShared,
      tRound,
      modelCommits: sameNumber(
        candidate.map((sample) => sample.modelCommits ?? -1),
        `${name} model commits`,
      ),
      tools: candidate[0]?.tools ?? [],
      baselineWalMedian: median(baseline.map((sample) => sample.walBytes)),
      candidateWalMedian: median(candidate.map((sample) => sample.walBytes)),
      baselineWalP95: percentile(
        baseline.map((sample) => sample.walBytes),
        0.95,
      ),
      candidateWalP95: percentile(
        candidate.map((sample) => sample.walBytes),
        0.95,
      ),
      baselineCommitMsMedian: median(baseline.map((sample) => sample.commitMs.total)),
      candidateCommitMsMedian: median(candidate.map((sample) => sample.commitMs.total)),
      baselineCommitMsP95: percentile(
        baseline.map((sample) => sample.commitMs.total),
        0.95,
      ),
      candidateCommitMsP95: percentile(
        candidate.map((sample) => sample.commitMs.total),
        0.95,
      ),
      candidateCallMsMedian: median(candidate.map((sample) => sample.callMs?.total ?? 0)),
      candidateCallMsP95: percentile(
        candidate.map((sample) => sample.callMs?.total ?? 0),
        0.95,
      ),
      baselineWallMedian: median(baseline.map((sample) => sample.wallMs)),
      candidateWallMedian: median(candidate.map((sample) => sample.wallMs)),
      continuationBytes: sameNumber(continuation, `${name} continuation bytes`),
      versionBodyBytes: sameNumber(versions, `${name} version bytes`),
      providerState: candidate[0]?.bytes?.providerState,
      versionBodyBySchema: candidate[0]?.bytes?.versionBodyBySchema,
      manifestBytes: candidate[0]?.bytes?.manifestBytes,
      sideEntryBytes: candidate[0]?.bytes?.sideEntryBytes,
      ledgerProof: candidate[0]?.bytes?.ledgerProof,
      indexBytes: candidate[0]?.bytes?.indexBytes,
      auxiliary: candidate[0]?.bytes?.auxiliary,
      headPayloadBytes: candidate[0]?.bytes?.headPayloadBytes,
      packedProofBytes: candidate[0]?.bytes?.packedProofBytes,
      versionBodyPhysicalBytes: candidate[0]?.bytes?.versionBodyPhysicalBytes,
      headPhysicalBytes: candidate[0]?.bytes?.headPhysicalBytes,
      tablePages: candidate[0]?.bytes?.tablePages,
    }
  }
  const ratio = (candidate: number, baseline: number) => (baseline === 0 ? null : candidate / baseline)
  const toolPass = MEASURED_SCENARIOS.filter((name) => name !== 'chat').every(
    (name) => Number(scenarios[name]?.tTool) <= 3,
  )
  const k16 = scenarios.k16
  const chat = scenarios.chat
  const walRatio = ratio(Number(k16?.candidateWalMedian), Number(k16?.baselineWalMedian))
  const timeRatio = ratio(Number(k16?.candidateCommitMsMedian), Number(k16?.baselineCommitMsMedian))
  const callRatio = ratio(Number(k16?.candidateCallMsMedian), Number(k16?.baselineCommitMsMedian))
  const kBytes = (field: 'continuationBytes' | 'versionBodyBytes') => ({
    k1: scenarios.k1?.[field],
    k4: scenarios.k4?.[field],
    k8: scenarios.k8?.[field],
    k16: scenarios.k16?.[field],
    ratio: ratio(Number(scenarios.k16?.[field]), Number(scenarios.k8?.[field])),
  })
  const continuation = kBytes('continuationBytes')
  const recordVersions = kBytes('versionBodyBytes')
  const providerAbsent = MEASURED_SCENARIOS.every((name) => {
    const state = scenarios[name]?.providerState
    return typeof state === 'object' && state !== null && 'present' in state && state.present === false
  })
  const linearPass =
    providerAbsent &&
    continuation.ratio !== null &&
    continuation.ratio <= 2.2 &&
    recordVersions.ratio !== null &&
    recordVersions.ratio <= 2.2
  const chatCommitRatio = ratio(Number(chat?.candidateCommits), Number(chat?.baselineCommits))
  const chatWalRatio = ratio(Number(chat?.candidateWalMedian), Number(chat?.baselineWalMedian))
  const chatTimeRatio = ratio(Number(chat?.candidateCommitMsMedian), Number(chat?.baselineCommitMsMedian))
  const within = (value: number | null) => value !== null && value <= 1.1
  return {
    rounds,
    pageSize,
    timingNote: TIMING_NOTE,
    percentile: 'floor(p * n), same rank as the legacy ledger driver',
    unmeasured: [...UNMEASURED_SCENARIOS],
    scenarios,
    gates: {
      toolCommits: {
        pass: toolPass,
        detail: Object.fromEntries(
          MEASURED_SCENARIOS.filter((name) => name !== 'chat').map((name) => [name, scenarios[name]?.tTool]),
        ),
      },
      batchWal: {
        pass: within(walRatio),
        detail: {
          candidate: k16?.candidateWalMedian,
          baseline: k16?.baselineWalMedian,
          ratio: walRatio,
          limit: 1.1,
        },
      },
      batchCommitMs: {
        pass: within(timeRatio),
        detail: {
          basis: 'transaction',
          candidate: k16?.candidateCommitMsMedian,
          baseline: k16?.baselineCommitMsMedian,
          ratio: timeRatio,
          limit: 1.1,
          candidateP95: k16?.candidateCommitMsP95,
          baselineP95: k16?.baselineCommitMsP95,
        },
      },
      batchCallMs: {
        gated: false,
        detail: {
          candidate: k16?.candidateCallMsMedian,
          baseline: k16?.baselineCommitMsMedian,
          ratio: callRatio,
        },
      },
      linear: {
        pass: linearPass,
        detail: {
          continuation,
          providerState: scenarios.k1?.providerState,
          recordVersions,
          limit: 2.2,
        },
      },
      chat: {
        pass: within(chatCommitRatio) && within(chatWalRatio) && within(chatTimeRatio),
        detail: {
          commits: {
            candidate: chat?.candidateCommits,
            baseline: chat?.baselineCommits,
            ratio: chatCommitRatio,
          },
          wal: {
            candidate: chat?.candidateWalMedian,
            baseline: chat?.baselineWalMedian,
            ratio: chatWalRatio,
          },
          commitMs: {
            candidate: chat?.candidateCommitMsMedian,
            baseline: chat?.baselineCommitMsMedian,
            ratio: chatTimeRatio,
            basis: 'transaction',
          },
          callMs: {
            candidate: chat?.candidateCallMsMedian,
            ratio: ratio(Number(chat?.candidateCallMsMedian), Number(chat?.baselineCommitMsMedian)),
            gated: false,
          },
        },
      },
    },
  }
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function rotate<T>(values: readonly T[], offset: number): T[] {
  const start = offset % values.length
  return [...values.slice(start), ...values.slice(0, start)]
}

export async function runRound(round: number, rounds: number): Promise<Sample[]> {
  const scenarios = rotate(MEASURED_SCENARIOS, round)
  const candidateFirst = round % 2 === 1
  const modes: Mode[] = candidateFirst ? ['candidate', 'baseline'] : ['baseline', 'candidate']
  const order = scenarios.flatMap((scenario) => modes.map((mode) => ({ scenario, mode })))
  for (const step of order) await runSample(step.mode, step.scenario)
  const measured: Sample[] = []
  for (const step of order) measured.push(await runSample(step.mode, step.scenario))
  const pages = new Set(measured.map((sample) => sample.pageSize))
  if (pages.size !== 1) throw new Error(`page size diverged: ${[...pages].join(',')}`)
  void rounds
  return measured
}

/** One warmed tool dispatch and one warmed intake on the current public methods.
 * The model turn warms statement cache. mark_running still runs between the two
 * windows and is not included in either snapshot. */
export async function profileHotCommits(samples = 5): Promise<ProfileCampaign> {
  const rows: ProfileCampaign['samples'] = []
  for (let index = 0; index < samples; index += 1) rows.push(await profileOneDatabase())
  return {
    samples: rows,
    note: 'Each sample is a fresh database. The model turn warms SQL. The measured windows are one public dispatchAdmission and one intakeReceipt. mark_running between them stays outside the profile and is not part of the local-tool loop. Profiler branches stay off for the campaign.',
  }
}

type ProfiledCall = { wallMs: number; admittedOrSettled: string; profile: ProfileSnapshot }

type ProfileCampaign = {
  note: string
  samples: Array<{ dispatchAdmission: ProfiledCall; intakeReceipt: ProfiledCall }>
}

async function profileOneDatabase(): Promise<ProfileCampaign['samples'][number]> {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-profile-rc-'))
  const file = join(directory, 'state.sqlite')
  let benchmark: Awaited<ReturnType<typeof openBenchmarkState>> | undefined
  const record = (): void => undefined
  try {
    benchmark = await openBenchmarkState(file, 'one call')
    const { store, admission, context } = benchmark
    unwrap(await store.createRun(admission, context), 'createRun')
    unwrap(
      await store.open(
        {
          requestId: 'open-write',
          authority,
          sessionId: 'session-1',
          mode: 'write',
          writerId: 'writer-a',
          ttlMs: 60_000,
        },
        callContext(),
      ),
      'open',
    )
    const modelAction = preparedAction('model-0', {
      role: 'model',
      offered: ['read'],
      userText: 'one call',
      cursor: 0,
    })
    let revision = await advance(store, record, 0, 'model-0', [modelAction], [])
    await runAction(
      store,
      record,
      'inv-model-0',
      revision,
      { key: 'model-0', action: modelAction, receiptId: 'receipt-model-0', toolKeys: [] },
      'model',
      { calls: [{ name: 'read', args: { p: 0 } }] },
    )
    const toolAction = preparedAction('read:0', { name: 'read', args: { p: 0 } })
    revision = await advance(store, record, revision, 'tools-0', [toolAction], [signalId('receipt-model-0')])
    const admissionId = 'admission-read:0'
    const request: DispatchAdmissionRequest = {
      admissionId,
      commitId: `commit-${admissionId}`,
      guard: commitGuard('inv-tools-0', revision),
      atomicDomain: {
        domainId: 'domain-1',
        revision: 1,
        stateAuthority: authority,
        budgetAuthority: authority,
        stateBinding: {
          bindingId: 'binding-1',
          contract: 'agh.runtime/run-admission',
          logicalName: 'run',
          providerId: 'runtime-state',
        },
        budgetBinding: {
          bindingId: 'binding-1',
          contract: 'agh.runtime/run-admission',
          logicalName: 'run',
          providerId: 'runtime-state',
        },
      },
      actionId: stableId('act', 'run-1\0read:0'),
      expectedActionRevision: 1,
      decisionRef: inline({ allow: admissionId }),
      attemptId: `attempt-${admissionId}`,
      requestIdentity: {
        system: 'tool',
        aghRequestId: `agh-${admissionId}`,
        idempotencyKey: null,
        requestDigest: digestOf(toolAction.input),
      },
      budget: { reservation: null, quota: [{ name: 'parallel-action', amount: 1 }] },
      deadline: DEADLINE,
    }
    const dispatch = await profiledCall('dispatch', () => store.dispatchAdmission(request, callContext()))
    if (!dispatch.ok || dispatch.value.state !== 'admitted')
      throw new Error('profiled dispatch was not admitted')
    unwrap(
      await store.commitControl(
        {
          commitId: 'mark-read:0',
          guard: commitGuard('inv-tools-0', revision),
          command: {
            kind: 'mark_running',
            attemptId: request.attemptId,
            expectedAttemptRevision: 1,
            externalRequests: [externalRequest],
          },
        },
        callContext(),
      ),
      'mark_running',
    )
    const actionId = stableId('act', 'run-1\0read:0')
    const usageFact: UsageFact = {
      usageId: 'usage-read:0',
      originKey: 'origin-read:0',
      actionId,
      attemptId: request.attemptId,
      source: toolBinding,
      dimensions: inline({ tokens: 1 }),
      externalRequest,
      observedAt: ADMITTED_AT,
      certainty: 'measured',
    }
    const intakeRequest: ReceiptIntakeRequest = {
      intakeId: 'intake-read:0',
      receipt: {
        receiptId: 'receipt-read:0',
        actionId,
        attemptId: request.attemptId,
        bindingId: 'binding-1',
        inputDigest: digestOf(toolAction.input),
        outcome: 'succeeded',
        result: inline({ text: 'read' }),
        externalRequests: [externalRequest],
        usageRefs: [usageFact.usageId],
        references: [],
        provenance: { sourceRefs: [], producer: toolBinding, trustLabels: [] },
        completedAt: ADMITTED_AT,
      },
      usage: [usageFact],
      evidence: [],
      sourceAuthorizationRef: dispatch.value.authorizationId,
      queryUsage: null,
      resultHandling: { kind: 'no-hook' },
    }
    observeBenchmarkUsage(store, request, dispatch.value.authorizationId, intakeRequest)
    const intake = await profiledCall('intake', () => store.intakeReceipt(intakeRequest, callContext()))
    if (!intake.ok) throw new Error('profiled intake failed')
    return {
      dispatchAdmission: {
        wallMs: dispatch.wallMs,
        admittedOrSettled: dispatch.value.state,
        profile: dispatch.profile,
      },
      intakeReceipt: { wallMs: intake.wallMs, admittedOrSettled: 'settled', profile: intake.profile },
    }
  } finally {
    setProfiling(false)
    benchmark?.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

async function profiledCall<T>(
  _label: string,
  body: () => Promise<Outcome<T>>,
): Promise<{ ok: true; value: T; wallMs: number; profile: ProfileSnapshot } | { ok: false }> {
  resetProfile()
  setProfiling(true)
  enterPhase('call')
  let open = true
  const started = performance.now()
  try {
    const value = await body()
    const wallMs = performance.now() - started
    leavePhase()
    open = false
    if (!value.ok) return { ok: false }
    return { ok: true, value: value.value, wallMs, profile: snapshotProfile() }
  } finally {
    if (open) leavePhase()
    setProfiling(false)
  }
}

function parseArgs(argv: string[]): {
  campaign: boolean
  profile: boolean
  dispatch: ToolDispatchMode
  rounds: number
  out: string | null
  round: number | null
  mode: Mode | 'both'
  scenarios: string[]
} {
  let campaign = false
  let profile = false
  let dispatch: ToolDispatchMode = 'batch'
  let rounds = 20
  let out: string | null = null
  let round: number | null = null
  let mode: Mode | 'both' = 'both'
  const scenarios: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--campaign') campaign = true
    else if (arg === '--profile') profile = true
    else if (arg === '--dispatch') {
      const value = argv[++index]
      if (value !== 'each' && value !== 'batch') throw new Error(`unknown dispatch mode ${value}`)
      dispatch = value
    } else if (arg === '--rounds') rounds = Number(argv[++index])
    else if (arg === '--out') out = argv[++index] ?? null
    else if (arg === '--round') round = Number(argv[++index])
    else if (arg === '--mode') mode = argv[++index] as Mode | 'both'
    else if (arg === '--scenario') scenarios.push(argv[++index] ?? '')
    else throw new Error(`unknown argument ${arg}`)
  }
  return { campaign, profile, dispatch, rounds, out, round, mode, scenarios }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  toolDispatchMode = args.dispatch
  if (args.profile) {
    const report = await profileHotCommits(5)
    const text = JSON.stringify(report)
    if (args.out) writeFileSync(args.out, `${text}\n`)
    console.log(text)
    return
  }
  if (args.round !== null) {
    const samples = await runRound(args.round, args.rounds)
    for (const sample of samples) console.log(JSON.stringify(sample))
    return
  }
  if (args.campaign) {
    if (!args.out) throw new Error('--campaign requires --out')
    const script = fileURLToPath(import.meta.url)
    const tsx = join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
    const lines: string[] = []
    for (let round = 0; round < args.rounds; round += 1) {
      const child = execFileSync(
        process.execPath,
        [tsx, script, '--round', String(round), '--rounds', String(args.rounds), '--dispatch', args.dispatch],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        },
      )
      for (const line of child.split('\n')) {
        if (line.trim().length > 0) lines.push(line)
      }
      process.stderr.write(`round ${round + 1}/${args.rounds}\n`)
    }
    writeFileSync(args.out, `${lines.join('\n')}\n`)
    const samples = lines.map((line) => JSON.parse(line) as Sample)
    console.log(JSON.stringify(buildReport(samples, args.rounds)))
    return
  }
  const names = args.scenarios.length > 0 ? args.scenarios : [...MEASURED_SCENARIOS]
  for (const name of names) {
    if ((UNMEASURED_SCENARIOS as readonly string[]).includes(name)) {
      console.log(JSON.stringify({ scenario: name, status: 'unmeasured' }))
      continue
    }
    const modes: Mode[] = args.mode === 'both' ? ['baseline', 'candidate'] : [args.mode]
    for (const mode of modes) console.log(JSON.stringify(await runSample(mode, name)))
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
