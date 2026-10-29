import { createHash } from 'node:crypto'
import type {
  LoopContext,
  LoopFactory,
  LoopSideCallPort,
  PreparedSideCall,
  SideCallOptions,
  SideCallResult,
  SideCallStatus,
} from '@agnes/extension-api'
import type { JsonValue } from '../../src/types.js'
import { canonicalJson } from '../../src/util.js'

type PickSpec = { pick?: Record<string, string>; confidence?: number; ambiguity?: number; progress?: number }
// The never keys let a plain `{}` sit in a union with the other acts.
type PickAct = PickSpec & {
  failed?: never
  prepareThrows?: never
  invokeThrows?: never
  unknown?: never
  answers?: never
  refused?: never
}
type Failure = {
  reason: 'deadline' | 'cancelled' | 'adapter-error' | 'invalid-output'
  code?: string
  retryable: boolean
  retryAfterMs?: number
}

/** What the scripted Jev does with one call. */
export type JevAct =
  | PickAct
  | { failed: Failure }
  | { prepareThrows: string }
  | { invokeThrows: string }
  | { unknown: true }
  | { refused: 'budget' | 'usage-unrecorded' }
  | { answers: unknown }

export type FakeJev = LoopSideCallPort & {
  prepared: SideCallOptions[]
  invoked: string[]
  records: Map<string, SideCallResult>
}

export const PICK_RESPOND = { phase: 'RESPOND' }
export const PICK_LS = { phase: 'INSPECT', action__inspect: 'ls', target__inspect__ls: 'DEFAULT_ARGUMENTS' }
export const PICK_WRITE = { phase: 'ACT', action__act: 'write' }
// A file that was read has candidates, so the target and the mode are named: the first option would bind a target.
export const PICK_READ = {
  phase: 'INSPECT',
  action__inspect: 'read',
  target__inspect__read: 'LLM_PARAMETERS',
  target_mode__inspect__read: 'one',
}

const thrown = (code: string) => Object.assign(new Error(`scripted ${code}`), { code })
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function choice(options: string[], selected: string, confidence: number): Record<string, JsonValue> {
  const rest = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0
  const probabilities = Object.fromEntries(
    options.map((id) => [id, id === selected ? (options.length > 1 ? confidence : 1) : rest]),
  )
  return { choice: selected, confidence, probabilities }
}

/**
 * Answers for every head: a choice head takes `pick[head]` or its first option, at `confidence`
 * (default 0.9) with the rest split evenly (a single option gets probability 1); the meta heads
 * answer `ambiguity` (default 0.1) and `progress` (default 1).
 */
export function answersFor(questions: Record<string, unknown>, act: PickSpec): Record<string, JsonValue> {
  const answers: Record<string, JsonValue> = {}
  for (const [head, question] of Object.entries(questions)) {
    if (head === 'meta_ambiguity') answers[head] = { type: 'noul', noul: act.ambiguity ?? 0.1 }
    else if (head === 'meta_progress')
      answers[head] = { type: 'score', score: act.progress ?? 1, confidence: 0.6 }
    else if (isObject(question) && question.type === 'choice' && isObject(question.criteria)) {
      const options = Object.keys(question.criteria)
      const selected = act.pick?.[head] ?? options[0]
      if (selected !== undefined) answers[head] = choice(options, selected, act.confidence ?? 0.9)
    }
  }
  return answers
}

const usage = {
  tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
  credits: 0,
  creditSource: 'estimated',
} as const

