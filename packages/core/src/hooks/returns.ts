import { CoreError } from '@agnes/core-common/types'
import { boundToolResult } from '@agnes/core-effects/effects/tool-dispatch'
import type { HookEvent, HookReturnMap } from '@agnes/extension-api'
import { HOOK_TABLE, inspectJsonData, validateAgainst, validateHook } from '@agnes/protocol'
import type { ContextReturn } from '@agnes/protocol/gen/hooks'
import { ArtifactRef, JsonValue } from '@agnes/protocol/gen/session-v1'
import { Type } from '@sinclair/typebox'

// Only author/wire differences live here. All matching returns use the generated protocol schema.
const closed = { additionalProperties: false } as const
const authorToolResult = Type.Object(
  {
    result: Type.Optional(
      Type.Object(
        {
          content: Type.Array(
            Type.Union([
              Type.Object({ type: Type.Literal('text'), text: Type.String() }, closed),
              Type.Object({ type: Type.Literal('image'), ref: ArtifactRef, mime: Type.String() }, closed),
              Type.Object(
                { type: Type.Literal('ref'), ref: ArtifactRef, mime: Type.Optional(Type.String()) },
                closed,
              ),
            ]),
          ),
          isError: Type.Optional(Type.Boolean()),
          details: Type.Optional(JsonValue),
          terminate: Type.Optional(Type.Boolean()),
        },
        closed,
      ),
    ),
  },
  closed,
)
const authorApproval = Type.Object(
  {
    request: Type.Optional(
      Type.Object(
        {
          risk: Type.Optional(
            Type.Union([Type.Literal('destructive'), Type.Literal('always'), Type.Literal('budget')]),
          ),
          context: Type.Optional(Type.String({ maxLength: 4096 })),
          summary: Type.Optional(Type.String()),
        },
        closed,
      ),
    ),
  },
  closed,
)

function invalid(): never {
  throw new CoreError('E_ENVELOPE', 'invalid author hook return')
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function contextWire(snapshot: unknown): ContextReturn {
  const value = object(snapshot, ['sections', 'additionalContext', 'untrustedContext', 'refreshOnRequest'])
  const result: Record<string, unknown> = { ...value }
  if ('sections' in value) {
    if (!Array.isArray(value.sections)) invalid()
    result.sections = value.sections.map((section: unknown) => {
      const item = object(section, ['id', 'order', 'content', 'source', 'delivery'])
      if ('source' in item && typeof item.source !== 'string') invalid()
      return {
        id: item.id,
        order: item.order,
        text: item.content,
        ...('delivery' in item ? { delivery: item.delivery } : {}),
      }
    })
  }
  if (!validateHook('context', 'return', result).ok) invalid()
  return result as ContextReturn
}

/** Largest tool result a hook may hand back before the session's own budget cuts it down. */
const HOOK_TOOL_RESULT_MAX_BYTES = 16_777_216

/**
 * Closed author return validation. Never execute getters or reuse an extension-owned object.
 * A `tool_result` return is copied under a hard ceiling and cut to `resultMaxBytes` before it is validated,
 * so the platform never validates or re-clones more than the session budget.
 */
export function authorHookReturn<E extends HookEvent>(
  event: E,
  value: unknown,
  resultMaxBytes = Number.POSITIVE_INFINITY,
): HookReturnMap[E] {
  if (HOOK_TABLE[event].category === 'observe') {
    if (value !== undefined || !validateHook(event, 'return', null).ok) invalid()
    return undefined as HookReturnMap[E]
  }
  const inspected = inspectJsonData(
    value,
    event === 'tool_result' ? HOOK_TOOL_RESULT_MAX_BYTES : Number.MAX_SAFE_INTEGER,
  )
  if (!inspected.ok) invalid()
  const snapshot =
    event === 'tool_result' ? boundedHookResult(inspected.value, resultMaxBytes) : inspected.value
  if (event === 'context') contextWire(snapshot)
  else if (event === 'tool_result') {
    if (!validateAgainst(authorToolResult, snapshot).ok) invalid()
  } else if (event === 'approval_request') {
    if (!validateAgainst(authorApproval, snapshot).ok) invalid()
  } else if (!validateHook(event, 'return', snapshot).ok) invalid()
  return snapshot as HookReturnMap[E]
}

/** The core18 wire transform stamps source from registration, never from author-controlled source. */
export function contextReturnToWire(value: HookReturnMap['context']): ContextReturn {
  return contextWire(authorHookReturn('context', value))
}

function boundedHookResult(snapshot: unknown, resultMaxBytes: number): unknown {
  const result = (snapshot as { result?: unknown } | null)?.result
  return result === undefined
    ? snapshot
    : { ...(snapshot as object), result: boundToolResult(result, resultMaxBytes) }
}
