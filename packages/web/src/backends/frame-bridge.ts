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
import { isDraftRoute, localWorkbenchRoute } from './local-route.js'
import {
  localLocationUrl,
  publishLocalBackendSnapshot,
  rawHistoryOps,
  readCurrentLocalRoute,
  registerLocalCommandExecutor,
  withLocalRouteRestore,
} from './local-workbench-bus.js'

const CLOUD_RECONCILE_INTERVAL_MS = 15_000

export function backendFrameStartup(op: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await op()
    } finally {
      broadcast('agnes:backend-frame-ready')
    }
  }
}

function executeRuntimeCommand(
  command: BackendCommand,
  remote: boolean,
  sessionAction?: (action: BackendSessionAction, id: string, title: string, trigger: HTMLElement) => void,
  openSettings?: (section: string) => void,
  onMore?: () => void,
): void {
  if (command.kind === 'settings' && openSettings) {
    openSettings(command.section)
    return
  }
  if (command.kind === 'restore-local-route') {
    if (remote) return
    const route = localWorkbenchRoute(command.route)
    if (!route) return
    const current = localWorkbenchRoute(`/${location.search}${location.hash}`)
    if (route !== current) rawHistoryOps().replace(history.state, '', route)
    withLocalRouteRestore(() => window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })))
    return
  }
  if (command.kind === 'session' || command.kind === 'new') {
    if (!remote && command.kind === 'session') homeNavigation.close()
    const url = remote ? new URL(location.href) : localLocationUrl()
    url.searchParams.delete('view')
    url.searchParams.delete('settings')
    if (remote) {
      for (const key of ['page', 'pagePackage', 'tab', 'account']) url.searchParams.delete(key)
      if (url.hash.startsWith('#settings-subsection-')) url.hash = ''
    }
    if (command.kind === 'session') {
      if (!remote && isDraftRoute(url.searchParams)) url.searchParams.delete('workspaceId')
      url.searchParams.delete('new')
      url.searchParams.set('session', command.sessionId)
    } else url.searchParams.delete('session')
    if (remote || command.kind === 'new') history.replaceState(history.state, '', url)
    else history.pushState(history.state, '', url)
    if (command.kind === 'new') requestNewSession()
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
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
  } else if (command.kind === 'home') {
    homeNavigation.open(command.page)
  } else if (command.kind === 'more') {
    onMore?.()
  }
}

function installNativeLocalBridge(
  sessionAction?: (action: BackendSessionAction, id: string, title: string, trigger: HTMLElement) => void,
  openSettings?: (section: string) => void,
): () => void {
  let ready = false
  const snapshot = (): BackendSnapshot => {
    const source = new URL(
      location.search.includes('remote=') ? readCurrentLocalRoute() : location.href,
      location.origin,
    )
    const selected = source.searchParams.get('session')
    const home = homeNavigation.getSnapshot()
    return {
      ready,
      connected: true,
      rows: [],
      activity: [],
      more: false,
      ...(selected ? { selected } : {}),
      ...(home ? { page: home.id } : {}),
    }
  }
  const publish = () => publishLocalBackendSnapshot(snapshot())
  const diagnosticRoute = (event: Event) => {
    if (isSettingsRegionRoute(event)) return
    if (!requestDiagnosticBackend((event as CustomEvent<unknown>).detail)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  document.addEventListener('agnes:settings-route', diagnosticRoute, true)
  const unregisterExecutor = registerLocalCommandExecutor((command) => {
    executeRuntimeCommand(command, false, sessionAction, openSettings)
    publish()
  })
  const readyOff = onBroadcast('agnes:backend-frame-ready', () => {
    ready = true
    publish()
  })
  const historyOff = onHistoryNavigation(publish)
  const homeOff = homeNavigation.subscribe(publish)
  return () => {
    document.removeEventListener('agnes:settings-route', diagnosticRoute, true)
    unregisterExecutor()
    readyOff()
    historyOff()
    homeOff()
  }
}

/**
 * Top-level Local A registers in-process without polling or postMessage; isolated Cloud B frames bridge
 * state and commands to A over origin-verified postMessage with cached capability negotiation.
 */
export function installBackendFrameBridge(
  client: Client,
  label?: (id: string) => string | undefined,
  sessionAction?: (action: BackendSessionAction, id: string, title: string, trigger: HTMLElement) => void,
  openSettings?: (section: string) => void,
): () => void {
  const context = backendFrame()
  if (!context) return installNativeLocalBridge(sessionAction, openSettings)
  let disposed = false
  let ready = false
  let reading = false
  let count = 100
  let promptTitlesDowngraded = false
  let initPromise: ReturnType<Client['initialize']> | undefined
  let queued: { command: BackendCommand; commandId: string } | undefined
  const completed = new Set<string>()
  let last: BackendSnapshot = { ready: false, connected: false, rows: [], activity: [], more: false }
  const publish = (snapshot: BackendSnapshot) => {
    if (disposed) return
    last = snapshot
    window.parent.postMessage({ type: BACKEND_FRAME_MESSAGE, kind: 'state', snapshot }, context.parentOrigin)
  }
  const refresh = async () => {
    if (disposed || reading || !ready) return
    reading = true
    try {
      const rows: BackendSnapshot['rows'] = []
      initPromise ??= client.initialize().catch((error: unknown) => {
        initPromise = undefined
        throw error
      })
      const info = await initPromise
      if (disposed) return
      const meta = info.capabilities._meta as Record<string, { sessionPromptTitles?: boolean }> | undefined
      let includePromptTitles = !promptTitlesDowngraded && meta?.[META_KEY]?.sessionPromptTitles === true
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
  const accept = (entry: { command: BackendCommand; commandId: string }) => {
    if (!ready) {
      queued = entry
      return
    }
    const { command, commandId } = entry
    if (!completed.has(commandId)) {
      executeRuntimeCommand(command, true, sessionAction, openSettings, () => {
        count = Math.min(5000, count + 100)
      })
      void refresh()
    }
    if (!disposed) {
      completed.add(commandId)
      if (completed.size > 256) completed.delete(completed.values().next().value ?? '')
      window.parent.postMessage({ type: BACKEND_FRAME_MESSAGE, kind: 'ack', commandId }, context.parentOrigin)
    }
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
  const offline = () => {
    initPromise = undefined
    publish({ ...last, connected: false })
  }
  const reconnectingOff = client.on('reconnecting', offline)
  const closedOff = client.on('closed', offline)
  const reconnectedOff = client.on('reconnected', () => {
    initPromise = undefined
    void refresh()
  })
  const historyOff = onHistoryNavigation(() => {
    void refresh()
  })
  const timer = setInterval(() => {
    if (!document.hidden) void refresh()
  }, CLOUD_RECONCILE_INTERVAL_MS)
  return () => {
    disposed = true
    clearInterval(timer)
    queued = undefined
    window.removeEventListener('message', receive)
    document.removeEventListener('agnes:open-settings', localSettings, true)
    homeOff()
    readyOff()
    noticeOff()
    reconnectingOff()
    closedOff()
    reconnectedOff()
    historyOff()
  }
}
