import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type {
  ConfigSaveInput,
  EventEnvelope,
  SessionModelSlotsResult,
  SessionSetJevStagesParams,
  SlotName,
  ThinkingLevel,
} from '@agnes/protocol'
import type { NodeClient, Session, TurnResult } from '@agnes/sdk'

/** This driver runs inside one fresh Harbor task environment. Harbor alone grades the task. */
export interface DriverRequest {
  schemaVersion: 1
  runtime: 'native' | 'jevloop'
  distributionDir: string
  home: string
  profile: string
  cwd: string
  prompt: string
  deadlineMs: number
  cancelGraceMs?: number
  startupTimeoutMs?: number
  exportTimeoutMs?: number
  exportMaxBytes?: number
  preset?: string
  jevStages?: SessionSetJevStagesParams['stages']
  models?: Array<{
    slot: SlotName
    route: string
    model: string
    thinking?: ThinkingLevel | null
    contextWindow?: number | null
  }>
  /** Submitted to the public config API. Never copied into any output artifact. */
  config?: ConfigSaveInput
}

export class DriverError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 86_400_000
const DEFAULT_EXPORT_TIMEOUT_MS = 60_000
const MAX_EXPORT_BYTES = 128 * 1024 * 1024
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const inside = (root: string, target: string): boolean => {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function parseRequest(value: unknown): DriverRequest {
  const keys = new Set([
    'schemaVersion',
    'runtime',
    'distributionDir',
    'home',
    'profile',
    'cwd',
    'prompt',
    'deadlineMs',
    'cancelGraceMs',
    'startupTimeoutMs',
    'exportTimeoutMs',
    'exportMaxBytes',
    'preset',
    'jevStages',
    'models',
    'config',
  ])
  if (!record(value) || Object.keys(value).some((key) => !keys.has(key)))
    throw new DriverError('REQUEST_INVALID')
  if (value.schemaVersion !== 1 || !['native', 'jevloop'].includes(String(value.runtime)))
    throw new DriverError('REQUEST_INVALID')
  for (const key of ['distributionDir', 'home', 'cwd'])
    if (!text(value[key]) || !isAbsolute(value[key]) || value[key].includes('\0'))
      throw new DriverError('REQUEST_INVALID')
  if (!text(value.profile) || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.profile))
    throw new DriverError('REQUEST_INVALID')
  // Current daemon profile loading selects the builtin by this name before reading user layers.
  if (value.profile !== 'local-dev') throw new DriverError('FIXTURE_PROFILE_UNSUPPORTED')
  if (!text(value.prompt) || Buffer.byteLength(value.prompt) > 4 * 1024 * 1024 || !positive(value.deadlineMs))
    throw new DriverError('REQUEST_INVALID')
  for (const key of ['cancelGraceMs', 'startupTimeoutMs'])
    if (value[key] !== undefined && !positive(value[key])) throw new DriverError('REQUEST_INVALID')
  for (const [key, maximum] of [
    ['exportTimeoutMs', DEFAULT_EXPORT_TIMEOUT_MS],
    ['exportMaxBytes', MAX_EXPORT_BYTES],
  ] as const)
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'number' ||
        !Number.isSafeInteger(value[key]) ||
        value[key] <= 0 ||
        value[key] > maximum)
    )
      throw new DriverError('REQUEST_INVALID')
  if (value.preset !== undefined && !text(value.preset)) throw new DriverError('REQUEST_INVALID')
  const slots = new Set(['primary', 'escalation', 'fast', 'compaction', 'verifier', 'image', 'video'])
  const thinking = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length > 7) throw new DriverError('REQUEST_INVALID')
    const selected = new Set<string>()
    for (const model of value.models) {
      if (
        !record(model) ||
        !slots.has(String(model.slot)) ||
        selected.has(String(model.slot)) ||
        !text(model.route) ||
        !text(model.model) ||
        Object.keys(model).some(
          (key) => !['slot', 'route', 'model', 'thinking', 'contextWindow'].includes(key),
        ) ||
        (model.thinking != null && !thinking.has(String(model.thinking))) ||
        (model.contextWindow != null && !positive(model.contextWindow))
      )
        throw new DriverError('REQUEST_INVALID')
      selected.add(String(model.slot))
    }
  }
  if (value.jevStages !== undefined) {
    if (
      !record(value.jevStages) ||
      Object.keys(value.jevStages).some((key) => !['parameters', 'arbitration', 'answer'].includes(key))
    )
      throw new DriverError('REQUEST_INVALID')
    for (const binding of Object.values(value.jevStages)) {
      if (binding === null) continue
      if (
        !record(binding) ||
        !text(binding.route) ||
        !text(binding.model) ||
        Object.keys(binding).some((key) => !['route', 'model', 'thinking'].includes(key)) ||
        (binding.thinking != null && !thinking.has(String(binding.thinking)))
      )
        throw new DriverError('REQUEST_INVALID')
    }
    if (value.runtime === 'native' && Object.values(value.jevStages).some((binding) => binding !== null))
      throw new DriverError('NATIVE_JEV_STAGES_UNSUPPORTED')
  }
  if (value.config !== undefined && !record(value.config)) throw new DriverError('REQUEST_INVALID')
  const request = value as unknown as DriverRequest
  if (inside(request.cwd, request.home) || inside(request.home, request.cwd))
    throw new DriverError('HOME_OVERLAPS_TASK')
  return request
}

