import type { LoopCheckpoint, LoopCheckpointCodec } from '@agnes/extension-api'
import type { Counters, JevState, JsonValue } from './types.js'
import { clip, tail, utf8Bytes } from './util.js'

/** The encoded state stays within this many UTF-8 bytes; every invocation receipt copies it. */
export const CHECKPOINT_MAX_BYTES = 32768

export function emptyCounters(): Counters {
  return {
    jevCalls: 0,
    jevRetries: 0,
    decisionFailures: { MODEL_UNAVAILABLE: 0, INVALID_PROPOSAL: 0 },
    llm: { parameters: 0, arbitration: 0, answer: 0, retries: 0 },
    directSteps: 0,
    directSuccess: 0,
    arbitrationAgreed: 0,
    arbitrationOverturned: 0,
    droppedCalls: 0,
    answerDeclined: 0,
    noCall: 0,
    emitted: 0,
    droppedEvents: 0,
  }
}

export function initialState(): JevState {
  return {
    v: 1,
    idTurn: null,
    coreTurn: null,
    stage: 'idle',
    step: 0,
    toolNames: [],
    toolNamesChanges: 0,
    cur: { jevAttempts: [], level: 0 },
    pendingNotes: [],
    workspace: { goal: '', previousAnswer: '', answer: '', notes: [], history: [], turnStart: 0 },
    counters: emptyCounters(),
    internalErrors: 0,
  }
}

// ---------------------------------------------------------------------------------------------
// Strict validation

type Obj = { [key: string]: unknown }

const fail = (path: string): never => {
  throw new Error(`Invalid Jev loop checkpoint at ${path}`)
}
const isObj = (value: unknown): value is Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const obj = (value: unknown, path: string): Obj => (isObj(value) ? value : fail(path))
const str = (value: unknown, path: string): string => (typeof value === 'string' ? value : fail(path))
const bool = (value: unknown, path: string): boolean => (typeof value === 'boolean' ? value : fail(path))
const int = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(path)
const num = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(path)
const oneOf = (value: unknown, allowed: readonly string[], path: string): string =>
  typeof value === 'string' && allowed.includes(value) ? value : fail(path)
const arr = (value: unknown, path: string): unknown[] => (Array.isArray(value) ? value : fail(path))
const strings = (value: unknown, path: string): void => {
  for (const [i, item] of arr(value, path).entries()) str(item, `${path}[${i}]`)
}
const orNull = (value: unknown, check: (v: unknown, p: string) => unknown, path: string): void => {
  if (value !== null) check(value, path)
}
/** An optional key: absent is fine, `undefined` or a wrong type is not. */
const optional = (
  parent: Obj,
  key: string,
  check: (v: unknown, p: string) => unknown,
  path: string,
): void => {
  if (Object.hasOwn(parent, key)) check(parent[key], path === '' ? key : `${path}.${key}`)
}
/** Reject keys outside the v1 shape. */
const only = (parent: Obj, allowed: readonly string[], path: string): void => {
  for (const key of Object.keys(parent))
    if (!allowed.includes(key)) fail(path === '' ? key : `${path}.${key}`)
}
const json = (value: unknown, path: string): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    num(value, path)
    return
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) json(item, `${path}[${i}]`)
    return
  }
  for (const [key, item] of Object.entries(obj(value, path))) json(item, `${path}.${key}`)
}

const STAGES = ['idle', 'decide', 'llm', 'dispatch', 'finish', 'parked', 'done']
const PHASES = ['INSPECT', 'ACT', 'VERIFY', 'RESPOND']
const ROUTE_KINDS = ['direct', 'parameters', 'arbitration', 'answer']
const ROUTE_REASONS = ['low_confidence', 'recoverable_observation', 'premature_answer', 'weak_binding']
const LLM_KINDS = ['parameters', 'arbitration', 'answer']
const END_REASONS = [
  'completed',
  'aborted',
  'error',
  'parked',
  'blocked',
  'budget',
  'max_steps',
  'interrupted',
]

function checkStepError(value: unknown, path: string): void {
  const e = obj(value, path)
  str(e.code, `${path}.code`)
  oneOf(e.kind, ['infrastructure', 'proposal', 'execution', 'policy'], `${path}.kind`)
  oneOf(e.stage, ['decision', 'llm', 'dispatch', 'finish'], `${path}.stage`)
  oneOf(e.recoverability, ['recoverable', 'unsafe', 'terminal'], `${path}.recoverability`)
  str(e.message, `${path}.message`)
}

