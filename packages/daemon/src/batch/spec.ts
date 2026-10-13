import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BATCH_ITEM_SESSION_PATTERN, type BatchSpec, inspectJsonData, validateMethod } from '@agnes/protocol'
import type { ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'

export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_ITEM_TIMEOUT_SEC = 600
export const MAX_ITEMS = 100_000
export const MAX_SCHEMA_BYTES = 32 * 1024
/** With no success yet, this many failed or invalid items stop the batch. */
export const FAIL_FAST_ITEMS = 5

/**
 * Keywords an output schema may not use: the check runs on the daemon's event loop against replies a
 * file's content can steer, and these can take seconds to minutes on one reply (`pattern` and
 * `patternProperties` by regex backtracking, `uniqueItems: true` by comparing every pair of items).
 * `uniqueItems: false` is allowed. Properties that merely carry these names are fine.
 */
export const UNSUPPORTED_SCHEMA_KEYWORDS = ['pattern', 'patternProperties', 'uniqueItems'] as const

const BATCH_ID = /^b[0-9a-f]{12}$/u
const MAX_PROBLEMS = 5
const MAX_PROBLEM_PATH = 200

/** A request the caller can fix: wrong folder, malformed options, an output schema that does not compile. */
export class BatchSpecError extends Error {
  override readonly name = 'BatchSpecError'
}

/** Undefined when the value matches; otherwise the first problems, for the repair prompt and errors.jsonl. */
export type OutputCheck = (value: unknown) => string | undefined

export type ResolvedSpec = Readonly<{
  spec: BatchSpec
  dirAbs: string
  dirRel: string
  outAbs: string
  outRel: string
  concurrency: number
  itemTimeoutMs: number
}>

export const itemSessionKey = (profile: string, batchId: string, ordinal: number): string =>
  `agnes:local:${profile}:batch:${batchId}:${ordinal}`
export const isItemSession = (sessionKey: string): boolean => BATCH_ITEM_SESSION_PATTERN.test(sessionKey)
/** Item sessions belong to the batch, not to a person, so they stay out of every session list. */
export const itemPrincipal = (batchId: string): string => `batch:${batchId}`
export const toPosix = (path: string): string => path.split(sep).join('/')

/**
 * Characters that break a prompt line or hide text from a reader: C0 and C1 controls, zero-width and
 * invisible formatting characters, line and paragraph separators, bidirectional controls, the byte
 * order mark and Unicode tag characters. One code point per match (the `u` flag).
 */
export const UNSAFE_TEXT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu

/** Text that came from a file name or a model reply, made safe to place on one prompt line. */
export const singleLine = (text: string, replacement = ' '): string =>
  text.replace(UNSAFE_TEXT, () => replacement)

/** Lexical containment; callers that care about links compare real paths. */
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Compiles a caller's output schema: JSON data only (no getters, cycles or deep nesting), at most
 * 32 KiB, top-level object, synchronous, and every `$ref` resolvable without loading anything.
 */
/**
 * An Ajv whose refused keywords throw at compile time. The meta-schema itself uses `pattern`, so it is
 * compiled first, with the stock keywords; schemas compiled afterwards get the overrides.
 * `ownProperties` keeps inherited names such as `constructor` from satisfying `required`.
 */
function outputSchemaCompiler(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false, ownProperties: true })
  ajv.validateSchema({})
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    ajv.removeKeyword(keyword)
    ajv.addKeyword({
      keyword,
      compile: (value: unknown) => {
        if (keyword === 'uniqueItems' && value === false) return () => true
        throw new Error(`"${keyword}" is not supported in batch output schemas`)
      },
    })
  }
  return ajv
}

