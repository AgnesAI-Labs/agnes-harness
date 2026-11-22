import { remoteFrontendOrigin } from '@agnes/protocol'
import { cloudCredentialUsage } from '@agnes/resource-control-web/credentials-api'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import {
  CLOUD_CREDENTIAL_STORAGE_PREFIX,
  readCloudCredentialRef,
  subscribeCloudCredentialReplacement,
} from './cloud-key.js'
import type { CloudConnectionAction } from './cloud-settings-bridge.js'
import {
  BACKEND_FRAME_COMMAND,
  BACKEND_FRAME_MESSAGE,
  type BackendCommand,
  type BackendId,
  type BackendSnapshot,
  backendSnapshot,
  commandBackend,
  localManagementCommand,
} from './frame-contract.js'
import { localWorkbenchRoute } from './local-route.js'
import {
  CLOUD_ORIGIN_KEY,
  type CloudConnectionState,
  initialWorkbench,
  workbenchAddress,
} from './workbench-state.js'

export type SidebarProjection = {
  active: BackendId
  cloud?: string
  states: Partial<Record<BackendId, BackendSnapshot>>
}

export type WorkbenchBootSnapshot = {
  initial: ReturnType<typeof initialWorkbench>
  initialSearch: string
  initialHash: string
  localRoute: string
  cloudHref?: string
}

type WorkbenchControllerHandlers = {
  select(backend: BackendId, options?: { keepSidebar?: boolean }): void
  command(backend: BackendId, command: BackendCommand): void
  cloudAction(action: CloudConnectionAction): void
  routeDiagnostics(section: string): boolean
  localSnapshot(snapshot: BackendSnapshot): void
}

type WorkbenchBusState = {
  localWorkbenchHost: boolean
  pendingCloudBoot: boolean
  restoringLocalRoute: boolean
  bootSnapshot?: WorkbenchBootSnapshot | undefined
  activeRawHistory?: { push: History['pushState']; replace: History['replaceState'] } | undefined
  currentLocalRoute: string
  projectionValue?: SidebarProjection | undefined
  projectionListeners: Set<() => void>
  cloudSettingsValue: CloudConnectionState
  cloudSettingsListeners: Set<() => void>
  controllerHandlers?: WorkbenchControllerHandlers | undefined
  pendingLocalSnapshot?: BackendSnapshot | undefined
  localCommandExecutor?: ((command: BackendCommand) => void) | undefined
  queuedLocalCommand?: BackendCommand | undefined
}

const BUS_KEY = Symbol.for('agnes.web.localWorkbenchBus')

/**
 * `/app.js`, `/vendor/presentation-renderers.js` and lazy settings chunks run in the same `window`
 * as separate ESM bundles; anchor the coordinator state on `globalThis` so all bundles observe one bus.
 */
function bus(): WorkbenchBusState {
  const host = globalThis as unknown as Record<symbol, WorkbenchBusState | undefined>
  let current = host[BUS_KEY]
  if (!current) {
    current = {
      localWorkbenchHost: false,
      pendingCloudBoot: false,
      restoringLocalRoute: false,
      currentLocalRoute: '/',
      projectionListeners: new Set(),
      cloudSettingsValue: { status: 'unconfigured' },
      cloudSettingsListeners: new Set(),
    }
    host[BUS_KEY] = current
  }
  return current
}

export function isLocalWorkbenchHost(): boolean {
  return bus().localWorkbenchHost
}

export function setLocalWorkbenchHost(active: boolean): void {
  bus().localWorkbenchHost = active
}

export function isRestoringLocalRoute(): boolean {
  return bus().restoringLocalRoute
}

