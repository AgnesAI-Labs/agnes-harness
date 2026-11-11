import { createHash } from 'node:crypto'
import type {
  ManagedSessionEvent,
  ManagedSessionEvents,
  ManagedSessionResult,
  ManagedSessionStartInput,
  ManagedSessionStatus,
  ManagedSessionSummary,
  ManagedSessions,
  ManagedSessionToolResult,
  ManagedSessionUsage,
} from '@agnes/extension-api'
import type { Actor, SessionActivity, SessionViewResult } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import type { ManagedSessionRecord, ManagedSessionRecords } from './managed-session-records.js'

/** The Host-verified row a managed service runs for; rechecked by `authorize` on every call. */
export interface ManagedSessionCaller {
  readonly owner: string
  readonly packageId: string
  readonly integrity: string
  readonly service: string
}

export interface ManagedToolDetail {
  call: { name: string }
  result?: { content: readonly { type: string; text?: string }[]; isError: boolean }
}

export interface ManagedSessionPorts {
  /** Refuses unless the row is current, enabled and trusted and its service declares `sessions`. */
  authorize(caller: ManagedSessionCaller): Promise<void>
  records: ManagedSessionRecords
  /** The session an owner's fork was taken from; throws when ownership cannot be read. */
  forkParent(sessionId: string): string | undefined
  /** The registered, present workspace root for a path; throws when there is none. */
  workspaceRoot(path: string): Promise<string>
  /** The same review an application launch gets; throws for a Bundle that is not reviewed and enabled. */
  resolveAgent(bundle: string): Promise<void>
  models(): Promise<readonly { route: string; model: string }[]>
  autoReview(): Promise<boolean>
  /**
   * What the daemon knows before a session exists; there is no tool policy to read yet. Whether its
   * opener turns outward command rules on for managed sessions, and whether the platform's sandbox
   * probe reports a full OS boundary.
   */
  fullAccess(): Promise<{ outwardCheckpoint: boolean; osBoundary: boolean }>
  sessions: {
    create(input: { sessionKey: string; cwd: string; agent: string }): Promise<string>
    setModel(sessionId: string, model: { route: string; model: string }): Promise<void>
    setFullAccess(sessionId: string): Promise<void>
    /**
     * Opens the session, then reads what it actually runs with: full access (a Bundle preset can
     * grant it without a request), its sandbox enforcement, and whether the policy deciding its
     * next call holds outward calls for a person.
     */
    policy(
      sessionId: string,
    ): Promise<{ fullAccess: boolean; osBoundary: boolean; outwardCheckpoint: boolean }>
    /** Queues only into an empty inbox and runs the turn; a repeated `commandId` is not queued again. */
    submit(
      sessionId: string,
      input: { text: string; actor: Actor; commandId: string },
    ): Promise<'started' | 'busy'>
    loaded(sessionId: string): boolean
    activity(): Promise<readonly SessionActivity[]>
    view(sessionId: string): Promise<SessionViewResult>
    toolDetail(sessionId: string, callSeq: number): Promise<ManagedToolDetail>
    /**
     * The identity the owner's approvals carry, or undefined when it cannot be read. An approval is
     * reported as given by a person only when this identity answered it.
     */
    ownerApprover(sessionId: string): Promise<string | undefined>
    cancel(sessionId: string): Promise<void>
    archive(sessionId: string): Promise<void>
  }
}

type View = SessionViewResult['timeline']
type Turn = View['turns'][number]
const ENDED = new Set(['completed', 'failed', 'cancelled'])

/** Computed from runtime facts: a waiting turn is still active, flagged with what it waits for. */
export function managedSessionStatus(facts: {
  loaded: boolean
  activity: SessionActivity | undefined
  lastTurn: Pick<Turn, 'status' | 'reason'> | undefined
}): ManagedSessionStatus {
  const { activity } = facts
  if (activity?.state === 'running') return { kind: 'active', flags: [] }
  if (activity?.state === 'waiting')
    return {
      kind: 'active',
      flags: [activity.waiting === 'question' ? 'waitingOnUserInput' : 'waitingOnApproval'],
    }
  if (!facts.loaded) return { kind: 'notLoaded', flags: [] }
  return facts.lastTurn?.reason === 'error' || facts.lastTurn?.status === 'failed'
    ? { kind: 'systemError', flags: [] }
    : { kind: 'idle', flags: [] }
}

