import { HOOK_EVENTS, type HookEvent, type HookReturnMap, type ToolResult } from '@agnes/extension-api'

const MAX_ADDITIONAL_CONTEXT = 8192

export type CcHookMapEntry = { to: HookEvent[] | null; reason?: string; unsupportedFields?: string[] }
export type CcHookMap = { version: string; events: Record<string, CcHookMapEntry> }
export type HookProcessResult = { exitCode: number; stdout: string; stderr: string } & {
  output?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validEntry(value: unknown): value is CcHookMapEntry {
  if (!isRecord(value)) return false
  if (value.reason !== undefined && typeof value.reason !== 'string') return false
  if (
    value.unsupportedFields !== undefined &&
    (!Array.isArray(value.unsupportedFields) ||
      value.unsupportedFields.some((field) => typeof field !== 'string'))
  )
    return false
  if (value.to === null) return true
  if (!Array.isArray(value.to) || value.to.length === 0) return false
  if (value.to.some((event) => typeof event !== 'string' || !HOOK_EVENTS.includes(event as HookEvent)))
    return false
  return new Set(value.to).size === value.to.length
}

export function mapEvent(map: CcHookMap, ccEvent: string): { to: HookEvent[] } | { unsupported: string } {
  if (!isRecord(map) || typeof map.version !== 'string' || !isRecord(map.events))
    throw new Error('invalid Claude Code hook map')
  const entry: unknown = map.events[ccEvent]
  if (entry === undefined) return { unsupported: `unknown Claude Code hook event ${ccEvent}` }
  if (!validEntry(entry)) throw new Error(`invalid Claude Code hook map entry for ${ccEvent}`)
  return entry.to === null
    ? { unsupported: entry.reason ?? `Claude Code hook event ${ccEvent} is not mapped` }
    : { to: [...entry.to] }
}

function hookOutput(result: HookProcessResult): Record<string, unknown> {
  const output = result.output ?? {}
  const nested = output.hookSpecificOutput
  if (nested === undefined) return output
  if (!isRecord(nested)) throw new Error('hookSpecificOutput must be an object')
  return nested
}

function optionalString(object: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maxLength)
    throw new Error(`hook ${key} must be a string of at most ${maxLength} characters`)
  return value
}

function blockReason(result: HookProcessResult, output: Record<string, unknown>, max: number): string {
  const top = result.output ?? {}
  const reason =
    optionalString(output, 'permissionDecisionReason', max) ??
    optionalString(output, 'reason', max) ??
    optionalString(top, 'reason', max) ??
    result.stderr.trim() ??
    'hook blocked'
  const normalized = reason.length === 0 ? 'hook blocked' : reason
  if (normalized.length > max) throw new Error(`hook reason must be at most ${max} characters`)
  return normalized
}

function isBlocked(result: HookProcessResult, output: Record<string, unknown>): boolean {
  return (
    result.exitCode === 2 ||
    result.output?.decision === 'block' ||
    output.decision === 'block' ||
    output.permissionDecision === 'deny'
  )
}

function observeReturn<E extends HookEvent>(event: E, blocked: boolean): HookReturnMap[E] {
  if (blocked) throw new Error(`hook result cannot block observe hook ${event}`)
  return undefined as HookReturnMap[E]
}

/** Translate the subset of Claude Code return fields that Agnes can represent without guessing. */
export function translateReturn<E extends HookEvent>(
  event: E,
  result: HookProcessResult,
  currentToolResult?: ToolResult,
): HookReturnMap[E] {
  if (result.exitCode !== 0 && result.exitCode !== 2)
    throw new Error(`unexpected hook exit code ${result.exitCode}`)

  const output = hookOutput(result)
  const blocked = isBlocked(result, output)
  switch (event) {
    case 'tool_call':
      return (
        blocked ? { allow: false, reason: blockReason(result, output, 1024) } : { allow: true }
      ) as HookReturnMap[E]
    case 'before_step':
      return (blocked ? { block: true, reason: blockReason(result, output, 1024) } : {}) as HookReturnMap[E]
    case 'turn_stopping':
      return (
        blocked ? { action: 'continue', note: blockReason(result, output, 2048) } : { action: 'stop' }
      ) as HookReturnMap[E]
    case 'context':
    case 'resources_discover': {
      if (blocked) throw new Error(`hook result cannot block ${event}`)
      const additionalContext = optionalString(output, 'additionalContext', MAX_ADDITIONAL_CONTEXT)
      return (additionalContext === undefined ? {} : { additionalContext }) as HookReturnMap[E]
    }
    case 'tool_result': {
      const additionalContext = optionalString(output, 'additionalContext', MAX_ADDITIONAL_CONTEXT)
      if (additionalContext === undefined && !blocked) return {} as HookReturnMap[E]
      if (currentToolResult === undefined)
        throw new Error('tool_result translation requires the current result to append safely')
      const additions: ToolResult['content'] = []
      if (additionalContext !== undefined) additions.push({ type: 'text', text: additionalContext })
      if (blocked) additions.push({ type: 'text', text: `blocked: ${blockReason(result, output, 1024)}` })
      return {
        result: {
          ...currentToolResult,
          content: [...currentToolResult.content, ...additions],
          ...(blocked ? { isError: true } : {}),
        },
      } as HookReturnMap[E]
    }
    case 'approval_request':
      if (blocked) throw new Error('hook result cannot return an approval verdict')
      return {} as HookReturnMap[E]
    case 'before_compact':
      if (blocked) throw new Error('hook result cannot synthesize a compaction plan')
      return null as HookReturnMap[E]
    case 'session_start':
    case 'request_error':
    case 'compact':
    case 'subagent_start':
    case 'subagent_end':
    case 'format_deviation':
    case 'shutdown':
      return observeReturn(event, blocked)
    case 'before_request':
    case 'before_provider_headers':
      if (blocked) throw new Error(`hook result cannot block ${event}`)
      return {} as HookReturnMap[E]
  }
}