export function withLocalRouteRestore(work: () => void): void {
  const state = bus()
  state.restoringLocalRoute = true
  try {
    work()
  } finally {
    state.restoringLocalRoute = false
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function setActiveRawHistory(
  ops: { push: History['pushState']; replace: History['replaceState'] } | undefined,
): void {
  bus().activeRawHistory = ops
}

export function rawHistoryOps(): { push: History['pushState']; replace: History['replaceState'] } {
  return (
    bus().activeRawHistory ?? {
      push: (state, unused, url) => history.pushState(state, unused, url),
      replace: (state, unused, url) => history.replaceState(state, unused, url),
    }
  )
}

export function applyWorkbenchAddress(
  backend: BackendId,
  cloud: string | undefined,
  localRoute: string,
  sessionId?: string,
  push = false,
): void {
  const { push: rawPush, replace: rawReplace } = rawHistoryOps()
  const href = backend === 'local' || !cloud ? localRoute : workbenchAddress(backend, cloud, sessionId)
  const state = { ...(isRecord(history.state) ? history.state : {}), aghLocalRoute: localRoute }
  if (`${location.pathname}${location.search}${location.hash}` === href) {
    rawReplace(state, '')
    return
  }
  if (push) rawPush(state, '', href)
  else rawReplace(state, '', href)
}

/**
 * Capture initial workbench URL before `app.ts` evaluates so a reload on `/?remote=...&session=cloud-x`
 * initializes Local `A` against its saved `aghLocalRoute` rather than mistaking `cloud-x` for a local session.
 */
export function prepareLocalWorkbenchBoot(): WorkbenchBootSnapshot {
  const state = bus()
  state.localWorkbenchHost = true
  const { replace } = rawHistoryOps()
  const initialSearch = location.search
  const initialHash = location.hash
  const initial = initialWorkbench(initialSearch, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY))
  const localRoute =
    localWorkbenchRoute(
      initial.active === 'local' ? `/${initialSearch}${initialHash}` : history.state?.aghLocalRoute,
    ) || '/'
  state.currentLocalRoute = localRoute
  if (initial.active === 'cloud') {
    const cloudHref = `${location.pathname}${initialSearch}${initialHash}`
    state.pendingCloudBoot = true
    state.bootSnapshot = { initial, initialSearch, initialHash, localRoute, cloudHref }
    replace({ ...(isRecord(history.state) ? history.state : {}), aghLocalRoute: localRoute }, '', localRoute)
    return state.bootSnapshot
  }
  state.pendingCloudBoot = false
  state.bootSnapshot = { initial, initialSearch, initialHash, localRoute }
  return state.bootSnapshot
}

export function hasPendingCloudBoot(): boolean {
  return bus().pendingCloudBoot
}

export function restoreInitialCloudLocation(boot?: WorkbenchBootSnapshot): void {
  const state = bus()
  const snapshot = boot ?? state.bootSnapshot
  state.bootSnapshot = undefined
  const { replace } = rawHistoryOps()
  try {
    if (snapshot?.cloudHref) {
      replace(
        { ...(isRecord(history.state) ? history.state : {}), aghLocalRoute: snapshot.localRoute },
        '',
        snapshot.cloudHref,
      )
      return
    }
    if (!new URLSearchParams(location.search).has('remote') && location.pathname === '/') {
      const canonical = localWorkbenchRoute(`/${location.search}${location.hash}`)
      if (canonical && canonical !== `${location.pathname}${location.search}${location.hash}`)
        replace(
          { ...(isRecord(history.state) ? history.state : {}), aghLocalRoute: canonical },
          '',
          canonical,
        )
    }
  } finally {
    state.pendingCloudBoot = false
  }
}

export function consumeWorkbenchBoot(): WorkbenchBootSnapshot {
  const state = bus()
  if (state.bootSnapshot) {
    const current = state.bootSnapshot
    if (!state.pendingCloudBoot) state.bootSnapshot = undefined
    return current
  }
  const initialSearch = location.search
  const initialHash = location.hash
  const initial = initialWorkbench(initialSearch, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY))
  const localRoute =
    localWorkbenchRoute(
      initial.active === 'local' ? `/${initialSearch}${initialHash}` : history.state?.aghLocalRoute,
    ) || '/'
  return { initial, initialSearch, initialHash, localRoute }
}

export function setCurrentLocalRoute(route: string): void {
  bus().currentLocalRoute = route
}
export function readCurrentLocalRoute(): string {
  return bus().currentLocalRoute
}

