import type { Client } from '@agnes/sdk/browser'
import { homeNavigation } from '@agnes/web-client'
import { broadcast, onBroadcast, onHistoryNavigation } from '../app/global-events.js'
import { requestNewSession } from '../application.js'
import { SESSION_SEARCH_EVENT } from '../regions/session-tools.js'
import { backendFrame, requestLocalManagement } from './frame-context.js'
import {
  BACKEND_FRAME_MESSAGE,
  type BackendCommand,
  type BackendSessionAction,
  type BackendSnapshot,
  backendCommand,
} from './frame-contract.js'

export function backendFrameStartup(op: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await op()
    } finally {
      broadcast('agnes:backend-frame-ready')
    }
  }
}

/** A projection/command bridge only: all session admission and execution remains in its backend. */
export function installBackendFrameBridge(
  client: Client,
  label?: (id: string) => string | undefined,
  sessionAction?: (action: BackendSessionAction, id: string, title: string, trigger: HTMLElement) => void,
): () => void {
  if (!backendFrame()) return () => {}
  let disposed = false
  let ready = false
  let reading = false
  let count = 100
  let queued: { command: BackendCommand; commandId: string } | undefined
  const completed = new Set<string>()
  let last: BackendSnapshot = { ready: false, connected: false, rows: [], activity: [], more: false }
  const publish = (snapshot: BackendSnapshot) => {
    if (disposed) return
    last = snapshot
    window.parent.postMessage({ type: BACKEND_FRAME_MESSAGE, kind: 'state', snapshot }, location.origin)
  }
  const refresh = async () => {
    if (disposed || reading || !ready) return
    reading = true
    try {
      const rows: BackendSnapshot['rows'] = []
      let cursor: string | undefined
      do {
        const page = await client.session.list({
          limit: Math.min(500, count - rows.length),
          ...(cursor ? { cursor } : {}),
        })
        rows.push(
          ...page.items
            .filter((row) => !row.archived)
            .map((row) => ({
              sessionId: row.sessionId,
              title: row.title || label?.(row.sessionId) || '',
              ...(row.cwd ? { cwd: row.cwd } : {}),
              ...(row.createdAt ? { createdAt: row.createdAt } : {}),
              ...(row.lastMessageAt ? { lastMessageAt: row.lastMessageAt } : {}),
              ...(row.pinnedAt ? { pinnedAt: row.pinnedAt } : {}),
            })),
        )
        if (page.next === cursor && cursor !== undefined) throw new Error('session cursor did not advance')
        cursor = page.next
      } while (cursor && rows.length < count)
      const activity = await client.session.activity()
      const selected = new URL(location.href).searchParams.get('session')
      const home = homeNavigation.getSnapshot()
      publish({
        ready,
        connected: true,
        rows,
        activity: activity.items,
        more: Boolean(cursor) && count < 5000,
        ...(selected ? { selected } : {}),
        ...(home ? { page: home.id } : {}),
      })
    } catch (error) {
      publish({
        ...last,
        ready,
        connected: false,
        error: error instanceof Error ? error.message.slice(0, 4096) : 'unavailable',
      })
    } finally {
      reading = false
    }
  }
  const invoke = (command: BackendCommand) => {
    if (command.kind === 'session') {
      homeNavigation.close()
      const url = new URL(location.href)
      url.searchParams.delete('new')
      url.searchParams.delete('view')
      url.searchParams.delete('settings')
      url.searchParams.set('session', command.sessionId)
      history.pushState({}, '', url)
      window.dispatchEvent(new PopStateEvent('popstate'))
    } else if (command.kind === 'new') {
      const url = new URL(location.href)
      url.searchParams.delete('session')
      url.searchParams.delete('view')
      url.searchParams.delete('settings')
      history.replaceState({}, '', url)
      requestNewSession()
      window.dispatchEvent(new PopStateEvent('popstate'))
    } else if (command.kind === 'search') {
      document.dispatchEvent(new CustomEvent(SESSION_SEARCH_EVENT))
    } else if (command.kind === 'workspace') {
      document.getElementById('workspace-add')?.click()
    } else if (command.kind === 'session-action') {
      sessionAction?.(
        command.action,
        command.sessionId,
        command.title,
        document.getElementById('prompt') ?? document.body,
      )
    } else if (command.kind === 'settings') {
      document.dispatchEvent(new CustomEvent('agnes:open-settings', { detail: { section: command.section } }))
    } else if (command.kind === 'home') homeNavigation.open(command.page)
    else if (command.kind === 'more') count = Math.min(5000, count + 100)
    void refresh()
  }
  const accept = (entry: { command: BackendCommand; commandId: string }) => {
    if (!ready) {
      queued = entry
      return
    }
    if (!completed.has(entry.commandId)) {
      invoke(entry.command)
      completed.add(entry.commandId)
      if (completed.size > 256) completed.delete(completed.values().next().value ?? '')
    }
    window.parent.postMessage(
      { type: BACKEND_FRAME_MESSAGE, kind: 'ack', commandId: entry.commandId },
      location.origin,
    )
  }
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== location.origin) return
    const command = backendCommand(event.data)
    if (command && typeof event.data.commandId === 'string' && event.data.commandId.length <= 128)
      accept({ command, commandId: event.data.commandId })
  }
  window.addEventListener('message', receive)
  const homeOff = homeNavigation.subscribe(() => {
    const page = homeNavigation.getSnapshot()?.id
    if (
      page &&
      ['plugins', 'agents', 'automation', 'mhs'].includes(page) &&
      requestLocalManagement({
        kind: 'home',
        page: page as Extract<BackendCommand, { kind: 'home' }>['page'],
      })
    )
      homeNavigation.close()
  })
  const localSettings = (event: Event) => {
    const section = (event as CustomEvent<{ section?: unknown }>).detail?.section
    if (
      typeof section !== 'string' ||
      !section ||
      section.length > 128 ||
      !requestLocalManagement({ kind: 'settings', section })
    )
      return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  document.addEventListener('agnes:open-settings', localSettings, true)

  const readyOff = onBroadcast('agnes:backend-frame-ready', () => {
    ready = true
    const command = queued
    queued = undefined
    if (command) accept(command)
    void refresh()
  })
  const noticeOff = client.on('notice', () => {
    void refresh()
  })
  const offline = () => publish({ ...last, connected: false })
  const reconnectingOff = client.on('reconnecting', offline)
  const closedOff = client.on('closed', offline)
  const reconnectedOff = client.on('reconnected', () => {
    void refresh()
  })
  const historyOff = onHistoryNavigation(() => {
    void refresh()
  })
  const timer = setInterval(() => {
    void refresh()
  }, 2000)
  return () => {
    disposed = true
    clearInterval(timer)
    queued = undefined
    window.removeEventListener('message', receive)
    homeOff()
    document.removeEventListener('agnes:open-settings', localSettings, true)
    readyOff()
    noticeOff()
    reconnectingOff()
    closedOff()
    reconnectedOff()
    historyOff()
  }
}
