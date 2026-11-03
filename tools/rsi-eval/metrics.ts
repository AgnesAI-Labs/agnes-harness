// Per-run metrics from Prime session records and the usage proxy summary. Session and prompt indices
// are zero-based throughout: session 0 is the first session, so "session 2" in the design is index 1.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EvalTask, PromptWindow, RunOutcome, RunRecord, Setting } from './types.js'

export type { PromptWindow, RunRecord } from './types.js'

export type ParsedSession = {
  windows: Omit<PromptWindow, 'checksPassed'>[]
  refine: RunRecord['refine']
  harnessLookups: number
  compactions: number
}

export type UsageSummary = {
  requests: number
  unknown: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  costUsd: number
}

const REFINEMENT_AUDIT = 'prime-agent.refinement'
const REFINEMENT_NOTICE = 'refinement_notice'
const LOOKUP = /\b(?:rlm\.)?harness\.(?:search|list|get)\s*\(/g

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Text of a message `content`: a plain string, or the `text` of blocks tagged `type: "text"`. */
const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is Json => isObject(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text as string)
    .join('\n')
}

/** Every text a tool run printed, whatever `isError` says: result text, stderr and the error value. */
const toolOutputTexts = (message: Json): string[] => {
  const texts = [contentText(message.content)]
  const details = isObject(message.details) ? message.details : {}
  if (typeof details.stderr === 'string') texts.push(details.stderr)
  const error = isObject(details.error) ? details.error : {}
  if (typeof error.evalue === 'string') texts.push(error.evalue)
  return texts
}

type Source = 'auto' | 'user' | 'self'
const asSource = (value: unknown): Source => (value === 'auto' || value === 'self' ? value : 'user')

export const parsePrimeSession = (jsonl: string, task: EvalTask, sessionIndex: number): ParsedSession => {
  const prompts = task.sessions[sessionIndex]?.prompts ?? []
  const signatures = task.trap.signatures.map((signature) => new RegExp(signature))
  const windows = prompts.map((_, prompt) => ({ session: sessionIndex, prompt, ran: false, trapHit: false }))
  let current = -1
  let lastOpened = -1
  let harnessLookups = 0
  let compactions = 0
  const audits: { id: string; edits: number }[] = []
  const noticeSource = new Map<string, Source>()

  const readOutput = (texts: string[]): void => {
    const window = windows[current]
    if (!window || window.trapHit) return
    if (texts.some((text) => signatures.some((signature) => signature.test(text)))) window.trapHit = true
  }

  const readNotice = (customType: unknown, details: unknown): void => {
    if (customType !== REFINEMENT_NOTICE || !isObject(details)) return
    if (typeof details.refinementId === 'string')
      noticeSource.set(details.refinementId, asSource(details.source))
  }

  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(entry)) continue
    if (entry.type === 'message' && isObject(entry.message)) {
      const message = entry.message
      if (message.role === 'user') {
        const text = contentText(message.content).trim()
        if (text.startsWith('/refine')) continue
        const next = prompts.findIndex((p, k) => k > lastOpened && p.text.trim() === text)
        const window = windows[next]
        if (window) {
          window.ran = true
          current = next
          lastOpened = next
        }
      } else if (message.role === 'toolResult') {
        readOutput(toolOutputTexts(message))
      } else if (message.role === 'bashExecution') {
        if (typeof message.output === 'string') readOutput([message.output])
      } else if (message.role === 'custom') {
        readNotice(message.customType, message.details)
      }
    } else if (entry.type === 'tool_started') {
      const args = isObject(entry.args) ? entry.args : {}
      if (typeof args.code === 'string') harnessLookups += args.code.match(LOOKUP)?.length ?? 0
    } else if (entry.type === 'compaction') {
      compactions++
    } else if (entry.type === 'custom' && entry.customType === REFINEMENT_AUDIT) {
      const data = isObject(entry.data) ? entry.data : {}
      audits.push({
        id: typeof data.id === 'string' ? data.id : '',
        edits: Array.isArray(data.appliedEdits) ? data.appliedEdits.length : 0,
      })
    } else if (entry.type === 'custom_message') {
      readNotice(entry.customType, entry.details)
    }
  }

  const refine = { auto: 0, user: 0, self: 0, appliedEdits: 0 }
  for (const audit of audits) {
    // A refinement that applied nothing writes no notice; those count as user-triggered.
    refine[noticeSource.get(audit.id) ?? 'user']++
    refine.appliedEdits += audit.edits
  }
  return { windows, refine, harnessLookups, compactions }
}