/** Local startup reads the saved local route while the Cloud view owns `window.location`. */
export function localStartupSearchParams(): URLSearchParams {
  if (isLocalWorkbenchHost() && new URLSearchParams(location.search).has('remote'))
    return new URL(bus().currentLocalRoute, location.origin).searchParams
  return new URLSearchParams(location.search)
}

/** Resolve the current Local A URL without inheriting Cloud B `?remote`/`?session` parameters. */
export function localLocationUrl(): URL {
  if (isLocalWorkbenchHost() && new URLSearchParams(location.search).has('remote'))
    return new URL(bus().currentLocalRoute, location.origin)
  return new URL(location.href)
}

export const localSidebarProjection = {
  read: () => bus().projectionValue,
  subscribe(listener: () => void) {
    const { projectionListeners } = bus()
    projectionListeners.add(listener)
    return () => projectionListeners.delete(listener)
  },
  publish(next: SidebarProjection | undefined) {
    const state = bus()
    state.projectionValue = next
    for (const listener of state.projectionListeners) listener()
  },
}

export const localCloudSettings = {
  read: () => bus().cloudSettingsValue,
  subscribe(listener: () => void) {
    const { cloudSettingsListeners } = bus()
    cloudSettingsListeners.add(listener)
    return () => cloudSettingsListeners.delete(listener)
  },
  publish(next: CloudConnectionState) {
    const state = bus()
    const origin = next.origin === undefined ? undefined : remoteFrontendOrigin(next.origin)
    if (['ready', 'disconnected'].includes(next.status) && !origin) return
    state.cloudSettingsValue = {
      status: next.status,
      ...(origin ? { origin } : {}),
      ...(next.error ? { error: next.error } : {}),
      ...(next.credentialRef ? { credentialRef: next.credentialRef } : {}),
      ...(next.credentialOptions
        ? {
            credentialOptions: next.credentialOptions.map((item) => ({
              id: item.id,
              label: item.label,
            })),
          }
        : {}),
      ...(typeof next.credentialError === 'boolean' ? { credentialError: next.credentialError } : {}),
    }
    cloudCredentialUsage.set(state.cloudSettingsValue.credentialRef)
    for (const listener of state.cloudSettingsListeners) listener()
  },
  reset() {
    const state = bus()
    state.cloudSettingsValue = { status: 'unconfigured' }
    cloudCredentialUsage.set(undefined)
    for (const listener of state.cloudSettingsListeners) listener()
  },
}

export function registerWorkbenchController(handlers: WorkbenchControllerHandlers): () => void {
  const state = bus()
  state.controllerHandlers = handlers
  if (state.pendingLocalSnapshot) handlers.localSnapshot(state.pendingLocalSnapshot)
  return () => {
    if (state.controllerHandlers === handlers) state.controllerHandlers = undefined
  }
}

export function publishLocalBackendSnapshot(snapshot: BackendSnapshot): void {
  const state = bus()
  state.pendingLocalSnapshot = snapshot
  state.controllerHandlers?.localSnapshot(snapshot)
  if (snapshot.ready && state.queuedLocalCommand && state.localCommandExecutor) {
    const next = state.queuedLocalCommand
    state.queuedLocalCommand = undefined
    state.localCommandExecutor(next)
  }
}

export function registerLocalCommandExecutor(executor: (command: BackendCommand) => void): () => void {
  const state = bus()
  state.localCommandExecutor = executor
  if (state.pendingLocalSnapshot?.ready && state.queuedLocalCommand) {
    const next = state.queuedLocalCommand
    state.queuedLocalCommand = undefined
    executor(next)
  }
  return () => {
    if (state.localCommandExecutor === executor) state.localCommandExecutor = undefined
  }
}

export function executeLocalBackendCommand(command: BackendCommand): void {
  const state = bus()
  if (
    !state.localCommandExecutor ||
    (!state.pendingLocalSnapshot?.ready && command.kind !== 'restore-local-route')
  ) {
    state.queuedLocalCommand = command
    return
  }
  state.localCommandExecutor(command)
}