function checkHistoryEntry(value: unknown, path: string): void {
  const h = obj(value, path)
  orNull(h.phase, (v, p) => oneOf(v, PHASES, p), `${path}.phase`)
  orNull(h.operation, str, `${path}.operation`)
  orNull(h.target, (v, p) => (Array.isArray(v) ? strings(v, p) : str(v, p)), `${path}.target`)
  oneOf(h.status, ['succeeded', 'failed', 'refused', 'held'], `${path}.status`)
  oneOf(h.disposition, ['SUCCEEDED', 'NOT_APPLIED', 'UNKNOWN'], `${path}.disposition`)
  str(h.summary, `${path}.summary`)
  orNull(h.intentFp, str, `${path}.intentFp`)
  str(h.observationFp, `${path}.observationFp`)
  bool(h.dispatched, `${path}.dispatched`)
  optional(h, 'exit', (v, p) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : fail(p)), path)
  optional(h, 'error', checkStepError, path)
  optional(h, 'read_files', strings, path)
  optional(h, 'changed_files', strings, path)
  optional(h, 'files_may_have_changed', bool, path)
  optional(h, 'command_excerpt', str, path)
  optional(h, 'output_excerpt', str, path)
}

function checkNote(value: unknown, path: string): void {
  const n = obj(value, path)
  oneOf(n.kind, ['file', 'shell', 'steer'], `${path}.kind`)
  str(n.text, `${path}.text`)
  optional(n, 'target', str, path)
}

function checkTop(value: unknown, path: string): void {
  for (const [i, pair] of arr(value, path).entries()) {
    const entry = arr(pair, `${path}[${i}]`)
    if (entry.length !== 2) fail(`${path}[${i}]`)
    str(entry[0], `${path}[${i}][0]`)
    num(entry[1], `${path}[${i}][1]`)
  }
}

function checkDecision(value: unknown, path: string): void {
  const d = obj(value, path)
  oneOf(d.phase, PHASES, `${path}.phase`)
  str(d.op, `${path}.op`)
  str(d.target, `${path}.target`)
  oneOf(d.bindingMode, ['observed', 'defaults', 'llm_parameters'], `${path}.bindingMode`)
  json(obj(d.args, `${path}.args`), `${path}.args`)
  num(d.confidence, `${path}.confidence`)
  num(d.operationPathConfidence, `${path}.operationPathConfidence`)
  orNull(d.targetConfidence, num, `${path}.targetConfidence`)
  orNull(d.ambiguity, num, `${path}.ambiguity`)
  orNull(d.progress, num, `${path}.progress`)
  checkTop(d.phaseTop, `${path}.phaseTop`)
  checkTop(d.actionTop, `${path}.actionTop`)
  for (const [i, item] of arr(d.consumed, `${path}.consumed`).entries()) {
    const c = obj(item, `${path}.consumed[${i}]`)
    oneOf(c.role, ['phase', 'action', 'target'], `${path}.consumed[${i}].role`)
    orNull(c.head, str, `${path}.consumed[${i}].head`)
    str(c.selected, `${path}.consumed[${i}].selected`)
    orNull(c.confidence, num, `${path}.consumed[${i}].confidence`)
    bool(c.deterministic, `${path}.consumed[${i}].deterministic`)
  }
}

function checkCall(value: unknown, path: string): void {
  const c = obj(value, path)
  str(c.invocationId, `${path}.invocationId`)
  str(c.name, `${path}.name`)
  if (!('args' in c)) fail(`${path}.args`)
  json(c.args, `${path}.args`)
  oneOf(c.announce, ['true', 'content'], `${path}.announce`)
  optional(
    c,
    'content',
    (v, p) => {
      for (const [i, block] of arr(v, p).entries()) {
        const b = obj(block, `${p}[${i}]`)
        oneOf(b.type, ['text', 'thinking'], `${p}[${i}].type`)
        str(b.text, `${p}[${i}].text`)
      }
    },
    path,
  )
}

function checkCurrent(value: unknown, path: string): void {
  const cur = obj(value, path)
  only(cur, ['jevAttempts', 'level', 'decision', 'route', 'llm', 'calls'], path)
  strings(cur.jevAttempts, `${path}.jevAttempts`)
  int(cur.level, `${path}.level`)
  optional(cur, 'decision', checkDecision, path)
  optional(
    cur,
    'route',
    (v, p) => {
      const r = obj(v, p)
      oneOf(r.kind, ROUTE_KINDS, `${p}.kind`)
      orNull(r.reason, (x, q) => oneOf(x, ROUTE_REASONS, q), `${p}.reason`)
    },
    path,
  )
  optional(
    cur,
    'llm',
    (v, p) => {
      const l = obj(v, p)
      oneOf(l.kind, LLM_KINDS, `${p}.kind`)
      int(l.attempt, `${p}.attempt`)
      optional(l, 'note', str, p)
    },
    path,
  )
  optional(
    cur,
    'calls',
    (v, p) => {
      for (const [i, call] of arr(v, p).entries()) checkCall(call, `${p}[${i}]`)
    },
    path,
  )
}