const REFINEMENT_RUN = 'x/core/refinement-run'
const TRIGGER_SOURCE: Record<string, Source> = {
  manual: 'user',
  model: 'self',
  compaction: 'auto',
  'repeated-failure': 'auto',
}
const isMainLane = (lane: unknown): boolean =>
  lane === null || lane === undefined || lane === '' || lane === 'main'

/**
 * The same counts from an AGH session file: one ledger row per line (`{seq, type, lane, origin, data}`,
 * every lane), as the AGH runner writes it. A prompt window opens at the user's own message with the
 * prompt's text (notes the host adds are not the user's); tool results are read for the trap. A review
 * counts once it reached planning (or opened with a plan, for a direct proposal), by what started it:
 * manual is `user`, the model's request is `self`, compaction and repeated failures are `auto`.
 * Applied edits are those of applied `harness/refine` rows that are not withdrawals.
 */
export const parseAghSession = (jsonl: string, task: EvalTask, sessionIndex: number): ParsedSession => {
  const prompts = task.sessions[sessionIndex]?.prompts ?? []
  const signatures = task.trap.signatures.map((signature) => new RegExp(signature))
  const windows = prompts.map((_, prompt) => ({ session: sessionIndex, prompt, ran: false, trapHit: false }))
  let current = -1
  let lastOpened = -1
  let harnessLookups = 0
  let compactions = 0
  const runs = new Map<string, { source?: Source; planned: boolean }>()
  const refine = { auto: 0, user: 0, self: 0, appliedEdits: 0 }

  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(row) || typeof row.type !== 'string') continue
    const data = isObject(row.data) ? row.data : {}
    if (row.type === REFINEMENT_RUN) {
      if (row.origin !== undefined && row.origin !== null && row.origin !== 'system') continue
      if (typeof data.runId !== 'string') continue
      const run = runs.get(data.runId) ?? { planned: false }
      const trigger = isObject(data.trigger) ? data.trigger : undefined
      if (trigger && typeof trigger.kind === 'string') run.source = TRIGGER_SOURCE[trigger.kind] ?? 'user'
      if (data.state === 'planning' || data.state === 'proposed') run.planned = true
      runs.set(data.runId, run)
      continue
    }
    if (row.type === 'harness/refine') {
      if (data.outcome === 'applied' && data.rollbackOf === undefined && Array.isArray(data.edits))
        refine.appliedEdits += data.edits.length
      continue
    }
    if (!isMainLane(row.lane)) continue
    if (row.type === 'user/message') {
      if (data.kind === 'runtime_context' || row.origin === 'system') continue
      const text = contentText(data.content).trim()
      const next = prompts.findIndex((p, k) => k > lastOpened && p.text.trim() === text)
      const window = windows[next]
      if (window) {
        window.ran = true
        current = next
        lastOpened = next
      }
    } else if (row.type === 'tool/result') {
      const window = windows[current]
      const text = contentText(data.content)
      if (window && !window.trapHit && signatures.some((signature) => signature.test(text)))
        window.trapHit = true
    } else if (row.type === 'tool/call') {
      if (data.name === 'harness_inspect') harnessLookups++
    } else if (row.type === 'x/core/compaction-end') {
      compactions++
    }
  }
  for (const run of runs.values()) if (run.planned) refine[run.source ?? 'user']++
  return { windows, refine, harnessLookups, compactions }
}

const RUN_ID = /^.+\.(on|off)\.r(\d+)$/

