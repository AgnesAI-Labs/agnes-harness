import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type LedgerEvent, normalizeToolError, openLedgerReadOnly, readBenchEvents } from './ledger-source.js'

// Offline trigger-frequency statistics over session ledgers. Aggregate numbers only: no message
// text, tool output, paths or session keys leave this module.

export type Quantiles = { n: number; p50: number | null; p90: number | null; max: number | null }

export type TriggerStats = {
  sessions: number
  turns: number
  repeatedFailure: { turns: number; turnRate: number; goals: number; goalRate: number | null }
  compaction: {
    ok: number
    failed: number
    per100Turns: number
    remainingTurnsAfter: Quantiles
    remainingStepsInTurnAfter: Quantiles
  }
  autoTriggers: { raw: number; afterAghLimits: number; afterPrimeCooldown: number }
}

const DEFAULT_REPEAT_THRESHOLD = 3
const AGH_MIN_COMPLETED_TURNS = 5
const AGH_PER_HOUR = 4
const AGH_COOLDOWN_MS = 120_000
const AGH_PER_SESSION = 10
const PRIME_COOLDOWN_MS = 1_200_000
const HOUR_MS = 3_600_000

type Candidate = { ms: number; turnsDone: number }
type Compaction = { seq: number; steps: number }
type SessionCounts = {
  turns: number
  repeatedTurns: number
  goals: number
  repeatedGoals: number
  compactionsFailed: number
  compactions: { remainingTurns: number; remainingSteps: number }[]
  candidates: Candidate[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function userText(data: unknown): string {
  if (!isObject(data) || !Array.isArray(data.content)) return ''
  return data.content
    .map((block) =>
      isObject(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .join('\n')
}

/** `create` and a bare `/goal <objective>` start a goal; `complete` and `clear` end it. */
function goalCommand(text: string): 'start' | 'end' | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const op = (match[1] ?? '').trim().split(/\s/, 1)[0] ?? ''
  if (op === 'complete' || op === 'clear') return 'end'
  if (['', 'show', 'edit', 'pause', 'resume'].includes(op)) return null
  return 'start'
}

function startData(events: LedgerEvent[]): Record<string, unknown> | null {
  const start = events.find((e) => e.type === 'session/start')
  return start && isObject(start.data) ? start.data : null
}

function toolName(result: LedgerEvent, calls: Map<number, string>): string {
  const source = result.sourceEventSeqs?.[0]
  const named = source === undefined ? undefined : calls.get(source)
  if (named) return named
  return result.origin?.replace(/^tool:/, '') || 'unknown'
}

function analyseSession(events: LedgerEvent[], threshold: number): SessionCounts {
  const calls = new Map<number, string>()
  for (const e of events) {
    if (e.type === 'tool/call' && isObject(e.data) && typeof e.data.name === 'string')
      calls.set(e.seq, e.data.name)
  }
  const turnStarts = events.filter((e) => e.type === 'turn/start').map((e) => e.seq)
  const counts: SessionCounts = {
    turns: turnStarts.length,
    repeatedTurns: 0,
    goals: 0,
    repeatedGoals: 0,
    compactionsFailed: 0,
    compactions: [],
    candidates: [],
  }

  let turnOpen = false
  let completed = 0
  let turnGroups = new Map<string, number>()
  let turnHit = false
  let goalGroups: Map<string, number> | null = null
  let goalHit = false
  let turnCompactions: Compaction[] = []
  const allCompactions: Compaction[] = []

  const closeTurn = (done: boolean): void => {
    if (!turnOpen) return
    if (turnHit) counts.repeatedTurns++
    if (done) completed++
    turnOpen = false
    turnCompactions = []
  }
  const closeGoal = (): void => {
    if (!goalGroups) return
    counts.goals++
    if (goalHit) counts.repeatedGoals++
    goalGroups = null
  }
  const bump = (groups: Map<string, number>, key: string): number => {
    const n = (groups.get(key) ?? 0) + 1
    groups.set(key, n)
    return n
  }

  for (const e of events) {
    const ms = Date.parse(e.ts) || 0
    switch (e.type) {
      case 'turn/start':
        closeTurn(false)
        turnOpen = true
        turnGroups = new Map()
        turnHit = false
        break
      case 'turn/end':
        closeTurn(true)
        break
      case 'step/start':
        if (turnOpen) for (const c of turnCompactions) c.steps++
        break
      case 'x/core/compaction-end': {
        const compaction = { seq: e.seq, steps: 0 }
        allCompactions.push(compaction)
        if (turnOpen) turnCompactions.push(compaction)
        counts.candidates.push({ ms, turnsDone: completed })
        break
      }
      case 'x/core/compaction-failed':
        counts.compactionsFailed++
        break
      case 'user/message': {
        const command = goalCommand(userText(e.data))
        if (command === 'start' && !goalGroups) {
          goalGroups = new Map()
          goalHit = false
        } else if (command === 'end') closeGoal()
        break
      }
      case 'tool/result': {
        if (!isObject(e.data) || e.data.isError !== true) break
        const key = `${toolName(e, calls)}\u0000${normalizeToolError({
          ...(typeof e.data.code === 'string' ? { code: e.data.code } : {}),
          content: Array.isArray(e.data.content) ? e.data.content : [],
        })}`
        if (turnOpen && bump(turnGroups, key) === threshold && !turnHit) {
          turnHit = true
          counts.candidates.push({ ms, turnsDone: completed })
        }
        if (goalGroups && bump(goalGroups, key) === threshold) goalHit = true
        break
      }
    }
  }
  closeTurn(false)
  closeGoal()

  counts.compactions = allCompactions.map((c) => ({
    remainingTurns: turnStarts.filter((seq) => seq > c.seq).length,
    remainingSteps: c.steps,
  }))
  return counts
}

function quantiles(values: number[]): Quantiles {
  if (values.length === 0) return { n: 0, p50: null, p90: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] as number }
}

/** How many of the candidates a policy would let through, evaluated per session in order. */
function admitAgh(candidates: Candidate[]): number {
  const allowed: Candidate[] = []
  for (const c of candidates) {
    if (allowed.length >= AGH_PER_SESSION) break
    const last = allowed[allowed.length - 1]
    if (last && c.turnsDone - last.turnsDone < AGH_MIN_COMPLETED_TURNS) continue
    if (last && c.ms - last.ms < AGH_COOLDOWN_MS) continue
    if (allowed.filter((a) => a.ms > c.ms - HOUR_MS).length >= AGH_PER_HOUR) continue
    allowed.push(c)
  }
  return allowed.length
}

function admitPrime(candidates: Candidate[]): number {
  let allowed = 0
  let lastMs = Number.NEGATIVE_INFINITY
  for (const c of candidates) {
    if (c.ms - lastMs < PRIME_COOLDOWN_MS) continue
    allowed++
    lastMs = c.ms
  }
  return allowed
}

export function computeTriggerStats(
  sessions: Map<string, LedgerEvent[]>,
  opts: { repeatThreshold?: number } = {},
): TriggerStats {
  const threshold = opts.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD
  let sessionCount = 0
  let turns = 0
  let repeatedTurns = 0
  let goals = 0
  let repeatedGoals = 0
  let failed = 0
  let raw = 0
  let agh = 0
  let prime = 0
  const remainingTurns: number[] = []
  const remainingSteps: number[] = []
  for (const events of sessions.values()) {
    const start = startData(events)
    if (start && (start.imported !== undefined || start.parent !== undefined)) continue
    const c = analyseSession(events, threshold)
    sessionCount++
    turns += c.turns
    repeatedTurns += c.repeatedTurns
    goals += c.goals
    repeatedGoals += c.repeatedGoals
    failed += c.compactionsFailed
    for (const k of c.compactions) {
      remainingTurns.push(k.remainingTurns)
      remainingSteps.push(k.remainingSteps)
    }
    raw += c.candidates.length
    agh += admitAgh(c.candidates)
    prime += admitPrime(c.candidates)
  }
  return {
    sessions: sessionCount,
    turns,
    repeatedFailure: {
      turns: repeatedTurns,
      turnRate: turns === 0 ? 0 : repeatedTurns / turns,
      goals: repeatedGoals,
      goalRate: goals === 0 ? null : repeatedGoals / goals,
    },
    compaction: {
      ok: remainingTurns.length,
      failed,
      per100Turns: turns === 0 ? 0 : (remainingTurns.length / turns) * 100,
      remainingTurnsAfter: quantiles(remainingTurns),
      remainingStepsInTurnAfter: quantiles(remainingSteps),
    },
    autoTriggers: { raw, afterAghLimits: agh, afterPrimeCooldown: prime },
  }
}

/** Main-lane events of every session that is neither a fork child nor an import. */
export function collectDbSessions(file: string): Map<string, LedgerEvent[]> {
  const ledger = openLedgerReadOnly(file)
  try {
    const bySession = new Map<string, LedgerEvent[]>()
    for (const s of ledger.sessions()) {
      if (s.parentKey !== null || s.imported) continue
      bySession.set(s.key, ledger.events(s.key))
    }
    return bySession
  } finally {
    ledger.close()
  }
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`
const num = (v: number | null): string => (v === null ? 'n/a' : String(Math.round(v * 100) / 100))

export function renderMarkdown(s: TriggerStats): string {
  const q = (x: Quantiles): string => `${x.n} | ${num(x.p50)} | ${num(x.p90)} | ${num(x.max)}`
  return [
    '# Trigger frequency',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Sessions | ${s.sessions} |`,
    `| Turns | ${s.turns} |`,
    `| Turns with a repeated failure | ${s.repeatedFailure.turns} (${pct(s.repeatedFailure.turnRate)}) |`,
    `| Goals with a repeated failure | ${s.repeatedFailure.goals} (${s.repeatedFailure.goalRate === null ? 'n/a' : pct(s.repeatedFailure.goalRate)}) |`,
    `| Compactions ok | ${s.compaction.ok} |`,
    `| Compactions failed | ${s.compaction.failed} |`,
    `| Compactions per 100 turns | ${num(s.compaction.per100Turns)} |`,
    '',
    '| After a successful compaction | n | p50 | p90 | max |',
    '| --- | --- | --- | --- | --- |',
    `| Remaining turns | ${q(s.compaction.remainingTurnsAfter)} |`,
    `| Remaining steps in the same turn | ${q(s.compaction.remainingStepsInTurnAfter)} |`,
    '',
    '| Automatic triggers | Count |',
    '| --- | --- |',
    `| Raw candidates | ${s.autoTriggers.raw} |`,
    `| After the AGH limits | ${s.autoTriggers.afterAghLimits} |`,
    `| After the Prime cooldown | ${s.autoTriggers.afterPrimeCooldown} |`,
    '',
  ].join('\n')
}

function main(argv: string[]): void {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i < 0 ? undefined : argv[i + 1]
  }
  const db = flag('--db')
  const bench = flag('--bench-events')
  const out = flag('--out')
  if (!out || (db === undefined) === (bench === undefined)) {
    console.error('usage: trigger-stats.ts (--db <sessions.db copy> | --bench-events <dir>) --out <dir>')
    process.exit(2)
  }
  const sessions =
    db !== undefined ? collectDbSessions(resolve(db)) : readBenchEvents(resolve(bench as string))
  const result = computeTriggerStats(sessions)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'trigger-stats.json'), `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(join(out, 'trigger-stats.md'), renderMarkdown(result))
  console.log(`wrote trigger-stats.json and trigger-stats.md to ${out}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2))
