import { canonicalJson } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { ToolContext, ToolResult, ToolRuntime } from '@agnes/extension-api'
import { type ExecutionDomain, inspectJsonData } from '@agnes/protocol'
import { attestedRejection } from './effect-scope.js'
import type { ExecuteAttempt } from './execute-permits.js'

/** Bounded diagnostic data; only platform-owned ports can attest no effect. */
export type RejectedBeforeEffectError = Readonly<{
  code: string
  message: string
  path?: string
  expected?: string
  issues?: Array<{ path: string; expected: string }>
}>

export { hostPortRequest } from './effect-scope.js'

export type HostDispatchObservation =
  | Readonly<{ phase: 'responded'; result: ToolResult }>
  | Readonly<{ phase: 'rejected_before_effect'; error: RejectedBeforeEffectError }>
  | Readonly<{ phase: 'not_sent'; error: unknown }>
  | Readonly<{ phase: 'may_have_sent'; error: unknown }>

export type HostToolDispatchInput = Readonly<{
  name: string
  args: unknown
  context: ToolContext
  attempt: ExecuteAttempt
  /** The one-shot, permit-bound invocation the Host port observes. */
  invoke: () => Promise<ToolResult>
}>

/**
 * Host-private dispatch attestation. Returning `unknown` is intentional: Core validates the
 * observation at the trust boundary instead of trusting a structurally compatible object.
 */
export type HostToolDispatchPort = Readonly<{
  dispatch(input: HostToolDispatchInput): Promise<unknown>
  /**
   * Optional platform validation for either execution domain, before runtime or author code.
   * Return undefined to dispatch, or diagnostic data only when the adapter proves rejection
   * before ANY observable effect. Throws and invalid diagnostics remain uncertain. This is
   * Host-owned authority, never a plugin error-code classifier or a ToolContext capability.
   */
  preflight?(input: Omit<HostToolDispatchInput, 'invoke'>): Promise<unknown>
}>

type DispatchInput = Omit<HostToolDispatchInput, 'invoke'> &
  Readonly<{
    executionDomain: ExecutionDomain
    invoke: () => Promise<ToolResult>
    hostPort?: HostToolDispatchPort
    runtime?: ToolRuntime
    concurrencySafe?: boolean
  }>

const TOOL_RESULT_KEYS = new Set(['content', 'isError', 'details', 'terminate', 'structured', 'deferred'])
const ARTIFACT_REF_KEYS = new Set(['sha256', 'size', 'mime'])
const DEFERRED_KEYS = new Set(['jobId'])
const TOOL_TEXT_MAX_LENGTH = 1_048_576
const MIME_MAX_LENGTH = 128

/** Ceilings on one tool result that no preset can raise; `outputMaxBytes` bounds the text on top of them. */
export const TOOL_RESULT_LIMITS = Object.freeze({
  maxBlocks: 256,
  maxJsonBytes: 262_144,
  maxJsonDepth: 32,
  maxJsonNodes: 50_000,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
      Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

function isArtifactRef(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ARTIFACT_REF_KEYS)) return false
  return (
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.mime === 'string' &&
    value.mime.length <= MIME_MAX_LENGTH
  )
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'text':
      return (
        hasOnlyKeys(value, new Set(['type', 'text'])) &&
        typeof value.text === 'string' &&
        value.text.length <= TOOL_TEXT_MAX_LENGTH
      )
    case 'image':
      return (
        hasOnlyKeys(value, new Set(['type', 'ref', 'mime'])) &&
        isArtifactRef(value.ref) &&
        typeof value.mime === 'string' &&
        value.mime.length <= MIME_MAX_LENGTH
      )
    case 'ref':
      return (
        hasOnlyKeys(value, new Set(['type', 'ref', 'mime'])) &&
        isArtifactRef(value.ref) &&
        (value.mime === undefined || (typeof value.mime === 'string' && value.mime.length <= MIME_MAX_LENGTH))
      )
    default:
      return false
  }
}

/**
 * Encoded size of a JSON-ish value, or undefined once it is over the depth, node or byte ceiling. Container
 * width is checked while children are queued, so a huge array or object is never enumerated in full.
 */
function boundedJsonSize(root: unknown): number | undefined {
  const { maxJsonBytes, maxJsonDepth, maxJsonNodes } = TOOL_RESULT_LIMITS
  let bytes = 0
  let nodes = 0
  const stack: Array<[unknown, number]> = [[root, 1]]
  const push = (child: unknown, depth: number): boolean => {
    stack.push([child, depth])
    return nodes + stack.length <= maxJsonNodes
  }
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [value, depth] = item
    if (++nodes > maxJsonNodes || depth > maxJsonDepth) return undefined
    if (typeof value === 'string') {
      if (value.length > maxJsonBytes) return undefined
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
    } else if (typeof value !== 'object' || value === null) bytes += String(value).length
    else if (Array.isArray(value)) {
      bytes += 2 + value.length
      for (let i = 0; i < value.length; i++) if (!push(value[i], depth + 1)) return undefined
    } else {
      bytes += 2
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (key.length > maxJsonBytes) return undefined
        bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 2
        if (!push((value as Record<string, unknown>)[key], depth + 1)) return undefined
      }
    }
    if (bytes > maxJsonBytes) return undefined
  }
  return bytes
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  // A UTF-16 unit encodes to at least one byte, so the first `maxBytes` units hold every byte that can survive.
  const cut = Buffer.from(text.slice(0, maxBytes), 'utf8').subarray(0, maxBytes).toString('utf8')
  return cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut
}