const secretKey = /(?:api.?key|token|secret|password|authorization|credential)/i
// Public model serialization metadata identifies a token-limit field; it is not a credential.
const sensitiveKey = (key: string): boolean =>
  !/^(?:maxTokensField|max_tokens_field)$/i.test(key) && secretKey.test(key)
/** Redact credentials supplied in env or bound configuration, including echoed tool/provider output. */
export function outputSanitizer(env: NodeJS.ProcessEnv, config?: unknown): (value: unknown) => unknown {
  const secrets = new Set<string>()
  const gather = (value: unknown, sensitive = false): void => {
    if (typeof value === 'string' && sensitive && value.length > 0) secrets.add(value)
    else if (Array.isArray(value)) for (const item of value) gather(item, sensitive)
    else if (record(value))
      for (const [key, child] of Object.entries(value)) gather(child, sensitive || sensitiveKey(key))
  }
  for (const [key, value] of Object.entries(env)) if (sensitiveKey(key)) gather(value, true)
  gather(config)
  const replace = (value: string): string => {
    let out = value
    for (const secret of [...secrets].sort((a, b) => b.length - a.length))
      out = out.split(secret).join('[REDACTED]')
    return out.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
  }
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return replace(value)
    if (Array.isArray(value)) return value.map(sanitize)
    if (record(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          replace(key),
          sensitiveKey(key) && typeof child === 'string' ? '[REDACTED]' : sanitize(child),
        ]),
      )
    return value
  }
  return sanitize
}

