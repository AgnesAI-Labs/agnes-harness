import type { Handler, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { MetaState } from '@agnes/daemon-foundation/local/meta'
import { notify } from '@agnes/daemon-foundation/rpc'
import { type EventEnvelope, rpcError } from '@agnes/protocol'
import { waitForHistoryOpen } from './history-open.js'
import type { Feed, LocalContext } from './methods/acp.js'
import type { SessionEntry } from './sessions.js'

/** ACP replay and window-based clients share exactly one execution admission path. */
export function registerSessionLoading(
  ep: LocalEndpoint,
  cx: LocalContext,
  feedFor: (entry: SessionEntry, replay?: boolean) => Feed,
  requireOwner: (method: string, sessionId: string) => void,
  throwSessionOpenRpcError: (error: unknown, sessionId: string) => never,
): void {
  const loading = new Map<string, Set<AbortController>>()
  const loadingIds = new WeakMap<AbortController, string>()
  ep.register('_agnes/v1/session.loadingCancel', async (params) => {
    const { sessionId, requestId } = params as { sessionId: string; requestId?: string }
    requireOwner('session.loadingCancel', sessionId)
    for (const controller of loading.get(sessionId) ?? [])
      if (requestId === undefined || loadingIds.get(controller) === requestId)
        controller.abort(new Error('session loading cancelled'))
    return {}
  })

  const loadSession =
    (replay: boolean): Handler =>
    async (params, call) => {
      const p = params as {
        sessionId: string
        cwd?: string
        additionalDirectories?: string[]
        requestId?: string
      }
      requireOwner(replay ? 'session/load' : 'session.open', p.sessionId)
      const controller = new AbortController()
      if (p.requestId !== undefined) loadingIds.set(controller, p.requestId)
      const signal = AbortSignal.any([call.signal, controller.signal])
      const pending = loading.get(p.sessionId) ?? new Set<AbortController>()
      pending.add(controller)
      loading.set(p.sessionId, pending)
      try {
        signal.throwIfAborted()
        // A cold open can spend its whole idle budget starting a worker before any ledger progress
        // exists; announce the request now so the client resets its idle clock instead of timing out.
        if (!signal.aborted)
          ep.push(
            notify('_agnes/v1/session.loading', {
              sessionId: p.sessionId,
              phase: 'verifying',
              verifiedSeq: 0,
              lastSeq: 0,
            }),
          )
        let entry = cx.registry.get(p.sessionId)
        const wasOpen = entry !== undefined
        try {
          const binding = await cx.workspaces.restoreBinding(
            p.sessionId,
            p.cwd || undefined,
            p.additionalDirectories,
          )
          // Calling open for a live entry is intentional: both registries must reject a different
          // authority binding rather than ignoring it until the next restart.
          const onProgress = (progress: { verifiedSeq: number; lastSeq: number }) => {
            if (!signal.aborted)
              ep.push(
                notify('_agnes/v1/session.loading', {
                  sessionId: p.sessionId,
                  phase: 'verifying',
                  ...progress,
                }),
              )
          }
          entry = await waitForHistoryOpen(
            cx.registry,
            p.sessionId,
            signal,
            onProgress,
            (onHistoryProgress, historySignal) =>
              cx.registry.open({
                key: p.sessionId,
                cwd: binding.canonicalRoot,
                binding,
                resume: true,
                historySignal,
                onHistoryProgress,
              } as Parameters<typeof cx.registry.open>[0]),
          )
        } catch (error) {
          throwSessionOpenRpcError(error, p.sessionId)
        }
        if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId: p.sessionId })
        // restoreBinding, the worker handshake and the ledger open are silent until they return;
        // announce the opened ledger so that startup window cannot exhaust the client's budget.
        if (!signal.aborted)
          ep.push(
            notify('_agnes/v1/session.loading', {
              sessionId: p.sessionId,
              phase: 'verifying',
              verifiedSeq: entry.session.lastSeq,
              lastSeq: entry.session.lastSeq,
            }),
          )
        try {
          if (wasOpen)
            await entry.session.verifyHistory({
              signal,
              onProgress: (progress) => {
                if (!signal.aborted)
                  ep.push(
                    notify('_agnes/v1/session.loading', {
                      sessionId: p.sessionId,
                      phase: 'verifying',
                      ...progress,
                    }),
                  )
              },
            })
        } catch (error) {
          throwSessionOpenRpcError(error, p.sessionId)
        }
        signal.throwIfAborted()
        const feed = feedFor(entry, replay)
        if (!replay) return {}
        // Paged and bounded: core refuses an unbounded scan (E_SCAN_UNBOUNDED), and a single page would
        // silently truncate a long transcript at whatever limit was written here.
        const lastSeq = entry.session.lastSeq
        let replayMeta: MetaState | undefined
        for (let from = 1; from <= lastSeq; from += 500) {
          if (signal.aborted) throw new Error('session load disconnected')
          replayMeta = feed.replayLoad(
            (await entry.session.scan({
              fromSeq: from,
              toSeq: Math.min(lastSeq, from + 499),
              limit: 500,
            })) as EventEnvelope[],
            replayMeta,
          )
          ep.push(
            notify('_agnes/v1/session.loading', {
              sessionId: p.sessionId,
              phase: 'replaying',
              verifiedSeq: Math.min(lastSeq, from + 499),
              lastSeq,
            }),
          )
        }
        // Whatever is streaming now is not in the transcript yet; the snapshot says it.
        feed.previewResync()
        return {}
      } finally {
        pending.delete(controller)
        if (!pending.size) loading.delete(p.sessionId)
      }
    }
  ep.register('session/load', loadSession(true))
  ep.register('_agnes/v1/session.open', loadSession(false))
}
