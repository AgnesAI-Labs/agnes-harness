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

/**
 * Tools that run a command. A trap hit is a failed run of one of them; reading a file with the read
 * tool (or printing it with `cat` in a shell) never counts, even when the file holds the signature.
 */
const EXECUTING_TOOLS: ReadonlySet<string> = new Set(['shell', 'bash', 'exec', 'python_repl'])

/** A command that only prints files or text: its output is never a failed run of the task's tool. */
const READER_COMMAND =
  /(?:^|[;&|(\n])\s*(?:cat|head|tail|sed|grep|egrep|rg|awk|less|more|bat|nl|od|xxd|strings)\s/
const isReaderCommand = (command: string): boolean => READER_COMMAND.test(command)

/** A non-zero exit the command printed itself (`echo "exit=$?"`) or a Prime `BashResult(exit_code=N`. */
const PRINTED_FAILURE = /\bexit(?:[ _]?code)?\s*[=:]\s*(-?[1-9]\d*)\b/i

const matchesSignature = (signatures: RegExp[], texts: string[]): boolean =>
  texts.some((text) => signatures.some((signature) => signature.test(text)))

/** The pieces of an AGH shell result: `stdout`, then `[stderr]` and the error text, then `[exit N]`. */
const splitShellResult = (text: string): { stdout: string; stderr: string; exit: number | undefined } => {
  let body = text
  let exit: number | undefined
  const exitMatch = /\n*\[exit (-?\d+)\]\s*$/.exec(body)
  if (exitMatch) {
    exit = Number(exitMatch[1])
    body = body.slice(0, exitMatch.index)
  }
  const marker = /(?:^|\n)\[stderr\]\n?/.exec(body)
  if (!marker) return { stdout: body, stderr: '', exit }
  return { stdout: body.slice(0, marker.index), stderr: body.slice(marker.index + marker[0].length), exit }
}

/**
 * Whether a run of an AGH shell tool failed with the signature: the signature is on stderr, or the run
 * failed (error result, non-zero exit, a printed non-zero exit) and printed it on stdout with a command
 * that is not a plain file reader.
 */
const aghShellFailed = (signatures: RegExp[], text: string, isError: boolean, command: string): boolean => {
  const { stdout, stderr, exit } = splitShellResult(text)
  if (matchesSignature(signatures, [stderr])) return true
  const failed = isError || (exit !== undefined && exit !== 0) || PRINTED_FAILURE.test(stdout)
  return failed && !isReaderCommand(command) && matchesSignature(signatures, [stdout])
}

/**
 * The same for a Prime tool result (`python_repl`, which runs commands through `bash(...)` or
 * `subprocess`): the signature is in the exception, in stderr, or in the output of a run that failed.
 */
const primeRunFailed = (signatures: RegExp[], message: Json, command: string): boolean => {
  if (typeof message.toolName !== 'string' || !EXECUTING_TOOLS.has(message.toolName)) return false
  const details = isObject(message.details) ? message.details : {}
  const error = isObject(details.error) ? details.error : undefined
  const exceptionTexts: string[] = []
  if (typeof details.stderr === 'string') exceptionTexts.push(details.stderr)
  if (error) {
    if (typeof error.evalue === 'string') exceptionTexts.push(error.evalue)
    if (Array.isArray(error.traceback))
      exceptionTexts.push(error.traceback.filter((line) => typeof line === 'string').join('\n'))
  }
  if (matchesSignature(signatures, exceptionTexts)) return true
  const text = contentText(message.content)
  const failed =
    (!error && (message.isError === true || details.status === 'error')) || PRINTED_FAILURE.test(text)
  return failed && !isReaderCommand(command) && matchesSignature(signatures, [text])
}

type Source = 'auto' | 'user' | 'self'
const asSource = (value: unknown): Source => (value === 'auto' || value === 'self' ? value : 'user')

/**
 * The same counts from a Prime session file. The trap is hit only by a failed run: an executing tool
 * result (`python_repl`) whose exception, stderr or failed output holds the signature, or a failed `!`
 * command; printing a file that holds the signature is not a hit.
 */
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

  const commands = new Map<string, string>()
  const markHit = (): void => {
    const window = windows[current]
    if (window) window.trapHit = true
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
        const details = isObject(message.details) ? message.details : {}
        const kernel = isObject(details.bashCommands) ? details.bashCommands : {}
        const command =
          typeof kernel.first === 'string' ? kernel.first : (commands.get(String(message.toolCallId)) ?? '')
        if (primeRunFailed(signatures, message, command)) markHit()
      } else if (message.role === 'bashExecution') {
        // A command the user ran with `!`: a failure is a non-zero exit with the signature in its output.
        const failed = typeof message.exitCode === 'number' && message.exitCode !== 0
        const command = typeof message.command === 'string' ? message.command : ''
        if (failed && !isReaderCommand(command) && typeof message.output === 'string')
          if (matchesSignature(signatures, [message.output])) markHit()
      } else if (message.role === 'custom') {
        readNotice(message.customType, message.details)
      }
    } else if (entry.type === 'tool_started') {
      const args = isObject(entry.args) ? entry.args : {}
      if (typeof args.code === 'string') harnessLookups += args.code.match(LOOKUP)?.length ?? 0
      const run =
        typeof args.code === 'string' ? args.code : typeof args.command === 'string' ? args.command : ''
      if (typeof entry.toolCallId === 'string') commands.set(entry.toolCallId, run)
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
 * prompt's text (notes the host adds are not the user's). The trap counts as hit in a window when a command
 * the shell tool ran failed with the signature (see `aghShellFailed`); reading a file that holds the
 * signature never counts. A review
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
  const calls = new Map<string, { name: string; command: string }>()
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
      const call = typeof data.toolUseId === 'string' ? calls.get(data.toolUseId) : undefined
      const name = call?.name ?? (typeof row.origin === 'string' ? row.origin.replace(/^tool:/, '') : '')
      if (
        window &&
        !window.trapHit &&
        EXECUTING_TOOLS.has(name) &&
        aghShellFailed(signatures, contentText(data.content), data.isError === true, call?.command ?? '')
      )
        window.trapHit = true
    } else if (row.type === 'tool/call') {
      if (data.name === 'harness_inspect') harnessLookups++
      if (typeof data.toolUseId === 'string' && typeof data.name === 'string') {
        const args = isObject(data.args) ? data.args : {}
        calls.set(data.toolUseId, {
          name: data.name,
          command: typeof args.command === 'string' ? args.command : '',
        })
      }
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
    ...(outcome.alignment ? { alignment: outcome.alignment } : {}),
  }
}

export type Metrics = {
  recurrence: number | null
  /**
   * Cross-session tasks only: the first session hit the trap (there was something to learn) and the
   * second session ran and never hit it. Undefined when the first session never hit the trap.
   */
  crossSessionAvoided: boolean | null
  /**
   * Cross-workspace tasks only: the first session hit the trap (there was something to learn) and the
   * second session, in another workspace, ran and never hit it. Undefined when the first session never
   * hit the trap.
   */
  crossWorkspaceAvoided: boolean | null
  completion: number
}

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

  const secondClean = (): boolean => {
    const ran = (sessions.get(1) ?? []).filter((w) => w.ran)
    return ran.length > 0 && ran.every((w) => !w.trapHit)
  }
  const learned = (sessions.get(0) ?? []).some((w) => w.ran && w.trapHit)
  const crossSessionAvoided = record.category === 'cross-session' && learned ? secondClean() : null
  const crossWorkspaceAvoided = record.category === 'cross-workspace' && learned ? secondClean() : null

  const passed = record.windows.filter((w) => w.ran && w.checksPassed === true).length
  const completion = record.windows.length === 0 ? 0 : passed / record.windows.length
  return { recurrence, crossSessionAvoided, crossWorkspaceAvoided, completion }
}
