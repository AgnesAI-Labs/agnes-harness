// Off unless a profile driver turns it on. The commit-time bench leaves it off.
// Phase walls are exclusive: a nested phase pauses its parent.

export type ProfileCounters = { ms: number; calls: number; bytes: number }

type PhaseBucket = {
  wallMs: number
  canonical: ProfileCounters
  sha: ProfileCounters
  readSql: ProfileCounters
  writeSql: ProfileCounters
  jsonParse: ProfileCounters
  jsonStringify: ProfileCounters
}

export type PhaseSnapshot = PhaseBucket & { otherMs: number }

export type StatementSnapshot = {
  phase: string
  kind: 'read' | 'write'
  calls: number
  ms: number
  sql: string
}

export type ProfileSnapshot = {
  phases: Record<string, PhaseSnapshot>
  begin: { ms: number; calls: number }
  commit: { ms: number; calls: number }
  statements: StatementSnapshot[]
}

export let profiling = false

const phases = new Map<string, PhaseBucket>()
const statements = new Map<string, StatementSnapshot>()
const stack: Array<{ name: string; started: number }> = []
let beginMs = 0
let beginCalls = 0
let commitMs = 0
let commitCalls = 0

function empty(): ProfileCounters {
  return { ms: 0, calls: 0, bytes: 0 }
}

function bucket(name: string): PhaseBucket {
  const found = phases.get(name)
  if (found) return found
  const created: PhaseBucket = {
    wallMs: 0,
    canonical: empty(),
    sha: empty(),
    readSql: empty(),
    writeSql: empty(),
    jsonParse: empty(),
    jsonStringify: empty(),
  }
  phases.set(name, created)
  return created
}

function currentPhase(): string {
  return stack.at(-1)?.name ?? 'outside'
}

function add(counter: ProfileCounters, ms: number, bytes = 0): void {
  counter.ms += ms
  counter.calls += 1
  counter.bytes += bytes
}

export function setProfiling(enabled: boolean): void {
  profiling = enabled
}

export function resetProfile(): void {
  phases.clear()
  statements.clear()
  stack.length = 0
  beginMs = 0
  beginCalls = 0
  commitMs = 0
  commitCalls = 0
}

export function enterPhase(name: string): void {
  const now = performance.now()
  const parent = stack.at(-1)
  if (parent) bucket(parent.name).wallMs += now - parent.started
  stack.push({ name, started: now })
}

export function leavePhase(): void {
  const now = performance.now()
  const top = stack.pop()
  if (!top) throw new Error('profile phase stack is empty')
  bucket(top.name).wallMs += now - top.started
  const parent = stack.at(-1)
  if (parent) parent.started = now
}

export function noteCanonical(ms: number, bytes: number): void {
  add(bucket(currentPhase()).canonical, ms, bytes)
}

export function noteSha(ms: number, bytes: number): void {
  add(bucket(currentPhase()).sha, ms, bytes)
}

export function noteSql(kind: 'read' | 'write', ms: number, sql: string): void {
  const phase = currentPhase()
  add(kind === 'read' ? bucket(phase).readSql : bucket(phase).writeSql, ms)
  const key = `${phase}\0${kind}\0${sql}`
  const row = statements.get(key)
  if (row) {
    row.calls += 1
    row.ms += ms
    return
  }
  statements.set(key, { phase, kind, calls: 1, ms, sql })
}

export function noteJsonParse(ms: number, bytes: number): void {
  add(bucket(currentPhase()).jsonParse, ms, bytes)
}

export function noteJsonStringify(ms: number, bytes: number): void {
  add(bucket(currentPhase()).jsonStringify, ms, bytes)
}

export function noteBoundary(kind: 'begin' | 'commit', ms: number): void {
  if (kind === 'begin') {
    beginMs += ms
    beginCalls += 1
    return
  }
  commitMs += ms
  commitCalls += 1
}

export function snapshotProfile(): ProfileSnapshot {
  const reported: Record<string, PhaseSnapshot> = {}
  for (const [name, phase] of phases) {
    const accounted =
      phase.canonical.ms +
      phase.sha.ms +
      phase.readSql.ms +
      phase.writeSql.ms +
      phase.jsonParse.ms +
      phase.jsonStringify.ms
    reported[name] = { ...phase, otherMs: phase.wallMs - accounted }
  }
  return {
    phases: reported,
    begin: { ms: beginMs, calls: beginCalls },
    commit: { ms: commitMs, calls: commitCalls },
    statements: [...statements.values()].sort((left, right) => right.ms - left.ms),
  }
}