/**
 * Enforce the result budget on a value that has not been validated, cloned, hooked or persisted yet:
 * total UTF-8 text bytes (`outputMaxBytes`), block count, and the encoded size and depth of
 * `structured`/`details`. An over-budget result keeps what fits and gains one text marker saying what was
 * dropped (at most 256 bytes beyond the budget, and the block count still includes it). The cut is lossy:
 * dropped blocks and refs are gone, and a replaced `structured`/`details` becomes `{ truncated: true }`,
 * so a result that must stay whole belongs behind an artifact ref. A value that is not result-shaped is
 * returned untouched for validation to refuse.
 */
export function boundToolResult<T>(value: T, outputMaxBytes: number): T {
  if (!isRecord(value) || !Array.isArray(value.content)) return value
  const omitted: string[] = []
  const limit = Number.isFinite(outputMaxBytes)
    ? Math.max(0, Math.floor(outputMaxBytes))
    : Number.POSITIVE_INFINITY
  let remaining = limit
  const { maxBlocks } = TOOL_RESULT_LIMITS
  const tooMany = value.content.length > maxBlocks
  const blocks = value.content.slice(0, tooMany ? maxBlocks - 1 : maxBlocks)
  if (tooMany)
    omitted.push(`${value.content.length - blocks.length} blocks over the ${maxBlocks}-block limit`)
  let droppedText = 0
  const content: unknown[] = []
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      content.push(block)
      continue
    }
    const size = Buffer.byteLength(block.text, 'utf8')
    if (size <= remaining) {
      remaining -= size
      content.push(block)
    } else {
      droppedText += size - remaining
      if (remaining > 0) content.push({ ...block, text: truncateUtf8(block.text, remaining) })
      remaining = 0
    }
  }
  if (droppedText) omitted.push(`${droppedText} text bytes over the ${limit}-byte limit`)
  const json: Record<string, unknown> = {}
  for (const key of ['details', 'structured'] as const) {
    if (value[key] !== undefined && boundedJsonSize(value[key]) === undefined) {
      json[key] = { truncated: true }
      omitted.push(`${key} over the size or depth limit`)
    }
  }
  if (!omitted.length) return value
  if (content.length >= maxBlocks) content.pop()
  content.push({ type: 'text', text: `[output truncated: ${omitted.join('; ')}]` })
  return { ...value, ...json, content } as T
}

export function isToolResult(value: unknown): value is ToolResult {
  if (!isRecord(value) || !hasOnlyKeys(value, TOOL_RESULT_KEYS) || !Array.isArray(value.content)) return false
  if (!value.content.every(isContentBlock)) return false
  if (value.isError !== undefined && typeof value.isError !== 'boolean') return false
  if (value.terminate !== undefined && typeof value.terminate !== 'boolean') return false
  if (value.details !== undefined && !isJsonValue(value.details)) return false
  if (value.structured !== undefined && !isJsonValue(value.structured)) return false
  if (
    value.deferred !== undefined &&
    (!isRecord(value.deferred) ||
      !hasOnlyKeys(value.deferred, DEFERRED_KEYS) ||
      typeof value.deferred.jobId !== 'string' ||
      value.deferred.jobId.length < 1 ||
      value.deferred.jobId.length > 128)
  )
    return false
  return true
}

function rejectedBeforeEffect(value: unknown): RejectedBeforeEffectError | undefined {
  const parsed = inspectJsonData(value, 16_384)
  if (!parsed.ok || !isRecord(parsed.value)) return undefined
  const data = parsed.value
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096
  if (
    !hasOnlyKeys(data, new Set(['code', 'message', 'path', 'expected', 'issues'])) ||
    typeof data.code !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(data.code) ||
    !text(data.message) ||
    (data.path !== undefined && !text(data.path)) ||
    (data.expected !== undefined && !text(data.expected)) ||
    (data.issues !== undefined &&
      (!Array.isArray(data.issues) ||
        data.issues.length > 8 ||
        !data.issues.every(
          (issue) =>
            isRecord(issue) &&
            hasOnlyKeys(issue, new Set(['path', 'expected'])) &&
            text(issue.path) &&
            text(issue.expected),
        )))
  )
    return undefined
  return data as RejectedBeforeEffectError
}

