import { join } from 'node:path'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import {
  HISTORY_DENIED,
  HISTORY_FAILED,
  HISTORY_INVALID_QUERY,
  HISTORY_NARROW,
  HISTORY_NOT_FOUND,
  HISTORY_UNAVAILABLE,
  HISTORY_UNMOUNTED,
  type HistoryAccess,
  type HistoryIndex,
  HistoryIndexError,
  type HistoryItem,
  type HistoryPage,
  type LineageNode,
  openHistoryIndex,
  readLedgerDirectory,
  type StoredEvent,
} from '@agnes/history-index'

let boundDir: string | undefined
let boundIndex: HistoryIndex | undefined

/** Open the index now. Tests use this; the extension binds the directory and opens on first use. */
export function mountSessionQuery(dataDir: string): void {
  closeSessionQuery()
  boundDir = dataDir
  boundIndex = openHistoryIndex(join(dataDir, 'history-index.db'))
}

export function bindSessionQuery(dataDir: string): void {
  closeSessionQuery()
  boundDir = dataDir
}

export function closeSessionQuery(): void {
  boundIndex?.close()
  boundIndex = undefined
  boundDir = undefined
}

function textResult(text: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

function fail(error: unknown): ToolResult {
  if (error instanceof HistoryIndexError) {
    if (error.code === 'DENIED') return textResult(HISTORY_DENIED, true)
    if (error.code === 'NOT_FOUND') return textResult(HISTORY_NOT_FOUND, true)
    if (error.code === 'INVALID_QUERY') return textResult(HISTORY_INVALID_QUERY, true)
    if (error.code === 'UNMOUNTED') return textResult(HISTORY_UNMOUNTED, true)
  }
  return textResult(HISTORY_FAILED, true)
}

function ready(): HistoryIndex {
  const dataDir = boundDir
  if (!dataDir) throw new HistoryIndexError('UNMOUNTED')
  if (!boundIndex) {
    try {
      boundIndex = openHistoryIndex(join(dataDir, 'history-index.db'))
    } catch {
      throw new HistoryIndexError('FAILED')
    }
  }
  try {
    boundIndex.rebuild(readLedgerDirectory(dataDir))
    return boundIndex
  } catch (error) {
    if (error instanceof HistoryIndexError && error.code === 'INVALID_QUERY') throw error
    throw new HistoryIndexError('FAILED')
  }
}

function accessOf(index: HistoryIndex, ctx: ToolContext): Extract<HistoryAccess, { kind: 'caller' }> {
  const rooted = ctx.session.workspaceRoot.trim()
  return {
    kind: 'caller',
    self: ctx.session.key,
    workspace: rooted || ctx.cwd,
    principal: index.principalOf(ctx.session.key),
  }
}

function renderItems(items: HistoryItem[], withSeq: boolean): string {
  return items
    .map((item) => {
      const head =
        withSeq && item.seq !== undefined
          ? `session ${item.sessionId} #${item.seq} ${item.type ?? ''}`
          : `session ${item.sessionId}`
      return `${head}\ntitle: ${item.title}\nworkspace: ${item.workspace}\nmatch: ${item.snippet}`
    })
    .join('\n\n')
}

function renderPage(page: HistoryPage, withSeq: boolean): string {
  if (page.items.length === 0) return 'No matching history.'
  const body = renderItems(page.items, withSeq)
  return page.truncated || page.next ? `${body}\n\n${HISTORY_NARROW}` : body
}

function renderNode(node: LineageNode): string {
  return node.kind === 'unavailable'
    ? HISTORY_UNAVAILABLE
    : `${node.session.sessionId} ${node.session.title}`.trim()
}

function brief(event: StoredEvent): string {
  const text = event.text.length > 160 ? `${event.text.slice(0, 159)}…` : event.text
  return `#${event.seq} ${event.type} ${text}`.trim()
}

function windowCount(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return 0
  return Math.min(value, 20)
}

export function runSessionSearch(query: string, ctx: ToolContext): ToolResult {
  try {
    const index = ready()
    const access = accessOf(index, ctx)
    const page = index.query({
      access,
      kind: 'search',
      query,
      title: '',
      workspace: '',
      sessionId: '',
      omitSelf: true,
      limit: 20,
    })
    return textResult(renderPage(page, false))
  } catch (error) {
    return fail(error)
  }
}

export function runSessionEventSearch(sessionId: string, query: string, ctx: ToolContext): ToolResult {
  try {
    const index = ready()
    const access = accessOf(index, ctx)
    if (sessionId !== access.self && !index.canRead(sessionId, access)) throw new HistoryIndexError('DENIED')
    const page = index.query({
      access,
      kind: 'search',
      query,
      title: '',
      workspace: '',
      sessionId,
      omitSelf: false,
      limit: 20,
    })
    return textResult(renderPage(page, true))
  } catch (error) {
    return fail(error)
  }
}

export function runSessionTrace(sessionId: string, ctx: ToolContext): ToolResult {
  try {
    const index = ready()
    const trace = index.traceSession(accessOf(index, ctx), sessionId)
    const title = trace.session?.title ? ` ${trace.session.title}` : ''
    const lines = [
      `session ${sessionId}${title}`,
      'ancestors:',
      ...(trace.ancestors.length ? trace.ancestors.map((node) => `  ${renderNode(node)}`) : ['  none']),
      'descendants:',
      ...(trace.descendants.length ? trace.descendants.map((node) => `  ${renderNode(node)}`) : ['  none']),
    ]
    if (trace.truncated) lines.push(HISTORY_NARROW)
    return textResult(lines.join('\n'))
  } catch (error) {
    return fail(error)
  }
}

export function runSessionEventTrace(sessionId: string, seq: number, ctx: ToolContext): ToolResult {
  try {
    const index = ready()
    const trace = index.traceEvent(accessOf(index, ctx), sessionId, seq)
    const sources = trace.sources.map((source) =>
      source.kind === 'unavailable' ? `  ${HISTORY_UNAVAILABLE}` : `  ${brief(source.event)}`,
    )
    const cited = trace.citedBy.map((event) => `  ${brief(event)}`)
    return textResult(
      [
        `event ${sessionId} #${trace.event.seq} ${trace.event.type}`,
        'sources:',
        ...(sources.length ? sources : ['  none']),
        'cited by:',
        ...(cited.length ? cited : ['  none']),
      ].join('\n'),
    )
  } catch (error) {
    return fail(error)
  }
}

export function runSessionEventRead(
  sessionId: string,
  seq: number,
  before: number | undefined,
  after: number | undefined,
  ctx: ToolContext,
): ToolResult {
  try {
    const index = ready()
    const read = index.readEvent(
      accessOf(index, ctx),
      sessionId,
      seq,
      windowCount(before),
      windowCount(after),
    )
    const lines = [`event ${read.event.sessionId} #${read.event.seq} ${read.event.type}`, read.event.body]
    if (read.event.truncated) lines.push('[truncated]')
    if (read.before.length) lines.push('before:', ...read.before.map((event) => brief(event)))
    if (read.after.length) lines.push('after:', ...read.after.map((event) => brief(event)))
    return textResult(lines.join('\n'))
  } catch (error) {
    return fail(error)
  }
}
