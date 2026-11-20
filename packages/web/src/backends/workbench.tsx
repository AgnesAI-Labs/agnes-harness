import { remoteFrontendOrigin } from '@agnes/protocol'
import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import { applyDocumentLocale, readLocalePreference } from '@agnes/web-foundation/locale-preference'
import {
  applyFontScale,
  applyTheme,
  readFontScale,
  readThemePreference,
  resolveTheme,
  safeThemeStorage,
} from '@agnes/web-foundation/theme'
import { Button, Icon, mountApplication, useDocumentLanguage } from '@agnes/web-ui'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { discoverCloudOrigin } from '../remote-authorization.js'
import { installCloudFrameAuthorization } from './cloud-frame-authorization.js'
import { bindCloudCredential, readCloudCredentialRef } from './cloud-key.js'
import { CLOUD_SETTINGS_SECTION, cloudConnectionAction } from './cloud-settings-bridge.js'
import { cloudFrameOrigin } from './frame-context.js'
import {
  BACKEND_FRAME_COMMAND,
  BACKEND_FRAME_MESSAGE,
  type BackendCommand,
  type BackendId,
  type BackendSnapshot,
  backendCommand,
  backendSnapshot,
  commandBackend,
  localManagementCommand,
} from './frame-contract.js'
import { localWorkbenchRoute } from './local-route.js'
import { workbenchCatalog } from './workbench-locale.js'
import {
  backendFrameSource,
  CLOUD_DISCOVERY_KEY,
  CLOUD_ORIGIN_KEY,
  cloudConnectionState,
  initialWorkbench,
  workbenchAddress,
} from './workbench-state.js'

function initialFrameSource(
  remote: string | undefined,
  selected: boolean,
  search: string,
  hash: string,
): string {
  const url = new URL(backendFrameSource(remote), remote ? cloudFrameOrigin() : location.origin)
  if (selected) {
    // Preserve encoded route levels verbatim when passing the initial address to the frame.
    const rest = search
      .slice(1)
      .split('&')
      .filter((part) => {
        const params = new URLSearchParams(part)
        return part && !params.has('remote') && !params.has('connection')
      })
    url.search = [url.search.slice(1), ...rest].filter(Boolean).join('&')
    if (!remote) url.hash = hash
  }
  return remote ? url.href : `${url.pathname}${url.search}${url.hash}`
}