export function dispatchWorkbenchSelect(backend: BackendId, options?: { keepSidebar?: boolean }): void {
  bus().controllerHandlers?.select(backend, options)
}

export function dispatchWorkbenchCommand(backend: BackendId, command: BackendCommand): void {
  bus().controllerHandlers?.command(backend, command)
}

export function dispatchWorkbenchCloudAction(action: CloudConnectionAction): void {
  bus().controllerHandlers?.cloudAction(action)
}

export function dispatchDiagnosticBackendRoute(section: string): boolean {
  return bus().controllerHandlers?.routeDiagnostics(section) === true
}

export function installWorkbenchHistory(options: {
  suspending(): boolean
  diagnosticsCloud(): boolean
  cloudActive(): boolean
  localRoute: { current: string }
  coalesceNextPush: { current: boolean }
  onCloudDiagnostics(section: string): void
}): () => void {
  const originalPush = history.pushState
  const originalReplace = history.replaceState
  const rawPush: History['pushState'] = (state, unused, url) => originalPush.call(history, state, unused, url)
  const rawReplace: History['replaceState'] = (state, unused, url) =>
    originalReplace.call(history, state, unused, url)
  setActiveRawHistory({ push: rawPush, replace: rawReplace })
  const applyLocalHistory = (
    operation: 'push' | 'replace',
    state: unknown,
    unused: string,
    url?: string | URL | null,
  ) => {
    if (options.suspending()) return
    const next = url == null ? new URL(location.href) : new URL(String(url), location.href)
    if (next.origin !== location.origin) {
      if (operation === 'push') rawPush(state, unused, url)
      else rawReplace(state, unused, url)
      return
    }
    const route = localWorkbenchRoute(`/${next.search}${next.hash}`)
    const section = next.searchParams.get('settings')
    if (!hasPendingCloudBoot() && section?.split('/')[0] === 'diagnostics' && options.diagnosticsCloud()) {
      options.onCloudDiagnostics(section)
      return
    }
    if (route) {
      options.localRoute.current = route
      setCurrentLocalRoute(route)
    }
    const target = route ?? url
    const merged = { ...(isRecord(state) ? state : {}), aghLocalRoute: options.localRoute.current }
    if (options.cloudActive()) {
      rawReplace(
        { ...(isRecord(history.state) ? history.state : {}), aghLocalRoute: options.localRoute.current },
        '',
      )
      return
    }
    if (operation === 'push' && options.coalesceNextPush.current) {
      options.coalesceNextPush.current = false
      rawReplace(merged, unused, target)
      return
    }
    if (operation === 'push') rawPush(merged, unused, target)
    else rawReplace(merged, unused, target)
  }
  history.pushState = (state, unused, url) => applyLocalHistory('push', state, unused, url)
  history.replaceState = (state, unused, url) => applyLocalHistory('replace', state, unused, url)
  return () => {
    setActiveRawHistory(undefined)
    history.pushState = originalPush
    history.replaceState = originalReplace
  }
}

export function restoreWorkbenchPopstate(options: {
  cloud: () => string | undefined
  localRoute: { current: string }
  selectCloud(): void
  sendCloudSession(session: string): void
  activateLocal(): void
}): void {
  if (isRestoringLocalRoute()) return
  const target = initialWorkbench(location.search)
  if (target.active === 'cloud' && target.remote === options.cloud()) {
    const saved = localWorkbenchRoute(history.state?.aghLocalRoute)
    if (saved) {
      options.localRoute.current = saved
      setCurrentLocalRoute(saved)
    }
    if (target.session === undefined) options.selectCloud()
    else options.sendCloudSession(target.session)
    return
  }
  options.activateLocal()
  const route =
    (target.active === 'local'
      ? localWorkbenchRoute(`/${location.search}${location.hash}`)
      : localWorkbenchRoute(history.state?.aghLocalRoute)) ?? options.localRoute.current
  if (route) {
    options.localRoute.current = route
    setCurrentLocalRoute(route)
  }
  if (target.active !== 'local' && route) {
    rawHistoryOps().replace(
      { ...(isRecord(history.state) ? history.state : {}), aghLocalRoute: route },
      '',
      route,
    )
    executeLocalBackendCommand({ kind: 'restore-local-route', route })
  }
}

