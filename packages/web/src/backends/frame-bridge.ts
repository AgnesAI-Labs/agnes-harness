import { JSONRPC_ERRORS, META_KEY } from '@agnes/protocol'
import { type Client, JsonRpcError } from '@agnes/sdk/browser'
import { homeNavigation } from '@agnes/web-client'
import { broadcast, onBroadcast, onHistoryNavigation } from '../app/global-events.js'
import { requestNewSession } from '../application.js'
import { SESSION_SEARCH_EVENT } from '../regions/session-tools.js'
import { isSettingsRegionRoute } from '../regions/settings-route.js'
import { backendFrame, requestDiagnosticBackend, requestLocalManagement } from './frame-context.js'
import {
  BACKEND_FRAME_MESSAGE,
  type BackendCommand,
  type BackendSessionAction,
  type BackendSnapshot,
  backendCommand,
} from './frame-contract.js'
import { installLocalFrameRouting } from './local-frame-routing.js'
import { isDraftRoute } from './local-route.js'
import { publishSidebarLayout } from './sidebar-projection.js'

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
  openSettings?: (section: string) => void,
): () => void {
  const context = backendFrame()
  if (!context) return () => {}
  const routing = context.remote ? undefined : installLocalFrameRouting(context.parentOrigin)
  let disposed = false
  let ready = false
  let reading = false
  let count = 100
  let promptTitlesDowngraded = false
  let queued: { command: BackendCommand; commandId: string } | undefined
  const completed = new Set<string>()
  let last: BackendSnapshot = { ready: false, connected: false, rows: [], activity: [], more: false }
  const publish = (snapshot: BackendSnapshot) => {
    if (disposed) return
    last = snapshot
    publishSidebarLayout()
    window.parent.postMessage({ type: BACKEND_FRAME_MESSAGE, kind: 'state', snapshot }, context.parentOrigin)
  }
  const refresh = async () => {
    if (disposed || reading || !ready) return
    reading = true
    try {
      const rows: BackendSnapshot['rows'] = []
      const info = await client.initialize()
      if (disposed) return
      const meta = info.capabilities._meta as Record<string, { sessionPromptTitles?: boolean }> | undefined
      let includePromptTitles =
        Boolean(context.remote) && !promptTitlesDowngraded && meta?.[META_KEY]?.sessionPromptTitles === true
      let cursor: string | undefined
      do {
        const params = {
          limit: Math.min(500, count - rows.length),
          ...(cursor ? { cursor } : {}),
        }
        const page = await client.session
          .list({
            ...params,
            ...(includePromptTitles ? { includePromptTitles: true } : {}),
          })
          .catch((error: unknown) => {
            if (
              disposed ||
              !includePromptTitles ||
              !(error instanceof JsonRpcError) ||
              error.code !== JSONRPC_ERRORS.INVALID_PARAMS ||
              error.data.code !== 'UNKNOWN_KEY' ||
              error.data.key !== 'includePromptTitles' ||
              error.data.path !== '/includePromptTitles'
            )
              throw error
            // Read-only compatibility retry; remember the downgrade for subsequent refreshes.
            promptTitlesDowngraded = true
            includePromptTitles = false
            return client.session.list(params)
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
    if (command.kind === 'restore-local-route') {
      routing?.restore(command.route)
    } else if (command.kind === 'session' || command.kind === 'new') {
      if (!context.remote && command.kind === 'session') homeNavigation.close()
      const url = new URL(location.href)
      url.searchParams.delete('view')
      url.searchParams.delete('settings')
      if (context.remote) {
        // The workbench owns cloud conversation history. Clear the old page before running its router.
        for (const key of ['page', 'pagePackage', 'tab', 'account']) url.searchParams.delete(key)
        if (url.hash.startsWith('#settings-subsection-')) url.hash = ''
      }
      if (command.kind === 'session') {
        if (!context.remote && isDraftRoute(url.searchParams)) url.searchParams.delete('workspaceId')
        url.searchParams.delete('new')
        url.searchParams.set('session', command.sessionId)
      } else url.searchParams.delete('session')
      if (context.remote || command.kind === 'new') history.replaceState({}, '', url)
      else history.pushState({}, '', url)
      if (command.kind === 'new') requestNewSession()
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
    } else if (command.kind === 'home') homeNavigation.open(command.page)
    else if (command.kind === 'more') count = Math.min(5000, count + 100)
    void refresh()
  }
  const accept = (entry: { command: BackendCommand; commandId: string }) => {
    if (!ready && entry.command.kind !== 'restore-local-route') {
      queued = entry
      return
    }
    const { command, commandId } = entry
    const acknowledge = () => {
      if (disposed) return
      completed.add(commandId)
      if (completed.size > 256) completed.delete(completed.values().next().value ?? '')
      window.parent.postMessage({ type: BACKEND_FRAME_MESSAGE, kind: 'ack', commandId }, context.parentOrigin)
    }
    if (!completed.has(commandId)) {
      if (command.kind === 'settings' && openSettings) openSettings(command.section)
      else invoke(command)
    }
    acknowledge()
  }
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== backendFrame()?.parentOrigin) return
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
  const diagnosticRoute = (event: Event) => {
    if (isSettingsRegionRoute(event)) return
    if (!requestDiagnosticBackend((event as CustomEvent<unknown>).detail)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  document.addEventListener('agnes:settings-route', diagnosticRoute, true)
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
    routing?.sync()
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
  const layoutObserver = new ResizeObserver(publishSidebarLayout)
  const sidebar = document.querySelector('.sidebar')
  if (sidebar) layoutObserver.observe(sidebar)
  const layoutChanges = new MutationObserver(publishSidebarLayout)
  layoutChanges.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('resize', publishSidebarLayout)
  const timer = setInterval(() => {
    void refresh()
  }, 2000)
  return () => {
    disposed = true
    routing?.dispose()
    layoutObserver.disconnect()
    layoutChanges.disconnect()
    window.removeEventListener('resize', publishSidebarLayout)
    clearInterval(timer)
    queued = undefined
    window.removeEventListener('message', receive)
    homeOff()
    document.removeEventListener('agnes:open-settings', localSettings, true)
    document.removeEventListener('agnes:settings-route', diagnosticRoute, true)
    readyOff()
    noticeOff()
    reconnectingOff()
    closedOff()
    reconnectedOff()
    historyOff()
  }
}