const lastEnded = (view: View) => [...view.turns].reverse().find((turn) => ENDED.has(turn.status))
const joinText = (content: readonly { type: string; text?: string }[]) =>
  content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')

type ApprovalNode = Extract<View['nodes'][number], { kind: 'approval' }>

/**
 * How an approval ended, or undefined while it is pending. `person` needs `via: 'human'` and the
 * owner's own approval identity; every other end, and every answer that cannot be tied to the owner,
 * is `automatic`, so a consumer counting refusals by the owner never counts one it cannot vouch for.
 */
export function approvalOutcome(
  node: ApprovalNode,
  ownerApprover: string | undefined,
): Pick<Extract<ManagedSessionEvent, { kind: 'approvalOutcome' }>, 'outcome' | 'via'> | undefined {
  if (node.state === 'expired') return { outcome: 'expired', via: 'automatic' }
  if (node.state !== 'decided') return undefined
  const verdict = node.decision?.verdict
  const outcome =
    verdict === 'rejected' ? 'rejected' : verdict?.startsWith('allowed-') ? 'allowed' : undefined
  if (!outcome) return undefined
  const via = node.decision?.via
  if (via === 'full-access') return { outcome, via }
  const byLabel = node.decision?.byLabel
  const person = via === 'human' && ownerApprover !== undefined && byLabel === ownerApprover
  return { outcome, via: person ? 'person' : 'automatic' }
}

/** Whether `projectEvents` would need the owner's identity to classify an outcome after `afterSeq`. */
export function needsOwnerApprover(view: SessionViewResult, afterSeq = 0): boolean {
  return view.timeline.nodes.some(
    (node) =>
      node.kind === 'approval' &&
      node.state === 'decided' &&
      node.decision?.via === 'human' &&
      (node.decidedSeq ?? 0) > afterSeq,
  )
}

/** The events after a cursor; the owner's identity is read only when an outcome needs it. */
async function readEvents(
  ports: Pick<ManagedSessionPorts, 'sessions'>,
  sessionId: string,
  afterSeq?: number,
) {
  const view = await ports.sessions.view(sessionId)
  const owner = needsOwnerApprover(view, afterSeq)
    ? await ports.sessions.ownerApprover(sessionId).catch(() => undefined)
    : undefined
  return projectEvents(view, afterSeq, owner)
}

export function projectEvents(
  view: SessionViewResult,
  afterSeq = 0,
  ownerApprover?: string,
): ManagedSessionEvents {
  const out: ManagedSessionEvent[] = []
  for (const node of view.timeline.nodes) {
    if (node.seq === undefined) continue
    if (node.kind === 'approval' && node.decidedSeq !== undefined && node.decidedSeq > afterSeq) {
      const ended = approvalOutcome(node, ownerApprover)
      if (node.seq > afterSeq) out.push(approvalEvent(node, node.seq))
      if (ended) out.push({ kind: 'approvalOutcome', seq: node.decidedSeq, approvalSeq: node.seq, ...ended })
      continue
    }
    if (node.seq <= afterSeq) continue
    if (node.kind === 'assistant' && node.text && !node.streaming)
      out.push({ kind: 'text', seq: node.seq, text: node.text })
    else if (node.kind === 'tool')
      out.push({
        kind: 'tool',
        seq: node.seq,
        name: node.name,
        status: node.status,
        ...(node.resultSeq !== undefined ? { resultSeq: node.resultSeq } : {}),
      })
    else if (node.kind === 'approval') out.push(approvalEvent(node, node.seq))
  }
  for (const turn of view.timeline.turns) {
    const seq = turn.endSeq ?? turn.startSeq
    if (seq <= afterSeq) continue
    out.push({
      kind: 'turn',
      seq,
      turn: turn.turn,
      status: turn.status,
      ...(turn.reason ? { reason: turn.reason } : {}),
      ...(turn.error ? { error: { code: turn.error.code, message: turn.error.message } } : {}),
    })
  }
  out.sort((a, b) => a.seq - b.seq)
  return { events: out, lastSeq: Math.max(afterSeq, view.lastSeq) }
}