type Settlement = { kind: 'result'; value: TurnResult } | { kind: 'error'; code: string; terminal: boolean }
export interface TurnOutcome {
  status: 'settled' | 'timeout' | 'cancelled' | 'driver_error'
  reason: string | null
  stopReason: string | null
  lastSeq: number | null
  elapsedMs: number
  deadlineExceeded: boolean
  requiresHardKill: boolean
  errorCode: string | null
}
function safeCode(error: unknown): string {
  if (error instanceof DriverError) return error.code
  if (record(error) && record(error.data) && error.data.code === 'TURN_ERROR') return 'TURN_ERROR'
  if (
    record(error) &&
    record(error.data) &&
    typeof error.data.reason === 'string' &&
    /^CONFIG_[A-Z_]{1,48}$/.test(error.data.reason)
  )
    return error.data.reason
  if (error instanceof Error && error.name === 'ProtocolViolation') return 'PROTOCOL_VIOLATION'
  return 'RPC_OR_PROCESS_ERROR'
}
const timedOut = Symbol('deadline')
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | typeof timedOut> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof timedOut>((done) => {
    timer = setTimeout(() => done(timedOut), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** A cancel receipt is never a settlement receipt. No result here contains benchmark pass/reward. */
export async function runTurn(
  session: Pick<Session, 'prompt' | 'cancel'>,
  prompt: string,
  deadlineMs: number,
  graceMs: number,
  signal?: AbortSignal,
): Promise<TurnOutcome> {
  const start = performance.now()
  if (signal?.aborted)
    return {
      status: 'cancelled',
      reason: 'aborted',
      stopReason: 'cancelled',
      lastSeq: null,
      elapsedMs: 0,
      deadlineExceeded: false,
      requiresHardKill: false,
      errorCode: null,
    }
  const settlement: Promise<Settlement> = session.prompt(prompt).then(
    (value) => ({ kind: 'result', value }),
    (error: unknown) => {
      const code = safeCode(error)
      return { kind: 'error', code, terminal: code === 'TURN_ERROR' }
    },
  )
  let interrupt!: () => void
  const interrupted = new Promise<typeof timedOut>((done) => {
    interrupt = () => done(timedOut)
    signal?.addEventListener('abort', interrupt, { once: true })
    if (signal?.aborted) interrupt()
  })
  let outcome: Settlement | typeof timedOut
  let deadlineExceeded = false
  let cancellation = false
  try {
    outcome = await bounded(Promise.race([settlement, interrupted]), deadlineMs)
    if (outcome === timedOut) {
      cancellation = signal?.aborted === true
      deadlineExceeded = !cancellation
      // Do not let a stuck transport's cancel send defeat the independent grace deadline.
      void session.cancel().catch(() => undefined)
      outcome = await bounded(settlement, graceMs)
    }
  } finally {
    signal?.removeEventListener('abort', interrupt)
  }
  const common = {
    elapsedMs: performance.now() - start,
    deadlineExceeded,
    requiresHardKill: outcome === timedOut,
  }
  if (outcome === timedOut)
    return {
      ...common,
      status: cancellation ? 'cancelled' : 'timeout',
      reason: null,
      stopReason: null,
      lastSeq: null,
      errorCode: 'CANCEL_NOT_SETTLED',
    }
  if (outcome.kind === 'error')
    return {
      ...common,
      status: deadlineExceeded
        ? 'timeout'
        : cancellation
          ? 'cancelled'
          : outcome.terminal
            ? 'settled'
            : 'driver_error',
      reason: outcome.terminal ? 'error' : null,
      stopReason: null,
      lastSeq: null,
      errorCode: outcome.code,
    }
  return {
    ...common,
    status: deadlineExceeded ? 'timeout' : cancellation ? 'cancelled' : 'settled',
    reason: outcome.value.reason,
    stopReason: outcome.value.stopReason,
    lastSeq: outcome.value.lastSeq,
    errorCode: null,
  }
}

/** The contract is a complete retained prefix, not merely the terminal row arriving. */
export function completePrefix(events: readonly EventEnvelope[], throughSeq: number): boolean {
  return events.length === throughSeq && events.every((event, index) => event.seq === index + 1)
}

/** Recover only an omitted terminal watermark from this fresh, single-prompt session's ledger. */
export function recoverTerminalSequence(
  outcome: TurnOutcome,
  exported: { events: readonly EventEnvelope[]; throughSeq: number; complete: boolean },
): TurnOutcome {
  if (
    outcome.status !== 'settled' ||
    outcome.lastSeq !== null ||
    outcome.reason === null ||
    outcome.requiresHardKill ||
    !exported.complete ||
    !completePrefix(exported.events, exported.throughSeq)
  )
    return outcome
  const terminal = exported.events.filter((event) => event.type === 'turn/end' && event.lane === 'main')
  // Multiple terminal rows violate this driver's single-prompt assumption. Never choose one by order.
  if (terminal.length !== 1 || !record(terminal[0]?.data) || terminal[0].data.reason !== outcome.reason)
    return outcome
  return { ...outcome, lastSeq: terminal[0].seq }
}

export function fixtureProfile(name: string): Record<string, unknown> {
  return {
    name,
    schemaVersion: 1,
    computerUse: { enabled: false },
    policy: {
      workspacePackages: 'deny',
      capabilityCeiling: [
        'tools',
        'hooks',
        'slots',
        'events',
        'resources',
        'ui',
        'network',
        'network.publicRead',
        'tools.invoke',
        'artifacts',
      ],
    },
  }
}

export function validateFixtureProfile(value: unknown, name: string): void {
  if (
    !record(value) ||
    value.name !== name ||
    !record(value.computerUse) ||
    value.computerUse.enabled !== false ||
    !record(value.policy) ||
    value.policy.workspacePackages !== 'deny' ||
    !Array.isArray(value.policy.capabilityCeiling) ||
    value.policy.capabilityCeiling.includes('subagent')
  )
    throw new DriverError('FIXTURE_PROFILE_UNSAFE')
}

/** Do not scan/read Skill bodies. Reject every supported filesystem discovery entrance up front. */
export async function assertNoBenchmarkSkillPaths(
  request: Pick<DriverRequest, 'home' | 'cwd'>,
  env: NodeJS.ProcessEnv,
) {
  const userHome = env.HOME ?? env.USERPROFILE ?? homedir()
  const paths = [
    ...new Set([
      join(request.home, 'skills'),
      ...[userHome, request.cwd].flatMap((root) =>
        // Benchmark isolation: reject every supported harness's skill discovery entrance.
        ['.agh', '.agents', '.claude', '.codex'].map((name) => join(root, name, 'skills')),
      ),
    ]),
  ]
  for (const path of paths) {
    try {
      await lstat(path)
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') continue
      throw new DriverError('SKILL_PATH_CHECK_FAILED')
    }
    throw new DriverError('BENCHMARK_SKILL_PATH_PRESENT')
  }
  return { filesystemRootsAbsent: true, checkedEntrances: paths.length }
}

/** Public resource control only; retain hooks and the other builtin plugin capabilities. */
export async function disableBenchmarkSkills(
  resources: NodeClient['resources'],
  profile: string,
  timeoutMs = 10_000,
) {
  const deadline = performance.now() + timeoutMs
  const call = async <T>(pending: Promise<T>): Promise<T> => {
    const result = await bounded(pending, Math.max(1, deadline - performance.now()))
    if (result === timedOut) throw new DriverError('SKILL_POLICY_TIMEOUT')
    return result
  }
  const list = async () => {
    const items: Awaited<ReturnType<typeof resources.list>>['items'] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await call(resources.list({ profile, kind: 'skill', ...(cursor ? { cursor } : {}) }))
      items.push(...result.items)
      if (!result.nextCursor) return items
      if (result.nextCursor === cursor) throw new DriverError('SKILL_ROSTER_CURSOR_INVALID')
      cursor = result.nextCursor
    }
    throw new DriverError('SKILL_ROSTER_LIMIT')
  }
  const existing = await list()
  for (const resource of existing) {
    if (resource.kind !== 'skill') throw new DriverError('SKILL_ROSTER_INVALID')
    await call(
      resources.desiredSet({
        profile,
        resourceId: resource.resourceId,
        state: 'disabled',
        expectedRevision: resource.revision,
        clientId: 'agh-tb-skill-policy',
        commandId: randomUUID(),
      }),
    )
  }
  while (true) {
    const current = await list()
    if (
      current.every(
        (resource) =>
          resource.kind === 'skill' && resource.desired === 'disabled' && resource.actual !== 'ready',
      )
    )
      return {
        policy: 'all-skills-disabled',
        hooksPreserved: true,
        registeredSkillReadInterfaces: 'may remain registered; no enabled/ready resource is permitted',
        resources: current.map((resource) => ({
          resourceId: resource.resourceId,
          revision: resource.revision,
          desired: resource.desired,
          actual: resource.actual,
        })),
      }
    if (performance.now() >= deadline) throw new DriverError('BENCHMARK_SKILL_ACTIVE')
    await delay(100)
  }
}

/** Apply explicit session settings and prove the public readback before any task/model request. */
export async function applyModelConfiguration(
  session: Pick<Session, 'id' | 'setModel' | 'setJevStages' | 'modelSlots'>,
  request: Pick<DriverRequest, 'runtime' | 'models' | 'jevStages'>,
): Promise<SessionModelSlotsResult> {
  if (
    request.runtime === 'native' &&
    Object.values(request.jevStages ?? {}).some((binding) => binding !== null)
  )
    throw new DriverError('NATIVE_JEV_STAGES_UNSUPPORTED')
  for (const model of request.models ?? []) await session.setModel(model)
  if (request.runtime === 'jevloop' && Object.keys(request.jevStages ?? {}).length)
    await session.setJevStages(request.jevStages ?? {})
  const observed = await session.modelSlots()
  if (observed.sessionId !== session.id || observed.runtime.id !== request.runtime)
    throw new DriverError('MODEL_READBACK_OWNER_MISMATCH')
  for (const model of request.models ?? []) {
    const actual = observed.slots.find((slot) => slot.slot === model.slot)
    if (
      !actual ||
      actual.route !== model.route ||
      actual.model !== model.model ||
      (model.thinking !== undefined && actual.thinking !== model.thinking) ||
      (model.contextWindow !== undefined && actual.contextWindow !== model.contextWindow)
    )
      throw new DriverError('MODEL_READBACK_MISMATCH')
  }
  if (request.runtime === 'jevloop')
    for (const stage of ['parameters', 'arbitration', 'answer'] as const) {
      if (!request.jevStages || !Object.hasOwn(request.jevStages, stage)) continue
      const expected = request.jevStages[stage]
      const actual = observed.languageBindings?.[stage]
      if (
        expected === null
          ? actual !== null
          : !expected ||
            !actual ||
            actual.route !== expected.route ||
            actual.model !== expected.model ||
            (expected.thinking !== undefined && actual.thinking !== expected.thinking)
      )
        throw new DriverError('JEV_STAGE_READBACK_MISMATCH')
    }
  return observed
}

async function prepareProfile(request: DriverRequest): Promise<void> {
  const directory = join(request.home, 'profiles', request.profile)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'profile.yaml')
  let value: unknown
  try {
    const { parse } = await import('yaml')
    value = parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (!record(error) || error.code !== 'ENOENT') throw new DriverError('FIXTURE_PROFILE_INVALID')
    value = fixtureProfile(request.profile)
    // JSON is YAML. Never overwrite a preseeded profile.
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  }
  validateFixtureProfile(value, request.profile)
}

async function sdk(socket: string, requestTimeoutMs?: number): Promise<NodeClient> {
  const { createClient, memoryJournal } = await import('@agnes/sdk')
  return createClient({
    transport: { kind: 'unix', path: socket },
    auth: { kind: 'local' },
    journal: memoryJournal(),
    ...(requestTimeoutMs === undefined ? {} : { timeouts: { request: requestTimeoutMs } }),
  })
}
async function ready(socket: string, daemon: ChildProcess, timeout: number): Promise<NodeClient> {
  const until = performance.now() + timeout
  while (performance.now() < until) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new DriverError('DAEMON_EXITED')
    const client = await sdk(socket)
    try {
      const result = await bounded(
        client.initialize(),
        Math.min(1000, Math.max(1, until - performance.now())),
      )
      if (result !== timedOut) return client
    } catch {
      /* A listener may not have been published yet. */
    }
    await bounded(client.close(), 250)
    await delay(50)
  }
  throw new DriverError('DAEMON_START_TIMEOUT')
}