function checkWorkspace(value: unknown, path: string): void {
  const w = obj(value, path)
  str(w.goal, `${path}.goal`)
  str(w.previousAnswer, `${path}.previousAnswer`)
  str(w.answer, `${path}.answer`)
  for (const [i, note] of arr(w.notes, `${path}.notes`).entries()) checkNote(note, `${path}.notes[${i}]`)
  const history = arr(w.history, `${path}.history`)
  for (const [i, entry] of history.entries()) checkHistoryEntry(entry, `${path}.history[${i}]`)
  if (int(w.turnStart, `${path}.turnStart`) > history.length) fail(`${path}.turnStart`)
}

function checkCounters(value: unknown, path: string): void {
  const c = obj(value, path)
  for (const key of Object.keys(emptyCounters())) if (!(key in c)) fail(`${path}.${key}`)
  for (const [key, entry] of Object.entries(c)) {
    if (!isObj(entry)) {
      int(entry, `${path}.${key}`)
      continue
    }
    for (const [sub, n] of Object.entries(entry)) int(n, `${path}.${key}.${sub}`)
  }
  for (const key of ['MODEL_UNAVAILABLE', 'INVALID_PROPOSAL'])
    int(obj(c.decisionFailures, `${path}.decisionFailures`)[key], `${path}.decisionFailures.${key}`)
  for (const key of ['parameters', 'arbitration', 'answer', 'retries'])
    int(obj(c.llm, `${path}.llm`)[key], `${path}.llm.${key}`)
}

const TOP_KEYS = [
  'v',
  'idTurn',
  'coreTurn',
  'stage',
  'step',
  'toolNames',
  'toolNamesChanges',
  'cur',
  'pendingNotes',
  'workspace',
  'counters',
  'internalErrors',
  'endReason',
  'endError',
]

/** Strict check of a decoded checkpoint state; throws on any deviation from the v1 shape. */
export function parseJevState(value: JsonValue): JevState {
  const s = obj(value, 'state')
  only(s, TOP_KEYS, '')
  if (s.v !== 1) fail('v')
  orNull(s.idTurn, int, 'idTurn')
  orNull(s.coreTurn, int, 'coreTurn')
  oneOf(s.stage, STAGES, 'stage')
  int(s.step, 'step')
  strings(s.toolNames, 'toolNames')
  int(s.toolNamesChanges, 'toolNamesChanges')
  checkCurrent(s.cur, 'cur')
  strings(s.pendingNotes, 'pendingNotes')
  checkWorkspace(s.workspace, 'workspace')
  checkCounters(s.counters, 'counters')
  int(s.internalErrors, 'internalErrors')
  optional(s, 'endReason', (v, p) => oneOf(v, END_REASONS, p), '')
  optional(
    s,
    'endError',
    (v, p) => {
      const e = obj(v, p)
      str(e.code, `${p}.code`)
      str(e.message, `${p}.message`)
    },
    '',
  )
  return structuredClone(s) as unknown as JevState
}

// ---------------------------------------------------------------------------------------------
// Encoding

const sizeOf = (state: JevState): number => utf8Bytes(JSON.stringify(state))

/**
 * The checkpoint for a state. When over CHECKPOINT_MAX_BYTES, shrink in this order: histories from
 * before the current turn (oldest first), the previous answer (last 1000 characters), the goal
 * (first 2000 + last 2000 characters), then the command and output excerpts of every history entry
 * but the last. It never throws and never drops current-turn entries, so the result can still be
 * larger when the unbounded fields are large: `cur.llm.note`, `workspace.answer`, `workspace.notes`
 * and `cur.calls[].content`, which the driver is responsible for bounding. The argument is not
 * changed.
 */
export function encodeState(state: JevState): LoopCheckpoint {
  const next = structuredClone(state)
  const w = next.workspace
  while (sizeOf(next) > CHECKPOINT_MAX_BYTES && w.turnStart > 0) {
    w.history.shift()
    w.turnStart--
  }
  if (sizeOf(next) > CHECKPOINT_MAX_BYTES) w.previousAnswer = tail(w.previousAnswer, 1000)
  if (sizeOf(next) > CHECKPOINT_MAX_BYTES && w.goal.length > 4003)
    w.goal = `${clip(w.goal, 2000)}\n…\n${tail(w.goal, 2000)}`
  if (sizeOf(next) > CHECKPOINT_MAX_BYTES)
    for (const entry of w.history.slice(0, -1)) {
      delete entry.command_excerpt
      delete entry.output_excerpt
    }
  return { codecVersion: 1, state: next as unknown as JsonValue }
}

export const codec: LoopCheckpointCodec = {
  version: 1,
  encode: (state) => encodeState(parseJevState(state)),
  decode(checkpoint) {
    if (checkpoint.codecVersion !== 1)
      throw new Error(
        `Jev loop checkpoint codec version ${checkpoint.codecVersion} is unsupported; expected 1`,
      )
    return parseJevState(checkpoint.state) as unknown as JsonValue
  },
}