function approvalEvent(node: ApprovalNode, seq: number): ManagedSessionEvent {
  return {
    kind: 'approval',
    seq,
    state: node.state,
    category: node.category ?? 'permission',
    summary: node.summary,
    ...(node.toolName ? { toolName: node.toolName } : {}),
  }
}

export function projectResult(view: View): ManagedSessionResult {
  const turn = lastEnded(view)
  if (!turn) return { turn: null, text: null }
  const ids = new Set(turn.nodeIds)
  const last = [...view.nodes]
    .reverse()
    .find((node) => ids.has(node.id) && node.kind === 'assistant' && node.text.length > 0)
  return {
    turn: {
      status: turn.status as 'completed' | 'failed' | 'cancelled',
      ...(turn.reason ? { reason: turn.reason } : {}),
    },
    text: last?.kind === 'assistant' ? last.text : null,
  }
}

/** Incomplete billing is a lower bound, so it reads as unknown rather than as a cost. */
export function projectUsage(view: View): ManagedSessionUsage {
  const usage = view.usage
  if (!usage) return { inputTokens: null, outputTokens: null, cost: null }
  return {
    inputTokens: usage.totals.input,
    outputTokens: usage.totals.output,
    cost:
      usage.cost && usage.billingComplete !== false
        ? { amount: usage.cost.usdMicros / 1_000_000, currency: 'USD' }
        : null,
  }
}

export function projectToolResult(detail: ManagedToolDetail): ManagedSessionToolResult {
  return {
    name: detail.call.name,
    state: detail.result ? 'done' : 'pending',
    isError: detail.result?.isError ?? false,
    text: joinText(detail.result?.content ?? []),
    exitCode: shellExitCode(detail),
  }
}

/** The shell writes `[exit N]` as its own last line, after everything the command printed. */
export function shellExitCode(detail: ManagedToolDetail): number | null {
  if (detail.call.name !== 'shell' || !detail.result) return null
  const output = joinText(detail.result.content)
  const match = /\[exit (-?\d+)\](?: \[output truncated by sandbox\])?\s*$/u.exec(output)
  if (!match) return null
  const code = Number(match[1])
  return (code === 0) === !detail.result.isError ? code : null
}

/** Generations and forks a lineage walk follows before it refuses. */
const MAX_LINEAGE = 64

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Backend-generated input identity. No chat RPC accepts it. */
export function managedSessionActor(
  owner: string,
  record: Pick<ManagedSessionRecord, 'retention' | 'memoryWrites'>,
): Actor {
  return {
    id: `plugin:${owner.replace(/^plugin\//u, '')}`,
    org: 'plugin',
    role: 'trigger',
    deptPath: [],
    attrs: {
      // Nobody attends the turn now; the owner answers later in the Web or a bound channel.
      unattendedApproval: 'notify',
      managedBy: owner,
      ...(record.retention === 'ephemeral' ? { experience: 'excluded' } : {}),
      ...(record.memoryWrites ? {} : { memoryWrites: 'off' }),
    },
  }
}

const refuse = (reason: string, detail: Record<string, unknown> = {}) =>
  rpcError('CAPABILITY_DENIED', { reason, ...detail })

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')

/** Skill installs are refused in a session descended from a managed one that turned them off. */
const lineageSkillInstallsOff = (
  ports: Pick<ManagedSessionPorts, 'records' | 'forkParent'>,
  sessionId: string,
) => lineageSome(ports, sessionId, (record) => record?.skillInstalls === false)

/**
 * Whether a session must run with outward command rules on: it is managed, is being created as one
 * (`opening`), or descends from one. The daemon's session opener asks this on every open.
 */
export function managedLineage(
  ports: Pick<ManagedSessionPorts, 'records' | 'forkParent'>,
  opening: ReadonlySet<string>,
  sessionId: string,
): boolean {
  return lineageSome(ports, sessionId, (record, key) => record !== undefined || opening.has(key))
}

