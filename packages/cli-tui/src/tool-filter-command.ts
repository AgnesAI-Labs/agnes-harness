import { randomUUID } from 'node:crypto'
import type { SessionToolsResult } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'

type Pending = { kind: 'deny' | 'only'; names: string[]; commandId: string }
const pending = new WeakMap<object, Pending>()
/** The names that are on right now, as of the last listing: what Tab completes after `/tools deny `. */
const onNames = new WeakMap<object, string[]>()
const fetching = new WeakSet<object>()

type Row = { name: string; on: boolean; why?: string }

/** One row per tool the session has, on or off, with the first reason a tool that is off was turned off. */
function rowsOf(result: SessionToolsResult, locale: string): Row[] {
  const reason = (reasons: NonNullable<SessionToolsResult['capabilities']>['tools'][number]['reasons']) => {
    const first = reasons[0]
    if (!first) return undefined
    if (first.rule === 'session-deny') return tt('tools.reasonSessionDeny', locale)
    if (first.rule === 'session-allow') return tt('tools.reasonSessionAllow', locale)
    return tt('tools.reasonOther', locale, {
      layer: first.source.layer,
      name: first.source.name,
      rule: first.rule,
    })
  }
  const capabilities = result.capabilities?.tools
  const rows: Row[] = capabilities
    ? capabilities.map((tool) => ({
        name: tool.id,
        on: tool.enabled,
        ...(tool.enabled ? {} : { why: reason(tool.reasons) ?? '' }),
      }))
    : result.tools.map((tool) => ({ name: tool.name, on: true }))
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

function remember(app: TuiApp, rows: readonly Row[]): void {
  onNames.set(
    app.session,
    rows.filter((row) => row.on).map((row) => row.name),
  )
}

/** `/tools`: list, or `deny`/`only` followed by `confirm`, because a narrowing cannot be taken back in the session. */
export async function toolsSlash(app: TuiApp, args: readonly string[]): Promise<SlashResult> {
  const locale = app.locale
  const session = app.session
  const verb = args[0]
  if (verb === 'cancel') {
    pending.delete(session)
    return { text: tt('tools.cancelled', locale) }
  }
  if (verb === 'confirm') {
    const next = pending.get(session)
    if (!next) return { text: tt('tools.noPending', locale) }
    try {
      const filter = next.kind === 'deny' ? { deny: next.names } : { allow: next.names }
      const done = await session.setToolFilter(filter, { commandId: next.commandId })
      pending.delete(session)
      const rows = rowsOf(await session.tools(), locale)
      remember(app, rows)
      const on = rows.filter((row) => row.on).length
      return {
        text: tt('tools.applied', locale, { seq: done.effectiveFromSeq, on, off: rows.length - on }),
        presentation: 'transcript',
      }
    } catch (error) {
      const refusal = refusalText(error, locale)
      if (!refusal) throw error
      pending.delete(session)
      return { text: refusal }
    }
  }
  if (verb === 'deny' || verb === 'only') {
    const names = [
      ...new Set(
        args
          .slice(1)
          .flatMap((word) => word.split(','))
          .filter(Boolean),
      ),
    ]
    if (names.length === 0) return { text: tt('tools.nothing', locale) }
    const rows = rowsOf(await session.tools(), locale)
    remember(app, rows)
    const known = new Set(rows.map((row) => row.name))
    const unknown = names.filter((name) => !known.has(name))
    if (unknown.length > 0) return { text: tt('tools.unknown', locale, { names: unknown.join(', ') }) }
    pending.set(session, { kind: verb, names, commandId: randomUUID() })
    return {
      text: tt(verb === 'deny' ? 'tools.confirmDeny' : 'tools.confirmOnly', locale, {
        names: names.join(', '),
      }),
    }
  }
  if (verb !== undefined && verb !== 'list') return { text: tt('tools.usage', locale) }
  const rows = rowsOf(await session.tools(), locale)
  remember(app, rows)
  if (rows.length === 0) return { text: tt('tools.none', locale) }
  const on = rows.filter((row) => row.on).length
  const width = Math.max(...rows.map((row) => row.name.length))
  return {
    text: [
      tt('tools.header', locale, { on, off: rows.length - on }),
      ...rows.map(
        (row) =>
          `  ${row.name.padEnd(width)}  ${tt(row.on ? 'tools.on' : 'tools.off', locale)}${row.why ? `  ${row.why}` : ''}`,
      ),
    ].join('\n'),
    presentation: 'transcript',
  }
}

/** The refusals a person can act on; anything else (a dropped connection) stays pending for a retry. */
function refusalText(error: unknown, locale: string): string | undefined {
  const e = error as { code?: unknown; data?: { code?: unknown; reason?: unknown; names?: unknown } } | null
  if (e?.code === -32601) return tt('tools.unsupported', locale)
  if (e?.data?.code === 'CAPABILITY_DENIED') return tt('tools.ownerOnly', locale)
  if (e?.data?.code === 'TOOL_FILTER_REJECTED')
    return tt('tools.unknown', locale, {
      names: Array.isArray(e.data.names) ? e.data.names.map(String).join(', ') : '',
    })
  return undefined
}

/**
 * Tab after `/tools deny ` or `/tools only `: the names that are on. The catalog is asynchronous and
 * completion is not, so the first Tab only asks for it and the next one completes.
 */
export function toolNameCandidates(app: TuiApp, token: string, before: string): string[] | undefined {
  if (!/^\/tools\s+(?:deny|only)\s+(?:\S+\s+)*$/.test(before)) return undefined
  const names = onNames.get(app.session)
  if (!names) {
    if (!fetching.has(app.session)) {
      fetching.add(app.session)
      void app.session
        .tools()
        .then((result) => remember(app, rowsOf(result, app.locale)))
        .catch(() => undefined)
        .finally(() => fetching.delete(app.session))
    }
    return []
  }
  return names.filter((name) => name.startsWith(token))
}