export function receiveCloudFrameMessage(
  event: MessageEvent,
  options: {
    frame: HTMLIFrameElement | undefined
    cloud: string | undefined
    activeCloud: boolean
    pending: { current: { command: BackendCommand; commandId: string } | undefined }
    selection: { current: { session: string | undefined; awaiting: boolean } }
    onCommand(backend: BackendId, command: BackendCommand): void
    onSnapshot(snapshot: BackendSnapshot): void
    onAddress(session: string | undefined): void
    onError(message: string): void
  },
): void {
  const { frame, cloud } = options
  if (
    !frame ||
    event.source !== frame.contentWindow ||
    event.origin !== new URL(frame.src, location.origin).origin ||
    frame.dataset.backendOrigin !== cloud
  )
    return
  const management = localManagementCommand(event.data)
  if (management) {
    options.onCommand(commandBackend('cloud', management), management)
    return
  }
  const snapshot = backendSnapshot(event.data)
  if (snapshot) {
    options.onSnapshot(snapshot)
    const command = options.pending.current
    if (snapshot.ready && command)
      frame.contentWindow?.postMessage(
        { type: BACKEND_FRAME_COMMAND, ...command.command, commandId: command.commandId },
        new URL(frame.src, location.origin).origin,
      )
    if (snapshot.ready && snapshot.connected) {
      const sel = options.selection.current
      const session = snapshot.selected || (sel.session === undefined ? undefined : '')
      const pendingSelection = command?.command.kind === 'session' || command?.command.kind === 'new'
      if (!sel.awaiting || (!pendingSelection && sel.session === session)) {
        options.selection.current = { session, awaiting: false }
        if (options.activeCloud) options.onAddress(session)
      }
    }
    return
  }
  if (
    event.data?.type === BACKEND_FRAME_MESSAGE &&
    event.data.kind === 'ack' &&
    options.pending.current?.commandId === event.data.commandId
  ) {
    options.pending.current = undefined
  } else if (
    event.data?.type === BACKEND_FRAME_MESSAGE &&
    event.data.kind === 'error' &&
    typeof event.data.message === 'string'
  ) {
    options.onError(event.data.message.slice(0, 4096))
  }
}

export function installWorkbenchStorageSync(options: {
  cloud: () => string | undefined
  followingShared: () => boolean
  handledGen: { current: Map<string, string> }
  onReplaced(ref: string, generation: string): void
  onOriginChange(next: string | undefined, sameRef: boolean): void
  onBindingChange(remote: string, bound: boolean): void
}): () => void {
  const offBroadcast = subscribeCloudCredentialReplacement((ref, gen) => {
    if (options.handledGen.current.get(ref) === gen) return
    const remote = options.cloud()
    if (remote && readCloudCredentialRef(remote) === ref) options.onReplaced(ref, gen)
  })
  const onStorage = (event: StorageEvent) => {
    if (event.key === CLOUD_ORIGIN_KEY || (event.key === null && options.followingShared())) {
      if (!options.followingShared()) return
      const raw = safeThemeStorage().getItem(CLOUD_ORIGIN_KEY)
      let next: string | undefined
      try {
        if (raw) next = remoteFrontendOrigin(raw)
      } catch {}
      const previous = options.cloud()
      if (next === previous) return
      const sameRef = Boolean(
        previous &&
          next &&
          readCloudCredentialRef(previous) &&
          readCloudCredentialRef(previous) === readCloudCredentialRef(next),
      )
      options.onOriginChange(next, sameRef)
      return
    }
    const remote = options.cloud()
    if (remote && (event.key === null || event.key === `${CLOUD_CREDENTIAL_STORAGE_PREFIX}${remote}`))
      options.onBindingChange(remote, Boolean(readCloudCredentialRef(remote)))
  }
  window.addEventListener('storage', onStorage)
  return () => {
    offBroadcast()
    window.removeEventListener('storage', onStorage)
  }
}
