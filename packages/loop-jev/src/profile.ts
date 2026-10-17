// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import type { LoopToolMeta, LoopTurnView, ToolResult } from '@agnes/extension-api'
import type {
  HistoryEntry,
  JsonObject,
  JsonValue,
  Note,
  Observation,
  Phase,
  ReferenceKind,
  ResolvedTool,
  StepError,
  ToolSchema,
  WriteClass,
} from './types.js'
import { canonicalJson, clip, fingerprint, tail } from './util.js'

export const BUILTIN_TOOLS = ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell'] as const
/** The most targets one read step may take; the same bound limits decoded, replayed and checkpointed batches. */
export const MAX_BATCH = 4
export const DISCOVERY_TOOLS = ['tool_search', 'tool_describe'] as const
type BuiltinTool = (typeof BUILTIN_TOOLS)[number]

/** What Jev is told about each built-in tool; the model-facing descriptions are left alone. */
export const JEV_CRITERIA: Readonly<Record<BuiltinTool, string>> = {
  ls: 'List one workspace directory, including file and directory references. Use path for scoped discovery; not recursive.',
  read: 'Read one workspace file; offset is a 1-based line number and limit counts lines. Paths may be authored directly even without prior observations.',
  grep: 'Search file contents under a workspace path with a regular expression and optional filename glob; returns matching lines with file references.',
  find: 'List workspace files whose paths match a glob pattern; returns file references.',
  write:
    'Create or replace a workspace file using separate path and content arguments; paths may include subdirectories and need not already exist.',
  edit: 'Change part of an existing workspace file by exact text replacement; the file must have been read in this session.',
  shell:
    'Run one shell command in the workspace; its output is captured into context. For effects that are not directly authorable file content: verify results with commands, compute, search-and-transform or reformat many files, run builds, formatters and code generators. Do not use it to write content you could author (write) or to pull one file into context (read).',
}

type Profile = {
  readonly phases: readonly Phase[]
  readonly writeClass: WriteClass
  readonly readOnly: boolean
  readonly targetParam: string | null
  readonly defaults: JsonObject | null
  readonly bindingDefaults: JsonObject | null
  readonly referenceKind: ReferenceKind | null
}
const READ_PHASES: readonly Phase[] = ['INSPECT', 'VERIFY']
const PROFILES: Readonly<Record<BuiltinTool, Profile>> = {
  ls: {
    phases: READ_PHASES,
    writeClass: 'read',
    readOnly: true,
    targetParam: 'path',
    defaults: { path: '.' },
    bindingDefaults: {},
    referenceKind: 'directory',
  },
  read: {
    phases: READ_PHASES,
    writeClass: 'read',
    readOnly: true,
    targetParam: 'path',
    defaults: null,
    bindingDefaults: { offset: 1, limit: 200 },
    referenceKind: 'file',
  },
  grep: {
    phases: READ_PHASES,
    writeClass: 'read',
    readOnly: true,
    targetParam: null,
    defaults: null,
    bindingDefaults: null,
    referenceKind: null,
  },
  find: {
    phases: READ_PHASES,
    writeClass: 'read',
    readOnly: true,
    targetParam: null,
    defaults: null,
    bindingDefaults: null,
    referenceKind: null,
  },
  write: {
    phases: ['ACT'],
    writeClass: 'workspace',
    readOnly: false,
    targetParam: 'path',
    defaults: null,
    bindingDefaults: null,
    referenceKind: null,
  },
  edit: {
    phases: ['ACT'],
    writeClass: 'workspace',
    readOnly: false,
    targetParam: 'path',
    defaults: null,
    bindingDefaults: null,
    referenceKind: null,
  },
  shell: {
    phases: ['INSPECT', 'ACT', 'VERIFY'],
    writeClass: 'workspace',
    readOnly: false,
    targetParam: null,
    defaults: null,
    bindingDefaults: null,
    referenceKind: null,
  },
}