function invalidObservation(reason: string): HostDispatchObservation {
  return {
    phase: 'may_have_sent',
    error: new CoreError('E_ENVELOPE', `invalid Host dispatch observation: ${reason}`),
  }
}

function boundObservation(value: unknown, outputMaxBytes: number): unknown {
  return isRecord(value) && value.phase === 'responded'
    ? { ...value, result: boundToolResult(value.result, outputMaxBytes) }
    : value
}

function validateObservation(value: unknown, invoked: boolean): HostDispatchObservation {
  if (!isRecord(value) || typeof value.phase !== 'string') return invalidObservation('expected an object')
  if (value.phase === 'responded') {
    if (!hasOnlyKeys(value, new Set(['phase', 'result'])) || !isToolResult(value.result))
      return invalidObservation('responded requires one valid ToolResult')
    if (!invoked) return invalidObservation('responded without invoking the bound tool')
    return { phase: 'responded', result: value.result }
  }
  if (value.phase === 'not_sent' || value.phase === 'may_have_sent') {
    if (!hasOnlyKeys(value, new Set(['phase', 'error'])) || !Object.hasOwn(value, 'error'))
      return invalidObservation(`${value.phase} requires an error`)
    // The trusted Host port sits around the real connection. It may enter the wrapper and still
    // prove that the OS/pipe accepted zero bytes; ordinary tools cannot return this observation.
    return { phase: value.phase, error: value.error }
  }
  return invalidObservation('unknown phase')
}

export function assertToolDispatchAvailable(
  executionDomain: ExecutionDomain,
  hostPort: HostToolDispatchPort | undefined,
): void {
  if (executionDomain === 'host-computer-use' && !hostPort)
    throw new CoreError('E_SEAM_MISSING', 'host-computer-use dispatch port')
}

/** Dispatches one already-authorized attempt and returns only Core-minted phase observations. */
export async function dispatchTool(input: DispatchInput): Promise<HostDispatchObservation> {
  if (input.hostPort?.preflight) {
    try {
      const value = await input.hostPort.preflight({
        name: input.name,
        args: input.args,
        context: input.context,
        attempt: input.attempt,
      })
      if (value !== undefined) {
        const error = rejectedBeforeEffect(value)
        return error
          ? { phase: 'rejected_before_effect', error }
          : invalidObservation('invalid pre-effect rejection diagnostic')
      }
    } catch (error) {
      return { phase: 'may_have_sent', error }
    }
  }
  if (input.runtime) {
    const runtime = input.runtime
    const parsed = inspectJsonData(input.args)
    if (!parsed.ok) throw new CoreError('E_ENVELOPE', 'invalid runtime tool arguments')
    const call = {
      id: input.context.session.toolUseId,
      name: input.name,
      args: parsed.value,
      concurrencySafe: input.concurrencySafe === true,
    }
    const expectedId = call.id,
      expectedName = call.name,
      expectedArgs = canonicalJson(call.args)
    let dispatched = false
    const originalInvoke = input.invoke
    input = {
      ...input,
      invoke: () =>
        runtime.execute(
          structuredClone(call),
          {
            dispatch: async (next, signal) => {
              signal.throwIfAborted()
              if (dispatched)
                throw new CoreError('E_EXECUTE_PERMIT', 'ToolRuntime dispatched an attempt more than once')
              if (
                next.id !== expectedId ||
                next.name !== expectedName ||
                canonicalJson(next.args) !== expectedArgs
              )
                throw new CoreError('E_EXECUTE_PERMIT', 'ToolRuntime changed an authorized call')
              dispatched = true
              return originalInvoke()
            },
          },
          input.context.signal,
        ),
    }
  }
  if (input.executionDomain === 'workspace') {
    try {
      const result = boundToolResult(await input.invoke(), input.context.outputMaxBytes)
      return isToolResult(result)
        ? { phase: 'responded', result }
        : invalidObservation('workspace tool returned an invalid ToolResult')
    } catch (error) {
      const refusal = attestedRejection(input.context, error)
      const diagnostic = refusal && rejectedBeforeEffect(refusal)
      return diagnostic
        ? { phase: 'rejected_before_effect', error: diagnostic }
        : { phase: 'may_have_sent', error }
    }
  }

  assertToolDispatchAvailable(input.executionDomain, input.hostPort)
  let invoked = false
  const invoke = async () => {
    if (invoked) throw new CoreError('E_EXECUTE_PERMIT', 'Host dispatch port invoked the tool more than once')
    invoked = true
    return input.invoke()
  }
  try {
    const value = await input.hostPort?.dispatch({
      name: input.name,
      args: input.args,
      context: input.context,
      attempt: input.attempt,
      invoke,
    })
    return validateObservation(boundObservation(value, input.context.outputMaxBytes), invoked)
  } catch (error) {
    return { phase: 'may_have_sent', error }
  }
}