function resultOf(act: JevAct, invocationId: string, questions: Record<string, unknown>): SideCallResult {
  if ('refused' in act && act.refused !== undefined)
    return { status: 'refused', invocationId, reason: act.refused }
  if ('unknown' in act && act.unknown === true)
    return { status: 'unknown', invocationId, reason: 'interrupted', replayed: false }
  if ('failed' in act && act.failed !== undefined) {
    const { code, retryAfterMs, ...rest } = act.failed
    return {
      status: 'failed',
      invocationId,
      ...rest,
      ...(code === undefined ? {} : { code: code as never }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      dispatch: 'may-have-sent',
      latencyMs: 5,
      replayed: false,
    }
  }
  const json = ('answers' in act ? act.answers : answersFor(questions, act as PickSpec)) as JsonValue
  return {
    status: 'ok',
    invocationId,
    text: JSON.stringify(json),
    json,
    usage,
    latencyMs: 5,
    replayed: false,
  }
}

/**
 * A scripted side-call port. `script(n, questions)` decides each call when it is prepared, where `n`
 * is the number of calls sent so far. A sent call is recorded by id: invoking that id again replays
 * the record, and `status` reads it back as `finished`.
 */
export function fakeJev(script: (n: number, questions: Record<string, unknown>) => JevAct): FakeJev {
  const prepared: SideCallOptions[] = []
  const invoked: string[] = []
  const records = new Map<string, SideCallResult>()
  const pending = new WeakMap<object, { act: JevAct; questions: Record<string, unknown> }>()
  const labels = new Map<string, { label: string; requestHash: string }>()
  let generated = 0

  return {
    prepared,
    invoked,
    records,
    async prepare(options) {
      prepared.push(options)
      const payload = options.payload
      const questions = isObject(payload) && isObject(payload.questions) ? payload.questions : {}
      const act = script(invoked.length, questions)
      if ('prepareThrows' in act && act.prepareThrows !== undefined) throw thrown(act.prepareThrows)
      const invocationId = options.invocationId ?? `side-${generated++}`
      const request = { label: options.label, target: options.target, payload: options.payload ?? null }
      const call = Object.freeze({
        invocationId,
        label: options.label,
        target: Object.freeze({ ...options.target }),
        adapter: null,
        deadlineMs: options.deadlineMs ?? 10000,
        requestHash: createHash('sha256')
          .update(canonicalJson(request as JsonValue))
          .digest('hex'),
        estimate: Object.freeze({
          inputTokens: 100,
          source: 'estimate',
          projectedCredits: null,
          contextWindow: 65536,
        }),
      })
      pending.set(call, { act, questions })
      return call as unknown as PreparedSideCall
    },
    async invoke(call) {
      const recorded = records.get(call.invocationId)
      if (recorded !== undefined) {
        if (labels.get(call.invocationId)?.requestHash !== call.requestHash) {
          throw Object.assign(thrown('E_RELATION'), { detail: { reason: 'invocation-reused' } })
        }
        return { ...recorded, replayed: true } as SideCallResult
      }
      const entry = pending.get(call)
      if (entry === undefined) throw thrown('E_REQUEST_FROZEN')
      if ('invokeThrows' in entry.act && entry.act.invokeThrows !== undefined)
        throw thrown(entry.act.invokeThrows)
      invoked.push(call.invocationId)
      const result = resultOf(entry.act, call.invocationId, entry.questions)
      records.set(call.invocationId, result)
      labels.set(call.invocationId, { label: call.label, requestHash: call.requestHash })
      return result
    },
    async status(invocationId): Promise<SideCallStatus> {
      const result = records.get(invocationId)
      const meta = labels.get(invocationId)
      if (result === undefined || meta === undefined) return { status: 'absent', invocationId }
      return { status: 'finished', invocationId, ...meta, result }
    },
  }
}

/**
 * The same factory, with `jev` behind the `ctx.sideCall` its drivers see. Every other port is the
 * original context's, reached through the prototype. A function picks the port for each context,
 * for example one fake per session, since a fake keeps its records by invocation id.
 */
export function withJev(
  factory: LoopFactory,
  jev: LoopSideCallPort | ((ctx: LoopContext) => LoopSideCallPort),
): LoopFactory {
  const wrap = (ctx: LoopContext): LoopContext =>
    Object.create(ctx, {
      sideCall: { value: typeof jev === 'function' ? jev(ctx) : jev, enumerable: true },
    }) as LoopContext
  return {
    id: factory.id,
    version: factory.version,
    codec: factory.codec,
    capabilities: factory.capabilities,
    ...(factory.controls ? { controls: factory.controls } : {}),
    ...(factory.checkpointMode ? { checkpointMode: factory.checkpointMode } : {}),
    create: (ctx, stop) => factory.create(wrap(ctx), stop),
    resume: (ctx, checkpoint, stop) => factory.resume(wrap(ctx), checkpoint, stop),
  }
}
