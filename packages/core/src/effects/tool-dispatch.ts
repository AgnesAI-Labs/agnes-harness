import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { ExecutionDomain } from '@agnes/protocol'
import { CoreError } from '../types.js'
import type { ExecuteAttempt } from './execute-permits.js'

export type HostDispatchObservation =
  | Readonly<{ phase: 'responded'; result: ToolResult }>
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
}>

type DispatchInput = Omit<HostToolDispatchInput, 'invoke'> &
  Readonly<{
    executionDomain: ExecutionDomain
    invoke: () => Promise<ToolResult>
    hostPort?: HostToolDispatchPort
  }>

const TOOL_RESULT_KEYS = new Set(['content', 'isError', 'details', 'terminate', 'structured', 'deferred'])
const ARTIFACT_REF_KEYS = new Set(['sha256', 'size', 'mime'])
const DEFERRED_KEYS = new Set(['jobId'])
const TOOL_TEXT_MAX_LENGTH = 1_048_576
const MIME_MAX_LENGTH = 128

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
    : Object.getPrototypeOf(value) === Object.prototype &&
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

function invalidObservation(reason: string): HostDispatchObservation {
  return {
    phase: 'may_have_sent',
    error: new CoreError('E_ENVELOPE', `invalid Host dispatch observation: ${reason}`),
  }
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
  if (input.executionDomain === 'workspace') {
    try {
      const result = await input.invoke()
      return isToolResult(result)
        ? { phase: 'responded', result }
        : invalidObservation('workspace tool returned an invalid ToolResult')
    } catch (error) {
      return { phase: 'may_have_sent', error }
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
    return validateObservation(value, invoked)
  } catch (error) {
    return { phase: 'may_have_sent', error }
  }
}