const isBuiltin = (name: string): name is BuiltinTool => (BUILTIN_TOOLS as readonly string[]).includes(name)
const isDiscovery = (name: string): boolean => (DISCOVERY_TOOLS as readonly string[]).includes(name)
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Whether `args` is a complete argument object for `schema`: every required key is present, no key
 * outside `properties` when the schema forbids them, and string, integer and boolean values have
 * the declared type. Nothing else is checked.
 */
export function completeArgs(schema: unknown, args: JsonObject): boolean {
  if (!isObject(schema)) return false
  const properties = isObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  if (required.some((key) => typeof key === 'string' && !(key in args))) return false
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key]
    if (property === undefined) {
      if (schema.additionalProperties === false) return false
      continue
    }
    const type = isObject(property) ? property.type : undefined
    if (type === 'string' && typeof value !== 'string') return false
    if (type === 'integer' && !Number.isInteger(value)) return false
    if (type === 'boolean' && typeof value !== 'boolean') return false
  }
  return true
}

/**
 * How a tool writes, from whether it is read-only and its metadata: `shell` is always a workspace
 * write; otherwise a read-only tool reads, a mutable open-world tool writes outside the workspace
 * and any other mutable tool writes the workspace. `fallback` applies when there is no metadata.
 */
function writeClassOf(
  name: string,
  readOnly: boolean,
  meta: LoopToolMeta | undefined,
  fallback: WriteClass,
): WriteClass {
  if (name === 'shell') return 'workspace'
  if (readOnly) return 'read'
  if (meta === undefined) return fallback
  return meta.isOpenWorld ? 'external' : 'workspace'
}

/**
 * The profile of a built-in tool, or `null` for any other tool (only the built-in tools have a
 * profile). The tool's metadata, when given, decides whether it is read-only and how it writes.
 */
export function resolveTool(tool: ToolSchema, meta?: LoopToolMeta): ResolvedTool | null {
  if (!isBuiltin(tool.name)) return null
  const profile = PROFILES[tool.name]
  const defaults =
    profile.defaults !== null && completeArgs(tool.parameters, profile.defaults)
      ? { ...profile.defaults }
      : null
  const readOnly = meta?.isReadOnly ?? profile.readOnly
  return {
    name: tool.name,
    phases: profile.phases,
    writeClass: writeClassOf(tool.name, readOnly, meta, profile.writeClass),
    readOnly,
    profiled: true,
    criteria: JEV_CRITERIA[tool.name],
    targetParam: profile.targetParam,
    defaults,
    multiTargetMax: tool.name === 'read' ? MAX_BATCH : 1,
    bindingDefaults: profile.bindingDefaults === null ? null : { ...profile.bindingDefaults },
    referenceKind: profile.referenceKind,
  }
}

/**
 * A tool without a profile: a read-only tool is inspected, any other acts; its parameters always
 * come from the model and Jev sees its own description. Without metadata it is a mutable tool
 * that writes outside the workspace.
 */
export function resolveUnprofiled(tool: ToolSchema, meta: LoopToolMeta | undefined): ResolvedTool {
  const readOnly = meta?.isReadOnly ?? false
  return {
    name: tool.name,
    phases: readOnly ? ['INSPECT'] : ['ACT'],
    writeClass: writeClassOf(tool.name, readOnly, meta, 'external'),
    readOnly,
    profiled: false,
    criteria: tool.description.trim(),
    targetParam: null,
    defaults: null,
    multiTargetMax: 1,
    bindingDefaults: null,
    referenceKind: null,
  }
}

/** Built-in tools in the catalog plus the discovery tools it has, sorted. */
export function builtinToolNames(view: Pick<LoopTurnView, 'tools'>): string[] {
  const offered = new Set(view.tools.map((tool) => tool.name))
  const wanted: readonly string[] = [...BUILTIN_TOOLS, ...DISCOVERY_TOOLS]
  return wanted.filter((name) => offered.has(name)).sort()
}

