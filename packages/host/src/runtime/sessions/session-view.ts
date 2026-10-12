import { boundedTimelinePage, type Event, projectUI, turnsForNodes } from '@agnes/core'
import {
  type SessionVersionIssue,
  type SessionViewNotice,
  type SessionViewResult,
  sessionVersionNotice,
} from '@agnes/protocol'
import { classifyGenerationFailure } from '../generation/seam-pins.js'

const PAGE = 500
const MAX_BYTES = 8 * 1024 * 1024

export type SessionRowsReader = (
  sessionKey: string,
  query: { fromSeq?: number; toSeq?: number; limit: number },
) => Promise<Event[]>

/**
 * One session's recorded conversation, projected from its rows alone. Nothing here opens the
 * session, restores a generation or pin, takes a lock or writes: a session this build cannot
 * continue is still read. Rows are decoded page by page; when a page cannot be decoded, the rows
 * before it are kept and the failure is reported as a notice instead of guessing what follows.
 */
export async function readSessionView(
  read: SessionRowsReader,
  sessionKey: string,
  options: { maxNodes?: number } = {},
): Promise<SessionViewResult> {
  const events: Event[] = []
  let issue: SessionVersionIssue | undefined
  let reason: string | undefined
  for (let fromSeq = 1; ; ) {
    let page: Event[]
    try {
      page = await read(sessionKey, { fromSeq, limit: PAGE })
    } catch (error) {
      issue = classifyGenerationFailure(error)
      if (!issue) throw error
      reason = (error instanceof Error ? error.message : String(error)).match(/E_[A-Z0-9_]+/)?.[0]
      break
    }
    if (page.length === 0) break
    for (const event of page) {
      // A gap would silently drop history; what follows it is not trusted.
      if (event.seq !== fromSeq) {
        issue = 'corrupt'
        reason = 'E_FORMAT_CORRUPT'
        break
      }
      events.push(event)
      fromSeq += 1
    }
    if (issue) break
  }
  const lastSeq = events.at(-1)?.seq ?? 0
  const full = await projectUI(events, { sessionKey, surface: 'web' })
  // Nothing is running behind a read: no busy state, no approval to answer.
  const nodes = full.nodes.filter((node) => node.kind !== 'approval' || node.state !== 'pending')
  const page = boundedTimelinePage(nodes, nodes.length, options.maxNodes ?? 200, MAX_BYTES)
  const notice: SessionViewNotice | undefined = issue ? noticeFor(issue, sessionKey, reason) : undefined
  return {
    sessionId: sessionKey,
    readOnly: true,
    lastSeq,
    timeline: {
      sessionId: sessionKey,
      upto: lastSeq,
      generation: 1,
      opState: null,
      nodes: page.nodes,
      turns: turnsForNodes(full.turns, page.nodes, false),
      ...(full.usage ? { usage: full.usage } : {}),
    },
    history: { hasEarlier: page.hasEarlier, startIndex: page.startIndex, totalNodes: page.totalNodes },
    ...(notice ? { notice } : {}),
  }
}

function noticeFor(issue: SessionVersionIssue, sessionId: string, reason?: string): SessionViewNotice {
  const notice = sessionVersionNotice(issue, { sessionId, ...(reason ? { reason } : {}) })
  return { code: notice.code, issue, actions: [...notice.actions], localized: notice.message }
}
