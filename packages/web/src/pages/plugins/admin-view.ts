import type { UITimeline } from '@agnes/protocol'
import {
  mountPluginAdmin,
  type PluginAdminSources,
  type PluginAdminViewContext,
} from '@agnes/web-admin/admin/plugins/admin'
import { trackPageRequest } from '@agnes/web-ui'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import type { HomePageData } from '../host.js'

export type PluginView = PluginAdminViewContext

/** Where a draft came from, read through the page's own connection. */
export function useCandidateSources(data: HomePageData) {
  return useMemo(
    () => ({
      sessionTitle: async (id: string) =>
        (
          await data.call<{ items: readonly { sessionId: string; title?: string }[] }>(
            '_agnes/v1/session.list',
            { q: { prefix: id }, limit: 100 },
          )
        ).items.find((row) => row.sessionId === id)?.title,
      sessionTurnTime: async (id: string, turn: number) =>
        (
          await data.call<UITimeline>('_agnes/v1/session.projectUI', { sessionId: id, surface: 'web' })
        ).turns.find((row) => row.turn === turn)?.startedAt,
    }),
    [data],
  )
}

/**
 * The plugin controller behind the page. It keeps the inventory, operations and the shared install,
 * confirm and detail dialogs; each state change hands the page a fresh view to draw from.
 */
export function usePluginAdmin(sources: PluginAdminSources): {
  host: RefObject<HTMLDivElement>
  view: PluginView | undefined
} {
  const host = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<PluginView>()
  const latest = useRef(sources)
  latest.current = sources
  useEffect(() => {
    if (!host.current) return
    const target = host.current
    let alive = true
    let mounted: ReturnType<typeof mountPluginAdmin> | undefined
    // The controller commits synchronously; start it after this commit has finished.
    queueMicrotask(() => {
      if (!alive) return
      mounted = mountPluginAdmin({
        ...latest.current,
        surface: {
          host: target,
          render(next) {
            if (alive) setView(next)
            return null
          },
        },
      })
    })
    return () => {
      alive = false
      // Unmounting its regions is a synchronous commit too.
      queueMicrotask(() => mounted?.dispose())
    }
  }, [])
  return { host, view }
}

/**
 * A read the page waits on that does not go through the shared data hook (the controllers read for
 * themselves) still moves the top progress bar, until it settles or the page leaves.
 */
export function usePageProgress(loading: boolean): void {
  useEffect(() => {
    if (!loading) return
    let settle = () => {}
    void trackPageRequest(
      new Promise<void>((resolve) => {
        settle = resolve
      }),
    )
    return () => settle()
  }, [loading])
}