/** Tools a turn of this loop never sends: `compact` only works in the default loop, `run_code` only in code modes. */
const NEVER_SENT: readonly string[] = ['compact', 'run_code']

/**
 * The tool names of a turn: the names a request without `tools` would send, without `compact` and
 * `run_code`, deduplicated and sorted; the built-in names when the view does not carry them.
 */
export function turnToolNames(view: Pick<LoopTurnView, 'tools' | 'disclosedTools'>): string[] {
  if (view.disclosedTools === undefined) return builtinToolNames(view)
  const names = new Set(view.disclosedTools.filter((name) => !NEVER_SENT.includes(name)))
  return [...names].sort()
}

/**
 * True when the turn's disclosure is `code` or `hybrid`: it offers `run_code`, or none of the
 * built-in tools the catalog has. Only the `standard` disclosure leaves `run_code` out and the
 * built-in tools in. A view without `disclosedTools` says nothing, so it is never refused.
 */
export function codeDisclosure(view: Pick<LoopTurnView, 'tools' | 'disclosedTools'>): boolean {
  const disclosed = view.disclosedTools
  if (disclosed === undefined) return false
  if (disclosed.includes('run_code')) return true
  const builtin: readonly string[] = BUILTIN_TOOLS
  return (
    !disclosed.some((name) => builtin.includes(name)) &&
    view.tools.some((tool) => builtin.includes(tool.name))
  )
}

const byName = (a: ResolvedTool, b: ResolvedTool): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/**
 * The tools Jev chooses among: `toolNames` without the discovery tools and without the tools the
 * view's model is not offered; the built-in tools first in built-in order, then the others by name.
 * Tools without a profile take part only when the view carries tool metadata.
 */
export function decisionTools(
  view: Pick<LoopTurnView, 'tools' | 'toolMeta'>,
  toolNames: readonly string[],
): ResolvedTool[] {
  const builtin: ResolvedTool[] = []
  const others: ResolvedTool[] = []
  for (const name of new Set(toolNames)) {
    if (isDiscovery(name)) continue
    const meta = view.toolMeta?.[name]
    if (meta?.offered === false) continue
    const schema = view.tools.find((tool) => tool.name === name)
    if (schema === undefined) continue
    if (isBuiltin(name)) {
      const resolved = resolveTool(schema, meta)
      if (resolved !== null) builtin.push(resolved)
    } else if (view.toolMeta !== undefined) {
      others.push(resolveUnprofiled(schema, meta))
    }
  }
  const order = (tool: ResolvedTool) => (BUILTIN_TOOLS as readonly string[]).indexOf(tool.name)
  builtin.sort((a, b) => order(a) - order(b))
  return [...builtin, ...others.sort(byName)]
}

/**
 * A workspace-relative POSIX path, or `null` for an empty value, a `..` segment, or an absolute
 * path outside `cwd`.
 */
export function normalizePath(path: unknown, cwd: string): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.includes(String.fromCharCode(0))) return null
  // `artifact://`, `session-file://` and the like name things outside the workspace.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return null
  const windows = /^[A-Za-z]:[\\/]/.test(cwd)
  const flat = (text: string) => (windows ? text.replace(/\\/g, '/') : text)
  const full = flat(path)
  const root = flat(cwd).replace(/\/+$/, '')
  let rest = full
  if (full.startsWith('/') || (windows && /^[A-Za-z]:\//.test(full))) {
    const head = full.slice(0, root.length)
    const inside = windows ? head.toLowerCase() === root.toLowerCase() : head === root
    if (!inside || (full.length > root.length && full[root.length] !== '/')) return null
    rest = full.slice(root.length)
  }
  const segments = rest.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) return null
  return segments.length === 0 ? '.' : segments.join('/')
}