async function exportPrefix(
  socket: string,
  id: string,
  maxMs: number,
  maxBytes: number,
): Promise<{ events: EventEnvelope[]; throughSeq: number; complete: boolean }> {
  const deadline = performance.now() + maxMs
  const remaining = (): number => Math.max(1, deadline - performance.now())
  const client = await sdk(socket, maxMs)
  const events: EventEnvelope[] = []
  let session: Session | undefined
  let iterator: AsyncIterator<import('@agnes/sdk').LedgerEvent> | undefined
  let throughSeq = 0
  try {
    if ((await bounded(client.restoreSession(id, ''), remaining())) === timedOut)
      return { events, throughSeq, complete: false }
    const attaching = client.session.attach(id, {
      filter: { acpUpdates: false },
    })
    session = client.sessions.get(id)
    if (!session) throw new DriverError('EXPORT_HANDLE_MISSING')
    iterator = session.events()[Symbol.asyncIterator]()
    let next = iterator.next()
    if ((await bounded(attaching, remaining())) === timedOut) return { events, throughSeq, complete: false }
    throughSeq = session.lastServerSeq
    let bytes = 0
    while (events.length < throughSeq) {
      if (performance.now() >= deadline) return { events, throughSeq, complete: false }
      const row = await bounded(next, remaining())
      if (row === timedOut || row.done) return { events, throughSeq, complete: false }
      const { _meta: _ignored, ...event } = row.value
      bytes += Buffer.byteLength(JSON.stringify(event))
      if (bytes > maxBytes || event.seq !== events.length + 1) return { events, throughSeq, complete: false }
      events.push(event)
      if (event.seq >= throughSeq) break
      next = iterator.next()
    }
    return { events, throughSeq, complete: completePrefix(events, throughSeq) }
  } finally {
    if (iterator) await bounded(Promise.resolve(iterator.return?.()), 250)
    if (session?.attached)
      await bounded(
        session.detach().catch(() => undefined),
        250,
      )
    await bounded(client.close(), 250)
  }
}