function BackendWorkbench() {
  const [initial] = useState(() =>
    initialWorkbench(location.search, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY)),
  )
  const [cloud, setCloud] = useState(initial.remote)
  const [active, setActive] = useState<BackendId>(initial.active)
  const [configure, setConfigure] = useState(initial.configure)
  const [configurationError, setConfigurationError] = useState('')
  const [credentialOptions, setCredentialOptions] = useState<{ id: string; label: string }[]>()
  const [credentialError, setCredentialError] = useState(false)
  const credentialRequest = useRef<AbortController | undefined>(undefined)
  const connectionRevision = useRef(0)
  const connectionRequest = useRef<AbortController | undefined>(undefined)
  const [discovering, setDiscovering] = useState(false)
  const [states, setStates] = useState<Partial<Record<BackendId, BackendSnapshot>>>({})
  const [cloudFrame, setCloudFrame] = useState({ revision: 0, search: undefined as string | undefined })
  const [sidebarRight, setSidebarRight] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const language = useDocumentLanguage()
  const catalog = workbenchCatalog[language === 'zh-CN' ? 'zh-CN' : 'en']
  const t = useCallback((key: keyof typeof catalog) => catalog[key], [catalog])
  const loadCredentials = useCallback(() => {
    credentialRequest.current?.abort()
    const request = new AbortController()
    credentialRequest.current = request
    void new CredentialsApi()
      .list(request.signal)
      .then((items) => {
        if (request.signal.aborted) return
        setCredentialOptions(items.map(({ id, label }) => ({ id, label })))
        setCredentialError(false)
      })
      .catch(() => {
        if (request.signal.aborted) return
        setCredentialOptions([])
        setCredentialError(true)
      })
  }, [])
  useEffect(() => () => credentialRequest.current?.abort(), [])
  useEffect(() => () => connectionRequest.current?.abort(), [])
  const frames = useRef<Partial<Record<BackendId, HTMLIFrameElement>>>({})
  const pending = useRef<Partial<Record<BackendId, { command: BackendCommand; commandId: string }>>>({})
  // An empty session names a cloud draft. Undefined means no cloud selection is known yet.
  const cloudSelection = useRef({
    session: initial.active === 'cloud' ? initial.session : undefined,
    awaiting: initial.active === 'cloud' && initial.session !== undefined,
  })
  const localManagementActivation = useRef<string | undefined>(undefined)
  const latest = useRef({ active, cloud, states, configure })
  latest.current = { active, cloud, states, configure }
  useEffect(
    () =>
      installCloudFrameAuthorization(() => ({ remote: latest.current.cloud, frame: frames.current.cloud })),
    [],
  )
  const initialSearch = useRef(location.search)
  const initialHash = useRef(location.hash)
  const localRoute = useRef(
    (initial.active === 'local' && localWorkbenchRoute(`/${initialSearch.current}${initialHash.current}`)) ||
      '/',
  )
  const setAddress = useCallback((backend: BackendId, sessionId?: string, push = false) => {
    const href =
      backend === 'local' || !latest.current.cloud
        ? localRoute.current
        : workbenchAddress(backend, latest.current.cloud, sessionId)
    if (`${location.pathname}${location.search}${location.hash}` === href) return
    if (push) history.pushState({}, '', href)
    else history.replaceState({}, '', href)
  }, [])
  const send = useCallback(
    (backend: BackendId, command: BackendCommand, restoring = false) => {
      backend = commandBackend(backend, command)
      if (backend === 'cloud' && !latest.current.cloud) {
        setConfigure(true)
        return
      }
      const switching = latest.current.active !== backend
      const changesCloudSession =
        backend === 'cloud' && (command.kind === 'session' || command.kind === 'new')
      const localManagement =
        switching && backend === 'local' && (command.kind === 'settings' || command.kind === 'home')
      if (command.kind !== 'more' && command.kind !== 'refresh') localManagementActivation.current = undefined
      if (!localManagement && command.kind !== 'more' && command.kind !== 'refresh') {
        setActive(backend)
        latest.current.active = backend
        setConfigure(false)
        latest.current.configure = false
        if (switching && !restoring && !changesCloudSession)
          setAddress(backend, backend === 'cloud' ? cloudSelection.current.session : undefined, true)
        if (window.matchMedia('(max-width: 900px)').matches)
          frames.current.local?.contentDocument?.getElementById('sidebar-close')?.click()
      }
      if (changesCloudSession) {
        const sessionId = command.kind === 'session' ? command.sessionId : ''
        cloudSelection.current = { session: sessionId, awaiting: true }
        if (!restoring) setAddress('cloud', sessionId, true)
      }
      const frame = frames.current[backend]
      const entry = { command, commandId: crypto.randomUUID() }
      if (localManagement) localManagementActivation.current = entry.commandId
      pending.current[backend] = entry
      if (
        frame?.contentWindow &&
        (command.kind === 'restore-local-route' || latest.current.states[backend]?.ready)
      )
        frame.contentWindow.postMessage(
          { type: BACKEND_FRAME_COMMAND, ...command, commandId: entry.commandId },
          new URL(frame.src, location.origin).origin,
        )
    },
    [setAddress],
  )
  const select = useCallback(
    (
      backend: BackendId,
      { keepSidebar = false, restoring = false }: { keepSidebar?: boolean; restoring?: boolean } = {},
    ) => {
      localManagementActivation.current = undefined
      const switching = latest.current.active !== backend
      setActive(backend)
      latest.current.active = backend
      setConfigure(false)
      latest.current.configure = false
      if (!keepSidebar && window.matchMedia('(max-width: 900px)').matches)
        frames.current.local?.contentDocument?.getElementById('sidebar-close')?.click()
      const selected =
        backend === 'cloud' ? cloudSelection.current.session : latest.current.states.local?.selected
      setAddress(backend, selected, switching && !restoring)
    },
    [setAddress],
  )
  const clearCloudFrame = useCallback(() => {
    delete frames.current.cloud
    delete pending.current.cloud
    const { cloud: _previous, ...rest } = latest.current.states
    latest.current.states = rest
    setStates((current) => {
      const { cloud: _previous, ...other } = current
      return other
    })
  }, [])
  const restartCloudFrame = useCallback(() => {
    // A command can be acknowledged before a successful read confirms its selection.
    const selected = cloudSelection.current.session
    const search =
      selected === undefined ? undefined : selected ? `?session=${encodeURIComponent(selected)}` : '?new=1'
    clearCloudFrame()
    cloudSelection.current.awaiting = selected !== undefined
    setCloudFrame(({ revision }) => ({ revision: revision + 1, search }))
  }, [clearCloudFrame])
  const connect = useCallback(
    async (value: string | undefined, activate = true, credentialRef?: string) => {
      const revision = ++connectionRevision.current
      connectionRequest.current?.abort()
      const request = new AbortController()
      connectionRequest.current = request
      setDiscovering(value === undefined)
      setConfigurationError('')
      let next: string
      try {
        const items =
          credentialRef === undefined ? undefined : await new CredentialsApi().list(request.signal)
        if (revision !== connectionRevision.current || request.signal.aborted) return
        if (credentialRef !== undefined && !items?.some((item) => item.id === credentialRef))
          throw Error('CLOUD_CREDENTIAL_NOT_FOUND')
        next =
          value === undefined
            ? await discoverCloudOrigin(credentialRef ?? '', request.signal)
            : remoteFrontendOrigin(value)
        if (revision !== connectionRevision.current || request.signal.aborted) return
        if (credentialRef !== undefined) {
          bindCloudCredential(next, credentialRef, items ?? [])
          if (value === undefined) safeThemeStorage().setItem(CLOUD_DISCOVERY_KEY, credentialRef)
          else safeThemeStorage().removeItem(CLOUD_DISCOVERY_KEY)
        }
      } catch (error) {
        if (revision === connectionRevision.current && !request.signal.aborted)
          setConfigurationError(
            error instanceof Error && error.message.startsWith('CLOUD_')
              ? error.message
              : t('credentialsUnavailable'),
          )
        return
      } finally {
        if (revision === connectionRevision.current) setDiscovering(false)
      }
      if (revision !== connectionRevision.current || request.signal.aborted) return
      if (!readCloudCredentialRef(next)) {
        setConfigurationError(t('keyRequired'))
        setConfigure(true)
        return
      }
      safeThemeStorage().setItem(CLOUD_ORIGIN_KEY, next)
      if (next !== latest.current.cloud) {
        clearCloudFrame()
        cloudSelection.current = { session: undefined, awaiting: false }
        setCloudFrame({ revision: 0, search: undefined })
        setCloud(next)
        latest.current.cloud = next
      } else if (credentialRef !== undefined || !latest.current.states.cloud?.connected) restartCloudFrame()
      if (activate) select('cloud')
    },
    [clearCloudFrame, restartCloudFrame, select, t],
  )
  const disconnect = useCallback(() => {
    connectionRevision.current++
    connectionRequest.current?.abort()
    setDiscovering(false)
    setConfigurationError('')
    safeThemeStorage().removeItem(CLOUD_ORIGIN_KEY)
    safeThemeStorage().removeItem(CLOUD_DISCOVERY_KEY)
    setCloud(undefined)
    latest.current.cloud = undefined
    clearCloudFrame()
    cloudSelection.current = { session: undefined, awaiting: false }
    setCloudFrame({ revision: 0, search: undefined })
    select('local')
  }, [clearCloudFrame, select])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const backend = (['local', 'cloud'] as const).find(
        (id) => frames.current[id]?.contentWindow === event.source,
      )
      if (
        !backend ||
        event.origin !== new URL(frames.current[backend]?.src ?? '/', location.origin).origin ||
        (backend === 'cloud' && frames.current.cloud?.dataset.backendOrigin !== latest.current.cloud)
      )
        return
      if (backend === 'local' && event.data?.type === BACKEND_FRAME_MESSAGE) {
        if (event.data.kind === 'sidebar-select' && ['local', 'cloud'].includes(event.data.backend)) {
          select(event.data.backend, { keepSidebar: true })
          return
        }
        if (event.data.kind === 'sidebar-layout') {
          if (Number.isFinite(event.data.right))
            setSidebarRight(Math.min(window.innerWidth, Math.max(0, event.data.right)))
          setSidebarOpen(event.data.open === true)
          return
        }
        if (event.data.kind === 'sidebar-command') {
          const command = backendCommand(event.data.command)
          if (command && ['local', 'cloud'].includes(event.data.backend)) send(event.data.backend, command)
          return
        }
        if (event.data.kind === 'local-route') {
          const route = localWorkbenchRoute(event.data.route)
          const operation = event.data.operation
          if (!route || (operation !== 'push' && operation !== 'replace')) return
          localRoute.current = route
          if (
            latest.current.active === 'local' &&
            !latest.current.configure &&
            pending.current.local?.command.kind !== 'restore-local-route'
          )
            setAddress('local', undefined, operation === 'push')
          return
        }
      }
      const management = localManagementCommand(event.data)
      if (management) {
        send('local', management)
        return
      }
      const action = cloudConnectionAction(event.data)
      if (action && backend === 'local') {
        if (action.action === 'connect') connect(action.origin, false, action.credentialRef)
        else if (action.action === 'disconnect') disconnect()
        else if (action.action === 'refresh-credentials') loadCredentials()
        else if (action.action === 'manage-credentials')
          send('local', { kind: 'settings', section: 'credentials' })
        else if (latest.current.cloud) {
          const ref = safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY)
          if (ref && readCloudCredentialRef(latest.current.cloud) === ref) connect(undefined, false, ref)
          else restartCloudFrame()
        }
        return
      }
      const snapshot = backendSnapshot(event.data)
      if (snapshot) {
        setStates((current) => ({ ...current, [backend]: snapshot }))
        latest.current.states = { ...latest.current.states, [backend]: snapshot }
        const command = pending.current[backend]
        if (snapshot.ready && command) {
          frames.current[backend]?.contentWindow?.postMessage(
            { type: BACKEND_FRAME_COMMAND, ...command.command, commandId: command.commandId },
            new URL(frames.current[backend]?.src ?? '/', location.origin).origin,
          )
        }
        if (backend === 'cloud' && snapshot.ready && snapshot.connected) {
          const selection = cloudSelection.current
          const session = snapshot.selected || (selection.session === undefined ? undefined : '')
          const pendingSelection = command?.command.kind === 'session' || command?.command.kind === 'new'
          if (!selection.awaiting || (!pendingSelection && selection.session === session)) {
            cloudSelection.current = { session, awaiting: false }
            if (latest.current.active === 'cloud' && !latest.current.configure) setAddress('cloud', session)
          }
        }
      } else if (
        event.data?.type === BACKEND_FRAME_MESSAGE &&
        event.data.kind === 'ack' &&
        pending.current[backend]?.commandId === event.data.commandId
      ) {
        const restoring = pending.current[backend]?.command.kind === 'restore-local-route'
        delete pending.current[backend]
        if (backend === 'local' && localManagementActivation.current === event.data.commandId) select('local')
        if (restoring && latest.current.active === 'local') setAddress('local')
      } else if (
        event.data?.type === BACKEND_FRAME_MESSAGE &&
        event.data.kind === 'error' &&
        typeof event.data.message === 'string'
      ) {
        setStates((current) => ({
          ...current,
          [backend]: {
            ready: false,
            connected: false,
            rows: current[backend]?.rows ?? [],
            activity: [],
            more: false,
            error: event.data.message.slice(0, 4096),
          },
        }))
      } else if (
        backend === 'local' &&
        event.data?.type === BACKEND_FRAME_MESSAGE &&
        event.data.kind === 'environment'
      ) {
        if (typeof event.data.remote === 'string') connect(event.data.remote)
        else select('local')
      }
    }
    const restoreAddress = () => {
      const target = initialWorkbench(location.search)
      if (target.active === 'cloud' && target.remote === latest.current.cloud) {
        // An address recorded before the first cloud snapshot has no selection to replay.
        if (target.session === undefined) select('cloud', { restoring: true })
        else
          send(
            'cloud',
            target.session ? { kind: 'session', sessionId: target.session } : { kind: 'new' },
            true,
          )
        return
      }
      const route =
        target.active === 'local'
          ? localWorkbenchRoute(`/${location.search}${location.hash}`)
          : localRoute.current
      if (route) send('local', { kind: 'restore-local-route', route }, true)
    }
    window.addEventListener('message', receive)
    window.addEventListener('popstate', restoreAddress)
    return () => {
      window.removeEventListener('message', receive)
      window.removeEventListener('popstate', restoreAddress)
    }
  }, [connect, disconnect, restartCloudFrame, select, setAddress, loadCredentials, send])
  const restoredCloud = useRef(false)
  useEffect(() => {
    if (restoredCloud.current || !states.local?.ready) return
    restoredCloud.current = true
    const ref = safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY)
    if (
      !new URLSearchParams(initialSearch.current).has('remote') &&
      ref &&
      cloud &&
      readCloudCredentialRef(cloud) === ref
    )
      void connect(undefined, false, ref)
  }, [states.local?.ready, connect, cloud])
  useEffect(() => {
    const state = {
      ...cloudConnectionState(cloud, states.cloud),
      ...(discovering ? { status: 'connecting' } : configurationError ? { status: 'error' } : {}),
      ...(cloud && readCloudCredentialRef(cloud) ? { credentialRef: readCloudCredentialRef(cloud) } : {}),
      ...(credentialOptions ? { credentialOptions } : {}),
      credentialError,
      ...(configurationError ? { error: configurationError } : {}),
    }
    for (const frame of [frames.current.local].filter((frame): frame is HTMLIFrameElement => !!frame))
      frame.contentWindow?.postMessage(
        { type: BACKEND_FRAME_MESSAGE, kind: 'cloud-state', state },
        location.origin,
      )
  }, [cloud, states, configurationError, credentialOptions, credentialError, discovering])
  useEffect(() => {
    if (configure && states.local?.ready) send('local', { kind: 'settings', section: CLOUD_SETTINGS_SECTION })
  }, [configure, states.local?.ready, send])
  useEffect(() => {
    if (cloud) safeThemeStorage().setItem(CLOUD_ORIGIN_KEY, cloud)
  }, [cloud])
  useEffect(() => {
    frames.current.local?.contentWindow?.postMessage(
      {
        type: BACKEND_FRAME_MESSAGE,
        kind: 'sidebar-projection',
        projection: { active, ...(cloud ? { cloud } : {}), states },
      },
      location.origin,
    )
  }, [active, cloud, states])
  const stage = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    stage.current?.style.setProperty('--backend-sidebar-right', `${sidebarRight}px`)
  }, [sidebarRight])
  return (
    <main ref={stage} className="backend-workbench-stage">
      {active === 'cloud' && !sidebarOpen && (
        <Button
          className="backend-cloud-menu"
          appearance="ghost"
          aria-label={t('menu')}
          onClick={() => frames.current.local?.contentDocument?.getElementById('sidebar-toggle')?.click()}
        >
          <Icon name="menu" />
        </Button>
      )}
      {(['local', 'cloud'] as const).map((backend) =>
        backend === 'cloud' && !cloud ? null : (
          <iframe
            key={backend === 'cloud' ? `cloud:${cloud}:${cloudFrame.revision}` : 'local'}
            ref={(node) => {
              if (node) {
                frames.current[backend] = node
                if (backend === 'cloud') node.toggleAttribute('inert', sidebarOpen)
              } else delete frames.current[backend]
            }}
            title={t(backend)}
            className="backend-workbench-frame"
            data-agh-backend-frame="1"
            data-backend-origin={backend === 'cloud' ? cloud : ''}
            data-testid={`backend-frame-${backend}`}
            allow={backend === 'cloud' ? 'clipboard-write' : undefined}
            sandbox={
              backend === 'cloud'
                ? 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups'
                : undefined
            }
            hidden={backend === 'cloud' && (active !== 'cloud' || sidebarOpen)}
            src={initialFrameSource(
              backend === 'cloud' ? cloud : undefined,
              (backend === 'cloud' && cloudFrame.search !== undefined) ||
                (initial.active === backend && (backend === 'local' || cloud === initial.remote)),
              (backend === 'cloud' ? cloudFrame.search : undefined) ?? initialSearch.current,
              initialHash.current,
            )}
          />
        ),
      )}
    </main>
  )
}

export function mountBackendWorkbench(): void {
  document.body.dataset.aghBackendWorkbench = 'true'
  const storage = safeThemeStorage()
  const sync = () => {
    applyDocumentLocale(document.documentElement, readLocalePreference(storage))
    applyTheme(
      document.documentElement,
      resolveTheme(readThemePreference(storage), matchMedia('(prefers-color-scheme: dark)').matches),
    )
    applyFontScale(document.documentElement, readFontScale(storage))
  }
  sync()
  window.addEventListener('storage', sync)
  const root = document.getElementById('app-root')
  if (!root) throw new Error('missing #app-root')
  mountApplication(root, <BackendWorkbench />)
}