/** The text blocks of a result, one per line. */
export function resultText(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

const argsObject = (args: JsonValue): JsonObject | null => (isObject(args) ? (args as JsonObject) : null)

/** The workspace path a call acts on, for the tools that have one. */
export function targetOf(name: string, args: JsonValue, cwd: string): string | null {
  if (!isBuiltin(name)) return null
  const param = PROFILES[name].targetParam
  const object = argsObject(args)
  return param === null || object === null ? null : normalizePath(object[param], cwd)
}

export type ClassifyInput = {
  phase: Phase | null
  name: string
  args: JsonValue
  result: ToolResult
  cwd: string
  confidence: number | null
  escalated: boolean
  /** Whether the tool is read-only; a failed call of a read-only tool without a profile changed nothing. */
  readOnly?: boolean
}
type Common = Pick<ClassifyInput, 'phase' | 'cwd' | 'confidence' | 'escalated'>
type Call = { name: string; args: JsonValue }

const stepError = (code: string, recoverability: StepError['recoverability'], text: string): StepError => ({
  code,
  kind: 'execution',
  stage: 'dispatch',
  recoverability,
  message: clip(text, 200),
})

function summaryOf(op: string, targets: readonly string[], input: Common): string {
  const confidence = input.confidence?.toFixed(2) ?? 'n/a'
  return `${op}(${targets.join(', ')}) conf=${confidence}${input.escalated ? ' [escalated]' : ''}`
}

/** The fingerprint of what a step asks for: its calls, in any order. */
export function intentFingerprint(calls: ReadonlyArray<{ name: string; args: JsonValue }>): string {
  const keyed = calls.map((call) => {
    const pair: JsonValue = [call.name, call.args]
    return { key: canonicalJson(pair), pair }
  })
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return fingerprint(keyed.map((item) => item.pair))
}

function exitOf(text: string): number | undefined {
  const all = [...text.matchAll(/\[exit (-?\d+)\]/g)]
  const last = all[all.length - 1]
  return last?.[1] === undefined ? undefined : Number(last[1])
}

function commandOf(args: JsonValue): string | null {
  const command = argsObject(args)?.command
  return typeof command === 'string' ? command : null
}

type Outcome = Pick<HistoryEntry, 'status' | 'disposition' | 'error'>
const SUCCEEDED: Outcome = { status: 'succeeded', disposition: 'SUCCEEDED' }
const NOT_APPLIED = (error: StepError): Outcome => ({ status: 'failed', disposition: 'NOT_APPLIED', error })

function failureOutcome(name: string, text: string, readOnly: boolean): Outcome {
  if (name === 'shell') {
    return text.startsWith('command could not be started')
      ? NOT_APPLIED(stepError('EXECUTION_FAILED', 'recoverable', text))
      : { status: 'failed', disposition: 'UNKNOWN', error: stepError('EFFECT_UNKNOWN', 'unsafe', text) }
  }
  if (isBuiltin(name) || isDiscovery(name) || readOnly)
    return NOT_APPLIED(stepError('EXECUTION_FAILED', 'recoverable', text))
  return { status: 'failed', disposition: 'UNKNOWN', error: stepError('EFFECT_UNKNOWN', 'unsafe', text) }
}

const notStarted = (name: string, text: string): boolean => text === `${name} was announced but did not run`

function entryOf(
  input: Common,
  fields: {
    op: string
    target: string | string[] | null
    outcome: Outcome
    text: string
    isError: boolean
    calls: readonly Call[]
  },
): HistoryEntry {
  const { op, target, outcome, text, isError, calls } = fields
  const exit = op === 'shell' ? exitOf(text) : undefined
  const labels = target === null ? [] : Array.isArray(target) ? target : [target]
  const command = op === 'shell' && calls.length === 1 ? commandOf(calls[0]?.args ?? null) : null
  return {
    phase: input.phase,
    operation: op,
    target,
    ...outcome,
    ...(exit === undefined ? {} : { exit }),
    summary: summaryOf(op, labels, input),
    ...(command === null ? {} : { command_excerpt: clip(command, 250) }),
    output_excerpt: tail(text, 500),
    intentFp: intentFingerprint(calls),
    observationFp: fingerprint({ text, isError }),
    dispatched: true,
  }
}

/** Turn one tool result into the single history entry and the notes it leaves behind. */
export function classifyResult(input: ClassifyInput): Observation {
  const { name, args, result } = input
  const text = resultText(result)
  const isError = !!result.isError
  const target = targetOf(name, args, input.cwd)
  const calls = [{ name, args }]
  const build = (outcome: Outcome) => entryOf(input, { op: name, target, outcome, text, isError, calls })
  const notes: Note[] = []

  if (isError && notStarted(name, text)) {
    return { entry: build(NOT_APPLIED(stepError('TOOL_NOT_STARTED', 'recoverable', text))), notes }
  }
  const entry = build(isError ? failureOutcome(name, text, input.readOnly === true) : SUCCEEDED)
  if (!isError) {
    if (name === 'read' && target !== null) {
      entry.read_files = [target]
      notes.push({ kind: 'file', target, text: clip(`[file: ${target}]\n${text}`, 600) })
    }
    if ((name === 'write' || name === 'edit') && target !== null) entry.changed_files = [target]
    if (name === 'shell') entry.files_may_have_changed = true
  }
  const command = commandOf(args)
  if (name === 'shell') {
    notes.push({
      kind: 'shell',
      ...(command === null ? {} : { target: clip(command, 250) }),
      text: clip(text, 600),
    })
  }
  return { entry, notes }
}

/** One history entry for several `read` calls dispatched together. */
export function classifyReadBatch(
  input: Omit<ClassifyInput, 'name' | 'args' | 'result'> & { calls: Call[]; results: ToolResult[] },
): Observation {
  const { calls, results } = input
  const texts = results.map(resultText)
  const text = texts.join('\n')
  const paths = calls.map((call) => targetOf(call.name, call.args, input.cwd))
  const okPaths: string[] = []
  const notes: Note[] = []
  results.forEach((result, index) => {
    const path = paths[index] ?? null
    if (result.isError || path === null) return
    okPaths.push(path)
    notes.push({ kind: 'file', target: path, text: clip(`[file: ${path}]\n${texts[index] ?? ''}`, 600) })
  })
  const allFailed = results.length > 0 && results.every((result) => result.isError)
  const target = paths.filter((path): path is string => path !== null)
  const missed = allFailed && calls.every((call, i) => notStarted(call.name, texts[i] ?? ''))
  const outcome = !allFailed
    ? SUCCEEDED
    : NOT_APPLIED(
        missed
          ? stepError('TOOL_NOT_STARTED', 'recoverable', text)
          : stepError('EXECUTION_FAILED', 'recoverable', text),
      )
  const entry = entryOf(input, { op: 'read', target, outcome, text, isError: allFailed, calls })
  if (okPaths.length > 0) entry.read_files = okPaths
  return { entry, notes: allFailed ? [] : notes }
}

/** The outcome of calls whose result never came back, or that Core closed without running. */
export function outcomeUnknown(
  input: Common & { calls: Call[]; code: 'TOOL_OUTCOME_UNKNOWN' | 'TOOL_NOT_STARTED' },
): Observation {
  const { calls, code } = input
  const unknown = code === 'TOOL_OUTCOME_UNKNOWN'
  const text = unknown
    ? 'the call was dispatched but its result was lost; check the current state before repeating it'
    : 'the call was announced but did not run'
  const paths = calls.map((call) => targetOf(call.name, call.args, input.cwd))
  const targets = paths.filter((path): path is string => path !== null)
  const target = calls.length > 1 ? targets : (targets[0] ?? null)
  const outcome: Outcome = {
    status: 'failed',
    disposition: unknown ? 'UNKNOWN' : 'NOT_APPLIED',
    error: stepError(code, 'recoverable', text),
  }
  const op = calls[0]?.name ?? ''
  return { entry: entryOf(input, { op, target, outcome, text, isError: true, calls }), notes: [] }
}