/** The checks a start's input names; run again on every start, a resumed one included, and every send. */
async function startGates(
  ports: ManagedSessionPorts,
  caller: ManagedSessionCaller,
  input: Pick<ManagedSessionStartInput, 'workspace' | 'model' | 'permission' | 'bundle'>,
): Promise<string> {
  let root: string
  try {
    root = await ports.workspaceRoot(input.workspace)
  } catch {
    throw refuse('WORKSPACE_NOT_AUTHORIZED')
  }
  if (!ports.records.granted(caller.owner, root)) throw refuse('WORKSPACE_NOT_AUTHORIZED')
  const model = input.model
  if (model && !(await ports.models()).some((m) => m.route === model.route && m.model === model.model))
    throw refuse('MODEL_ROUTE_MISSING')
  if (input.permission === 'full-access') {
    const gates = await ports.fullAccess()
    if (!gates.outwardCheckpoint) throw refuse('FULL_ACCESS_UNAVAILABLE', { missing: 'outward-checkpoint' })
    if (!gates.osBoundary) throw refuse('FULL_ACCESS_UNAVAILABLE', { missing: 'os-boundary' })
  }
  if (await ports.autoReview()) throw refuse('AUTO_REVIEW')
  try {
    await ports.resolveAgent(input.bundle)
  } catch {
    throw refuse('BUNDLE_UNAVAILABLE')
  }
  return root
}

/**
 * Whether the session, or any session it descends from, has a managed record that passes `test`.
 * Core keys a child session under its parent's key, and an owner's fork names its parent in
 * ownership. A lineage that loops or runs past the bound answers true, and one that cannot be read
 * throws, so a caller that refuses on either fails closed.
 */
function lineageSome(
  ports: Pick<ManagedSessionPorts, 'records' | 'forkParent'>,
  sessionId: string,
  test: (record: ManagedSessionRecord | undefined, key: string) => boolean,
): boolean {
  const known = new Map<string, boolean>()
  const path = new Set<string>()
  const off = (key: string): boolean => {
    const answer = known.get(key)
    if (answer !== undefined) return answer
    if (path.has(key) || path.size >= MAX_LINEAGE || known.size >= MAX_LINEAGE * 4) return true
    path.add(key)
    const parent = ports.forkParent(key)
    const slash = key.lastIndexOf('/')
    const result =
      test(ports.records.get(key), key) ||
      (parent !== undefined && off(parent)) ||
      (slash > 0 && off(key.slice(0, slash)))
    path.delete(key)
    known.set(key, result)
    return result
  }
  return off(sessionId)
}

