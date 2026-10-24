import { CoreError, type Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import { type ChildAgentToolFilter, TOOL_NAME_PATTERN } from '@agnes/extension-api'
import { ToolRegistryView } from '../registry/tool-allow.js'
import type { ToolRegistry } from '../registry/tools.js'
import type { SessionImpl } from './session.js'

/**
 * A session's tool filter. It only narrows and it accumulates: every request is merged into the
 * current filter (deny is a union; allow is an intersection when both sides have one, else whichever
 * side has one), and nothing in the session can widen it again. Same shape as a child agent's filter,
 * so a child spawned from the session intersects with it through `narrowChildToolFilter`.
 */
export type SessionToolFilter = ChildAgentToolFilter

/** What one request names: at least one non-empty list, never more than this many names in a list. */
export const MAX_TOOL_FILTER_NAMES = 128
export const TOOL_FILTER_EVENT = 'x/core/tool-filter'

export type ToolFilterRule = 'session-deny' | 'session-allow'
export type ToolFilterRejection = 'invalid-request' | 'too-many-names' | 'unknown-tool'

/** A refused request or a damaged ledger row. `reason` is stable; `names` carries the offenders. */
export class ToolFilterError extends CoreError {
  constructor(
    readonly reason: ToolFilterRejection,
    message: string,
    readonly names: readonly string[] = [],
  ) {
    super('E_ENVELOPE', message, { reason, names })
    this.name = 'ToolFilterError'
  }
}

/** How a refused request is reported on the wire: a malformed one is invalid params, an unknown name is a semantic rejection. */
export function toolFilterRejection(error: ToolFilterError): {
  name: 'INVALID_PARAMS' | 'SEMANTIC_REJECTED'
  data: { code: 'TOOL_FILTER_REJECTED'; reason: ToolFilterRejection; names: readonly string[] }
} {
  return {
    name: error.reason === 'unknown-tool' ? 'SEMANTIC_REJECTED' : 'INVALID_PARAMS',
    data: { code: 'TOOL_FILTER_REJECTED', reason: error.reason, names: error.names },
  }
}

export const NO_TOOL_FILTER: SessionToolFilter = Object.freeze({})

function list(value: unknown, key: 'allow' | 'deny'): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0)
    throw new ToolFilterError('invalid-request', `${key} must be a non-empty list of tool names`)
  if (value.length > MAX_TOOL_FILTER_NAMES)
    throw new ToolFilterError('too-many-names', `${key} names more than ${MAX_TOOL_FILTER_NAMES} tools`)
  const bad = value.filter((name) => typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name))
  if (bad.length)
    throw new ToolFilterError(
      'invalid-request',
      `${key} holds names that are not tool names`,
      bad.map((name) => String(name).slice(0, 64)),
    )
  return Object.freeze([...new Set(value as string[])])
}

/**
 * Parses one request, which is also the exact shape of a `x/core/tool-filter` row. Anything else,
 * an unknown key included, is refused: a row that is not understood must never be read as "no filter".
 */
export function parseToolFilterRequest(data: unknown): SessionToolFilter {
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new ToolFilterError('invalid-request', 'tool filter must be an object')
  const record = data as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => key !== 'allow' && key !== 'deny')
  if (unknown.length) throw new ToolFilterError('invalid-request', 'tool filter has unknown fields', unknown)
  const allow = list(record.allow, 'allow')
  const deny = list(record.deny, 'deny')
  if (!allow && !deny) throw new ToolFilterError('invalid-request', 'tool filter names no tools')
  return Object.freeze({ ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) })
}

/** Merge one request into the current filter. Never widens. */
export function mergeToolFilter(current: SessionToolFilter, request: SessionToolFilter): SessionToolFilter {
  const allow =
    current.allow === undefined
      ? request.allow
      : request.allow === undefined
        ? current.allow
        : current.allow.filter((name) => request.allow?.includes(name))
  const deny = [...new Set([...(current.deny ?? []), ...(request.deny ?? [])])]
  return Object.freeze({
    ...(allow === undefined ? {} : { allow: Object.freeze([...allow]) }),
    ...(deny.length ? { deny: Object.freeze(deny) } : {}),
  })
}

/** Fold every persisted row, in seq order, into the effective filter. A damaged row throws. */
export function foldToolFilter(rows: readonly { data: unknown }[]): SessionToolFilter {
  return rows.reduce(
    (filter, row) => mergeToolFilter(filter, parseToolFilterRequest(row.data)),
    NO_TOOL_FILTER,
  )
}

export function toolFilterRule(filter: SessionToolFilter, name: string): ToolFilterRule | undefined {
  if (filter.deny?.includes(name)) return 'session-deny'
  if (filter.allow !== undefined && !filter.allow.includes(name)) return 'session-allow'
  return undefined
}

/** Every name of a request must be a tool this session has registered. */
export function assertKnownTools(request: SessionToolFilter, known: ReadonlySet<string>): void {
  const unknown = [...(request.allow ?? []), ...(request.deny ?? [])].filter((name) => !known.has(name))
  if (unknown.length)
    throw new ToolFilterError('unknown-tool', 'tool filter names tools this session does not have', unknown)
}

/** The registry a session hands out once a filter is set: a live view, so late registrations and direct lookups obey it too. */
export function filteredTools(source: ToolRegistry, filter: () => SessionToolFilter): ToolRegistry {
  return new ToolRegistryView(source, () =>
    source
      .list()
      .map((tool) => tool.name)
      .filter((name) => toolFilterRule(filter(), name) === undefined),
  )
}

/**
 * Narrows the session's tools, durably. The row is the request itself; the merged result lives in
 * memory and is rebuilt from every row on open. Takes the same lock as `setPreset`, so two requests
 * cannot merge against one stale filter, and a failed append leaves the filter as it was.
 */
export async function setToolFilter(
  s: SessionImpl,
  data: unknown,
): Promise<{ seq: Seq; filter: SessionToolFilter }> {
  const request = parseToolFilterRequest(data)
  return s.locked(async () => {
    const raw = s.d.currentRuntime?.current(s.key)?.tools ?? s.d.registry
    assertKnownTools(request, new Set(raw.list().map((tool) => tool.name)))
    const filter = mergeToolFilter(s.toolFilter, request)
    const written = await s.d.log.append([s.ev(TOOL_FILTER_EVENT, request, { ignorable: true })])
    s.toolFilter = filter
    return { seq: written.firstSeq, filter }
  })
}

/** Opening a session rebuilds its filter from the whole ledger; one damaged row refuses the open. */
export async function restoreToolFilter(s: SessionImpl): Promise<void> {
  s.toolFilter = foldToolFilter(
    await scanAll((q) => s.scan(q), { type: TOOL_FILTER_EVENT, order: 'asc', toSeq: s.lastSeq }),
  )
}