export type ToRunRecordOptions = {
  system?: RunRecord['system']
  /** Defaults to reading from disk. */
  readFile?: (path: string) => string
  /** Session file paths are resolved against this directory when given. */
  baseDir?: string
}

export const toRunRecord = (
  task: EvalTask,
  outcome: RunOutcome,
  usage: Map<string, UsageSummary>,
  options: ToRunRecordOptions = {},
): RunRecord => {
  const match = RUN_ID.exec(outcome.runId)
  if (!match || !outcome.runId.startsWith(`${task.id}.`)) {
    throw new Error(`run id ${outcome.runId} does not belong to task ${task.id}`)
  }
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const locate = (path: string): string => (options.baseDir ? resolve(options.baseDir, path) : path)

  const windows: PromptWindow[] = []
  const refine = { auto: 0, user: 0, self: 0, appliedEdits: 0 }
  let harnessLookups = 0
  let compactions = 0
  task.sessions.forEach((_, sessionIndex) => {
    const files = outcome.sessions[sessionIndex]?.sessionFiles ?? []
    const parse = (options.system ?? 'prime') === 'agh' ? parseAghSession : parsePrimeSession
    const parsed = parse(files.map((file) => read(locate(file))).join('\n'), task, sessionIndex)
    for (const window of parsed.windows) {
      const check = outcome.checks.find((c) => c.session === window.session && c.prompt === window.prompt)
      windows.push({ ...window, checksPassed: window.ran && check ? check.passed : null })
    }
    refine.auto += parsed.refine.auto
    refine.user += parsed.refine.user
    refine.self += parsed.refine.self
    refine.appliedEdits += parsed.refine.appliedEdits
    harnessLookups += parsed.harnessLookups
    compactions += parsed.compactions
  })

  let exit: RunRecord['exit'] = 'ok'
  if (outcome.sessions.some((s) => s.timedOut)) exit = 'timeout'
  else if (outcome.sessions.length < task.sessions.length || outcome.sessions.some((s) => s.exitCode !== 0)) {
    exit = 'error'
  }

  const summary = usage.get(outcome.runId)
  const tokens = summary
    ? summary.tokens.input + summary.tokens.output + summary.tokens.cacheRead + summary.tokens.cacheWrite
    : 0
  return {
    system: options.system ?? 'prime',
    taskId: task.id,
    category: task.category,
    setting: match[1] as Setting,
    rep: Number(match[2]),
    exit,
    windows,
    refine,
    harnessLookups,
    compactions,
    usage: {
      requests: summary?.requests ?? 0,
      unknown: summary?.unknown ?? 0,
      tokens,
      costUsd: summary?.costUsd ?? 0,
    },
  }
}

export type Metrics = { recurrence: number | null; crossSessionAvoided: boolean | null; completion: number }

export const runMetrics = (record: RunRecord): Metrics => {
  const sessions = new Map<number, PromptWindow[]>()
  for (const window of record.windows) {
    const list = sessions.get(window.session) ?? []
    list.push(window)
    sessions.set(window.session, list)
  }
  const rates: number[] = []
  for (const list of sessions.values()) {
    const ordered = [...list].sort((a, b) => a.prompt - b.prompt)
    const first = ordered.findIndex((w) => w.ran && w.trapHit)
    if (first < 0) continue
    const later = ordered.slice(first + 1).filter((w) => w.ran)
    if (later.length === 0) continue
    rates.push(later.filter((w) => w.trapHit).length / later.length)
  }
  const recurrence = rates.length === 0 ? null : rates.reduce((sum, r) => sum + r, 0) / rates.length

  let crossSessionAvoided: boolean | null = null
  if (record.category === 'cross-session') {
    const ran = (sessions.get(1) ?? []).filter((w) => w.ran)
    crossSessionAvoided = ran.length > 0 && ran.every((w) => !w.trapHit)
  }

  const passed = record.windows.filter((w) => w.ran && w.checksPassed === true).length
  const completion = record.windows.length === 0 ? 0 : passed / record.windows.length
  return { recurrence, crossSessionAvoided, completion }
}