export function compileOutputSchema(schema: unknown): OutputCheck {
  const inspected = inspectJsonData(schema, MAX_SCHEMA_BYTES)
  if (!inspected.ok) throw new BatchSpecError('the output schema must be JSON of at most 32 KiB')
  const copy = inspected.value
  if (!copy || typeof copy !== 'object' || Array.isArray(copy) || copy.type !== 'object')
    throw new BatchSpecError('the output schema must describe an object ("type": "object")')
  if ('$async' in copy) throw new BatchSpecError('the output schema must not be asynchronous ($async)')
  // Draft-07 and 2020-12 authors both write $schema; the dialect here is always 2020-12.
  delete copy.$schema
  let validate: ValidateFunction
  try {
    validate = outputSchemaCompiler().compile(copy)
  } catch (error) {
    throw new BatchSpecError(
      `the output schema does not compile: ${singleLine(error instanceof Error ? error.message : 'invalid schema')}`,
    )
  }
  if ('$async' in validate && validate.$async)
    throw new BatchSpecError('the output schema must not be asynchronous ($async)')
  return (value) => {
    try {
      if (validate(value) === true) return undefined
    } catch {
      // A reply nested deep enough to exhaust the stack is not an acceptable answer.
      return 'the reply is nested too deeply to check'
    }
    // Instance paths repeat keys the model wrote: keep them on one line and short.
    const problems = (validate.errors ?? [])
      .slice(0, MAX_PROBLEMS)
      .map(
        (error) =>
          `${singleLine(error.instancePath || '/').slice(0, MAX_PROBLEM_PATH)} ${singleLine(error.message ?? 'is invalid')}`,
      )
    return problems.length > 0 ? problems.join('; ') : 'does not match the schema'
  }
}

export function resolveSpec(input: {
  root: string
  cwd: string
  spec: unknown
  batchId: string
}): ResolvedSpec {
  if (!BATCH_ID.test(input.batchId)) throw new BatchSpecError('malformed batch id')
  // Copied first and only the copy is checked and used: getters run once, later changes stay out.
  let spec: BatchSpec
  try {
    spec = structuredClone(input.spec) as BatchSpec
  } catch {
    throw new BatchSpecError('invalid batch spec: it is not plain JSON data')
  }
  const checked = validateMethod('_agnes/v1/batch.start', 'params', { cwd: input.cwd, spec })
  if (!checked.ok)
    throw new BatchSpecError(
      `invalid batch spec: ${checked.errors
        .slice(0, 3)
        .map((error) => `${error.path || '/'} ${error.message}`)
        .join('; ')}`,
    )
  for (const path of [input.cwd, spec.dir, spec.outDir])
    if (path?.includes('\0')) throw new BatchSpecError('folder names must not contain NUL bytes')
  const root = resolve(input.root)
  const cwd = resolve(root, input.cwd)
  if (!inside(root, cwd)) throw new BatchSpecError('the working directory is outside the workspace')
  const dirAbs = resolve(cwd, spec.dir)
  if (!inside(root, dirAbs)) throw new BatchSpecError('dir must stay inside the workspace')
  const outAbs =
    spec.outDir === undefined ? join(root, 'agh-batch', input.batchId) : resolve(cwd, spec.outDir)
  if (!inside(root, outAbs) || outAbs === root)
    throw new BatchSpecError('outDir must be a folder inside the workspace')
  // Enumeration leaves the results folder out, so one that holds dir would hide every input.
  if (inside(outAbs, dirAbs)) throw new BatchSpecError('outDir must not be dir or a folder that contains it')
  // Hidden folders (.git, .agnes, ...) hold tool and agent configuration; model-written results stay out.
  if (
    toPosix(relative(root, outAbs))
      .split('/')
      .some((segment) => segment.startsWith('.'))
  )
    throw new BatchSpecError('outDir must not be or be inside a hidden folder (a name starting with ".")')
  if (spec.schema !== undefined) compileOutputSchema(spec.schema)
  return Object.freeze({
    spec,
    dirAbs,
    dirRel: toPosix(relative(root, dirAbs)),
    outAbs,
    outRel: toPosix(relative(root, outAbs)),
    concurrency: spec.concurrency ?? DEFAULT_CONCURRENCY,
    itemTimeoutMs: (spec.itemTimeoutSec ?? DEFAULT_ITEM_TIMEOUT_SEC) * 1000,
  })
}
