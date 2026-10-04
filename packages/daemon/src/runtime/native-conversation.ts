import { UI_HISTORY_MAX_LIMIT, UI_OPENING_MAX_NODES, UI_PROJECTION_DEFAULT_MAX_BYTES } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  type AgnesContext,
  historyWindow,
  openingWindow,
  requireSessionOwner,
  uiHistoryInfo,
} from '../local/methods/agnes.js'
import { fail } from './events/outbox.js'

const BYTES = UI_PROJECTION_DEFAULT_MAX_BYTES
// The refusals of the existing session reads that a projection reader may see, as runtime refusals.
const REFUSALS = new Map<string, Parameters<typeof fail>>([
  ['SESSION_NOT_FOUND', ['not_found', 'no such open session', 'native-conversation']],
  ['CAPABILITY_DENIED', ['permission_denied', 'caller does not own this session', 'native-conversation']],
  ['CURSOR_OUT_OF_RANGE', ['resync_required', 'native history moved', 'native-conversation']],
])

/**
 * The native conversation window for the default projection provider, read as the
 * `session.projectUIOpening` and `session.projectUIHistory` methods read it: from the session open in
 * the daemon registry, for the session's owner only (the caller's `principalRef` is its principal id),
 * within the same node and byte bounds. An older page is read at the live head's cut. Same shape as
 * the core NativeConversation port; this package does not depend on core, so they meet at assembly.
 */
export function nativeConversation(cx: Pick<AgnesContext, 'sessionOwnership' | 'registry' | 'workspaces'>) {
  const requireOwner = requireSessionOwner(cx)
  return {
    // ponytail: a session that is not open has no head, so an event folded while it is closed anchors
    // before its whole native history; recording the native seq with the event would fix that.
    head(sessionId: string) {
      const entry = cx.registry.get(sessionId)
      return { generation: entry?.generation ?? 0, upto: entry?.session.lastSeq ?? 0 }
    },

    /** The newest `limit` nodes before `beforeIndex`, or the live tail when it is null. */
    async page(
      sessionId: string,
      beforeIndex: number | null,
      limit: number,
      context: Readonly<{ principalRef: string }>,
    ): Promise<{ ok: true; value: Wire.UIOpeningResult } | ReturnType<typeof fail>> {
      try {
        requireOwner('session.projectUIOpening', sessionId, { conn: { principalId: context.principalRef } })
        const entry = cx.registry.require(sessionId)
        const tail = beforeIndex === null ? Math.min(Math.max(limit, 1), UI_OPENING_MAX_NODES) : 1
        const live = await openingWindow(entry, sessionId, undefined, tail, BYTES)
        if (beforeIndex === null && limit > 0) return { ok: true, value: live }
        // An older page, or an empty one, keeps the live header and is read at its cut.
        const { timeline, history } = live
        const { generation, upto: cut } = timeline
        const at = { sessionId, generation, surface: null, cut, totalNodes: history.totalNodes }
        const before = { ...at, beforeIndex: beforeIndex ?? at.totalNodes }
        const older =
          limit > 0
            ? await historyWindow(entry, before, Math.min(limit, UI_HISTORY_MAX_LIMIT), BYTES)
            : { nodes: [], turns: [], startIndex: before.beforeIndex }
        const page = { ...timeline, nodes: older.nodes, turns: older.turns }
        return { ok: true, value: { timeline: page, history: uiHistoryInfo(at, older.startIndex) } }
      } catch (error) {
        const refusal = REFUSALS.get((error as { message?: string } | null)?.message ?? '')
        if (!refusal) throw error
        return fail(...refusal)
      }
    },
  }
}