export function createManagedSessions(ports: ManagedSessionPorts) {
  const chains = new Map<string, Promise<unknown>>()
  const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    chains.set(key, next)
    void next
      .finally(() => {
        if (chains.get(key) === next) chains.delete(key)
      })
      .catch(() => undefined)
    return next
  }
  const own = (caller: ManagedSessionCaller, sessionId: unknown): ManagedSessionRecord => {
    const record = typeof sessionId === 'string' ? ports.records.get(sessionId) : undefined
    // Another row's session and an unknown id are indistinguishable to the caller.
    if (!record || record.owner !== caller.owner) throw rpcError('CAPABILITY_DENIED')
    return record
  }
  const status = async (record: ManagedSessionRecord, activity?: readonly SessionActivity[]) => {
    const items = activity ?? (await ports.sessions.activity())
    const loaded = ports.sessions.loaded(record.sessionId)
    const current = items.find((item) => item.sessionId === record.sessionId)
    const lastTurn =
      loaded && current === undefined
        ? (await ports.sessions.view(record.sessionId)).timeline.turns.at(-1)
        : undefined
    return managedSessionStatus({ loaded, activity: current, lastTurn })
  }
  /**
   * The refusal for a session that may not run a turn: every managed session needs the outward
   * checkpoint on its live policy, and effective full access also needs a full OS boundary.
   */
  const runningGateMissing = async (sessionId: string) => {
    const effective = await ports.sessions.policy(sessionId)
    if (!effective.outwardCheckpoint)
      return effective.fullAccess
        ? refuse('FULL_ACCESS_UNAVAILABLE', { missing: 'outward-checkpoint' })
        : refuse('OUTWARD_CHECKPOINT_UNAVAILABLE')
    return effective.fullAccess && !effective.osBoundary
      ? refuse('FULL_ACCESS_UNAVAILABLE', { missing: 'os-boundary' })
      : undefined
  }
  const archive = async (record: ManagedSessionRecord) => {
    await ports.sessions.archive(record.sessionId)
    ports.records.markArchived(record.sessionId)
  }

  const start = async (caller: ManagedSessionCaller, input: ManagedSessionStartInput) => {
    if (
      !text(input?.startKey, 256) ||
      !text(input.input, 65536) ||
      !text(input.workspace, 4096) ||
      !text(input.bundle, 512) ||
      (input.retention !== 'task' && input.retention !== 'ephemeral') ||
      (input.permission !== undefined &&
        input.permission !== 'default' &&
        input.permission !== 'full-access') ||
      (input.model !== undefined && (!text(input.model.route, 256) || !text(input.model.model, 256))) ||
      (input.memoryWrites !== undefined && typeof input.memoryWrites !== 'boolean') ||
      (input.skillInstalls !== undefined && typeof input.skillInstalls !== 'boolean')
    )
      throw rpcError('INVALID_PARAMS')
    if (!input.bundle.startsWith(`${caller.packageId}#`)) throw refuse('BUNDLE_NOT_OWN')
    const wanted = {
      bundle: input.bundle,
      retention: input.retention,
      permission: input.permission ?? 'default',
      model: input.model ? `${input.model.route}\0${input.model.model}` : null,
      memoryWrites: input.memoryWrites !== false,
      skillInstalls: input.skillInstalls !== false,
    } as const
    return serial(`start\0${caller.owner}\0${input.startKey}`, async () => {
      // Every start, resumed or not, passes the gates its input names before anything is applied.
      const root = await startGates(ports, caller, input)
      let record = ports.records.byStartKey(caller.owner, input.startKey)
      if (record) {
        const same =
          record.workspace === root &&
          (Object.keys(wanted) as (keyof typeof wanted)[]).every((k) => record?.[k] === wanted[k])
        if (!same) throw refuse('START_KEY_REUSED')
        if (record.archived) throw refuse('SESSION_ARCHIVED')
        if (record.started) return { sessionId: record.sessionId, created: false }
      }
      const created = record === undefined
      if (!record) {
        // Derived, so a crash between creating and recording reopens the same session.
        const sessionKey = `managed-${digest(`${caller.owner}\0${input.startKey}`).slice(0, 40)}`
        // Marked before it is created, so its first open already asks for outward command rules.
        ports.records.opening.add(sessionKey)
        try {
          const sessionId = await ports.sessions.create({ sessionKey, cwd: root, agent: input.bundle })
          ports.records.insert({
            sessionId,
            owner: caller.owner,
            startKey: input.startKey,
            workspace: root,
            ...wanted,
          })
        } finally {
          ports.records.opening.delete(sessionKey)
        }
        record = ports.records.byStartKey(caller.owner, input.startKey) as ManagedSessionRecord
      }
      if (input.model) await ports.sessions.setModel(record.sessionId, input.model)
      if (input.permission === 'full-access') await ports.sessions.setFullAccess(record.sessionId)
      const missing = await runningGateMissing(record.sessionId)
      if (missing) {
        await archive(record)
        throw missing
      }
      const actor = managedSessionActor(caller.owner, record)
      const submitted = await ports.sessions.submit(record.sessionId, {
        text: input.input,
        actor,
        commandId: `${actor.id}:start:${digest(input.startKey).slice(0, 32)}`,
      })
      // Left unstarted, so a retry with the same key queues the opening input then.
      if (submitted === 'busy') throw refuse('SESSION_BUSY')
      ports.records.markStarted(record.sessionId)
      return { sessionId: record.sessionId, created }
    })
  }

  const send = async (
    caller: ManagedSessionCaller,
    sessionId: string,
    input: { text: string; idempotencyKey: string },
  ) => {
    const record = own(caller, sessionId)
    if (!text(input?.text, 65536) || !text(input.idempotencyKey, 256)) throw rpcError('INVALID_PARAMS')
    return serial(`session\0${record.sessionId}`, async () => {
      const current = ports.records.get(record.sessionId) as ManagedSessionRecord
      if (current.archived) return { state: 'notSubmitted', reason: 'archived' } as const
      const key = input.idempotencyKey
      const recorded = ports.records.sendState(caller.owner, record.sessionId, key)
      if (recorded === 'sent') return { state: 'notSubmitted', reason: 'duplicateKey' } as const
      // A pending key is a send interrupted after it was recorded: retry it, deduplicated below.
      if (recorded === undefined && (await status(current)).kind === 'active')
        return { state: 'notSubmitted', reason: 'busy' } as const
      // A new turn needs what the start needed: a revoked grant or a lost gate refuses it. A running
      // turn is left to finish; the plugin and the owner can still interrupt it.
      const [route, model] = current.model?.split('\0') ?? []
      await startGates(ports, caller, {
        workspace: current.workspace,
        bundle: current.bundle,
        permission: current.permission,
        ...(route !== undefined && model !== undefined ? { model: { route, model } } : {}),
      })
      const missing = await runningGateMissing(current.sessionId)
      if (missing) throw missing
      ports.records.setSend(caller.owner, record.sessionId, key, 'pending')
      const actor = managedSessionActor(caller.owner, current)
      const outcome = await ports.sessions.submit(record.sessionId, {
        text: input.text,
        actor,
        commandId: `${actor.id}:send:${digest(key).slice(0, 32)}`,
      })
      if (outcome === 'busy') {
        ports.records.setSend(caller.owner, record.sessionId, key, undefined)
        return { state: 'notSubmitted', reason: 'busy' } as const
      }
      ports.records.setSend(caller.owner, record.sessionId, key, 'sent')
      return { state: 'started' } as const
    })
  }

  const result = async (record: ManagedSessionRecord): Promise<ManagedSessionResult> => {
    const view = (await ports.sessions.view(record.sessionId)).timeline
    const value = projectResult(view)
    const turn = lastEnded(view)
    if (record.retention === 'ephemeral' && !record.archived && turn && view.turns.at(-1) === turn)
      await archive(record)
    return value
  }

  const toolResult = async (
    record: ManagedSessionRecord,
    callSeq: number,
  ): Promise<ManagedSessionToolResult> => {
    if (!Number.isSafeInteger(callSeq) || callSeq < 1) throw rpcError('INVALID_PARAMS')
    return projectToolResult(await ports.sessions.toolDetail(record.sessionId, callSeq))
  }

  const skillInstallsOff = (sessionId: string) => lineageSkillInstallsOff(ports, sessionId)

  /** The port one managed service row receives. Every call rechecks the row first. */
  const port = (caller: ManagedSessionCaller): ManagedSessions => {
    const guarded =
      <A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        await ports.authorize(caller)
        return work(...args)
      }
    return {
      start: guarded((input) => start(caller, input)),
      send: guarded((sessionId, input) => send(caller, sessionId, input)),
      list: guarded(async (): Promise<ManagedSessionSummary[]> => {
        const activity = await ports.sessions.activity()
        return Promise.all(
          ports.records
            .list(caller.owner)
            .filter((record) => record.started)
            .map(async (record) => ({
              sessionId: record.sessionId,
              startKey: record.startKey,
              bundle: record.bundle,
              workspace: record.workspace,
              retention: record.retention,
              archived: record.archived,
              status: await status(record, activity),
            })),
        )
      }),
      status: guarded((sessionId) => status(own(caller, sessionId))),
      events: guarded((sessionId, options) =>
        readEvents(ports, own(caller, sessionId).sessionId, options?.afterSeq),
      ),
      result: guarded((sessionId) => result(own(caller, sessionId))),
      usage: guarded(async (sessionId) =>
        projectUsage((await ports.sessions.view(own(caller, sessionId).sessionId)).timeline),
      ),
      toolResult: guarded((sessionId, callSeq) => toolResult(own(caller, sessionId), callSeq)),
      interrupt: guarded((sessionId) => ports.sessions.cancel(own(caller, sessionId).sessionId)),
      archive: guarded((sessionId) => archive(own(caller, sessionId))),
    }
  }
  return Object.assign(port, { skillInstallsOff })
}