export async function runDriver(
  request: DriverRequest,
  outputDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!isAbsolute(outputDir) || inside(request.cwd, outputDir) || inside(outputDir, request.cwd))
    throw new DriverError('OUTPUT_OVERLAPS_TASK')
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await mkdir(request.home, { recursive: true, mode: 0o700 })
  // Preseeded configuration is allowed. An existing attempt owner is never adopted.
  const owner = await open(join(request.home, 'terminal-bench-owner'), 'wx', 0o600)
  await owner.close()
  await prepareProfile(request)
  const skillPaths = await assertNoBenchmarkSkillPaths(request, env)
  const sanitize = outputSanitizer(env, request.config)
  const save = async (file: string, value: unknown): Promise<void> => {
    await writeFile(join(outputDir, file), `${JSON.stringify(sanitize(value), null, 2)}\n`, { mode: 0o600 })
  }
  const socket = join(request.home, 'tb.sock')
  if (Buffer.byteLength(socket) > 95) throw new DriverError('SOCKET_PATH_TOO_LONG')
  let daemon: ChildProcess | undefined
  let client: NodeClient | undefined
  let session: Session | undefined
  let daemonText = ''
  let spawnError = false
  let runtime: { id: string; version: string } = { id: request.runtime, version: 'unknown' }
  let outcome: TurnOutcome = {
    status: 'driver_error',
    reason: null,
    stopReason: null,
    lastSeq: null,
    elapsedMs: 0,
    deadlineExceeded: false,
    requiresHardKill: false,
    errorCode: 'DRIVER_NOT_STARTED',
  }
  let exported = { events: [] as EventEnvelope[], throughSeq: 0, complete: false }
  let accounting: unknown = null
  let modelSlots: SessionModelSlotsResult | null = null
  let skillsPolicy: unknown = null
  const abort = new AbortController()
  const interrupt = (): void => abort.abort()
  process.once('SIGTERM', interrupt)
  process.once('SIGINT', interrupt)
  const launch = async (): Promise<void> => {
    daemon = spawn(
      process.execPath,
      [
        join(request.distributionDir, 'daemon.mjs'),
        'start',
        '--home',
        request.home,
        '--profile',
        request.profile,
        '--workspace',
        request.cwd,
        '--socket',
        socket,
        // Pinned home/data default; the guard exemption records why this fixture cannot import dataDir().
        '--data-dir',
        join(request.home, 'data'),
      ],
      {
        cwd: request.cwd,
        env: { ...env, AGH_HOME: request.home, AGNES_PROFILE: request.profile },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    daemon.on('error', () => {
      spawnError = true
    })
    const log = (chunk: Buffer): void => {
      if (daemonText.length < 64 * 1024) daemonText += chunk.toString()
    }
    daemon.stdout?.on('data', log)
    daemon.stderr?.on('data', log)
    client = await ready(socket, daemon, request.startupTimeoutMs ?? 30_000)
    if (spawnError) throw new DriverError('DAEMON_SPAWN_FAILED')
  }
  const stop = async (): Promise<boolean> => {
    if (client) {
      await bounded(
        client.close().catch(() => undefined),
        500,
      )
      client = undefined
    }
    if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return true
    const child = daemon
    const ended = new Promise<boolean>((done) => child.once('exit', () => done(true)))
    child.kill('SIGTERM')
    return (await bounded(ended, request.cancelGraceMs ?? 5000)) !== timedOut
  }
  try {
    await launch()
    if (!client) throw new DriverError('CLIENT_MISSING')
    if (request.config) {
      const saved = await client.config.save(request.config)
      if (saved.effect === 'restart-required') {
        if (!(await stop())) throw new DriverError('CONFIG_RESTART_NOT_SETTLED')
        await launch()
      }
    }
    if (!client) throw new DriverError('CLIENT_MISSING')
    skillsPolicy = { ...(await disableBenchmarkSkills(client.resources, request.profile)), ...skillPaths }
    const catalog = await client.runtime.list()
    const selected = catalog.items.find((item) => item.id === request.runtime)
    if (!selected?.available) throw new DriverError('RUNTIME_UNAVAILABLE')
    runtime = { id: selected.id, version: selected.version }
    await client.workspace.add(request.cwd)
    session = await client.session.new({
      cwd: request.cwd,
      runtime: request.runtime,
      ...(request.preset ? { preset: request.preset } : {}),
    })
    const actual = await session.runtime()
    if (actual.runtime.id !== runtime.id || actual.runtime.version !== runtime.version)
      throw new DriverError('RUNTIME_OWNER_MISMATCH')
    modelSlots = await applyModelConfiguration(session, request)
    session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
    await session.attach({ filter: { acpUpdates: false } })
    outcome = await runTurn(
      session,
      request.prompt,
      request.deadlineMs,
      request.cancelGraceMs ?? 5000,
      abort.signal,
    )
    // Export uses a new handle: the SDK deduplicates raw rows already admitted to this one.
    if (!outcome.requiresHardKill) {
      const exportTimeoutMs = request.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS
      const read = exportPrefix(
        socket,
        session.id,
        exportTimeoutMs,
        request.exportMaxBytes ?? MAX_EXPORT_BYTES,
      )
      // The shared export deadline bounds reading; three fixed 250ms cleanup steps remain outside it.
      const result = await bounded(read, exportTimeoutMs + 1000)
      if (result !== timedOut) exported = result
      outcome = recoverTerminalSequence(outcome, exported)
      try {
        accounting = await client.call('_agnes/v1/session.accounting', { sessionId: session.id })
      } catch {
        /* Missing accounting remains null and coverage remains false. */
      }
    }
  } catch (error) {
    outcome = { ...outcome, status: 'driver_error', errorCode: safeCode(error) }
  } finally {
    const stopped = await stop()
    outcome.requiresHardKill ||= !stopped
    process.removeListener('SIGTERM', interrupt)
    process.removeListener('SIGINT', interrupt)
  }
  const accountingComplete =
    record(accounting) &&
    record(accounting.accounting) &&
    accounting.accounting.state === 'complete' &&
    accounting.accounting.throughSeq === exported.throughSeq
  const result = {
    schemaVersion: 1,
    ...outcome,
    runtime,
    sessionId: session?.id ?? null,
    evidence: { eventsComplete: exported.complete, accountingComplete, accountingScope: 'root-session' },
  }
  await save('result.json', result)
  await save('accounting.json', accounting)
  await save('model-slots.json', modelSlots)
  await save('skills-policy.json', skillsPolicy)
  await save('trajectory.json', {
    schemaVersion: 1,
    format: 'agh-ledger',
    runtime,
    sessionId: session?.id ?? null,
    throughSeq: exported.throughSeq,
    complete: exported.complete,
    events: exported.events,
  })
  const rows = exported.events.map((event) => JSON.stringify(sanitize(event)))
  await writeFile(join(outputDir, 'events.jsonl'), rows.length ? `${rows.join('\n')}\n` : '', { mode: 0o600 })
  await writeFile(join(outputDir, 'daemon.log'), String(sanitize(daemonText)), { mode: 0o600 })
  return outcome.requiresHardKill ? 3 : outcome.status === 'driver_error' ? 2 : 0
}

export function boundConfig(request: DriverRequest, env: NodeJS.ProcessEnv): DriverRequest {
  // Harbor redacts environment bindings whose name contains SECRET in its persisted agent config.
  const input = env.AGH_TB_CONFIG_SECRET_JSON ?? env.AGH_TB_CONFIG_JSON
  if (!input) return request
  if (request.config !== undefined) throw new DriverError('CONFIG_SOURCE_CONFLICT')
  try {
    return parseRequest({ ...request, config: JSON.parse(input) })
  } catch {
    throw new DriverError('CONFIG_INVALID')
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length !== 4 || argv[0] !== '--request' || argv[2] !== '--output-dir')
    throw new DriverError('ARGUMENTS_INVALID')
  const request = boundConfig(
    parseRequest(JSON.parse(await readFile(argv[1] as string, 'utf8'))),
    process.env,
  )
  return runDriver(request, resolve(argv[3] as string))
}

function isMain(): boolean {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
    )
  } catch {
    return false
  }
}

if (isMain()) {
  main()
    .then((code) => {
      // Artifacts settled. The outer watchdog owns a daemon which refuses graceful shutdown.
      process.exit(code)
    })
    .catch(() => {
      // Paths, config and upstream error bodies can contain credentials. Never print them.
      process.stderr.write('Terminal-Bench driver failed before artifact settlement.\n')
      process.exit(2)
    })
}
