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
import { workbenchCatalog } from './workbench-locale.js'
import {
  backendFrameSource,
  CLOUD_DISCOVERY_KEY,
  CLOUD_ORIGIN_KEY,
  cloudConnectionState,
  initialWorkbench,
  workbenchAddress,
} from './workbench-state.js'

function initialFrameSource(remote: string | undefined, selected: boolean, search: string): string {
  const url = new URL(backendFrameSource(remote), remote ? cloudFrameOrigin() : location.origin)
  if (selected)
    for (const [key, value] of new URLSearchParams(search)) {
      if (key !== 'remote' && key !== 'connection') url.searchParams.append(key, value)
    }
  return remote ? url.href : `${url.pathname}${url.search}`
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
  const [revisions, setRevisions] = useState({ local: 0, cloud: 0 })
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
  const intent = useRef<Partial<Record<BackendId, string>>>({})
  const latest = useRef({ active, cloud, states, configure })
  latest.current = { active, cloud, states, configure }
  useEffect(
    () =>
      installCloudFrameAuthorization(() => ({ remote: latest.current.cloud, frame: frames.current.cloud })),
    [],
  )
  const initialSearch = useRef(location.search)
  const setAddress = useCallback((backend: BackendId, sessionId?: string) => {
    const href = workbenchAddress(backend, latest.current.cloud, sessionId)
    if (`${location.pathname}${location.search}` !== href) history.replaceState({}, '', href)
  }, [])
  const send = useCallback(
    (backend: BackendId, command: BackendCommand) => {
      backend = commandBackend(backend, command)
      if (backend === 'cloud' && !latest.current.cloud) {
        setConfigure(true)
        return
      }
      if (command.kind !== 'more' && command.kind !== 'refresh') {
        setActive(backend)
        latest.current.active = backend
        setConfigure(false)
        if (window.matchMedia('(max-width: 900px)').matches)
          frames.current.local?.contentDocument?.getElementById('sidebar-close')?.click()
      }
      if (command.kind === 'session' || command.kind === 'new') {
        intent.current[backend] = command.kind === 'new' ? '' : command.sessionId
        setAddress(backend, command.kind === 'session' ? command.sessionId : undefined)
      }
      const frame = frames.current[backend]
      const entry = { command, commandId: crypto.randomUUID() }
      pending.current[backend] = entry
      if (frame?.contentWindow && latest.current.states[backend]?.ready)
        frame.contentWindow.postMessage(
          { type: BACKEND_FRAME_COMMAND, ...command, commandId: entry.commandId },
          new URL(frame.src, location.origin).origin,
        )
    },
    [setAddress],
  )
  const select = useCallback(
    (backend: BackendId, sessionId?: string, keepSidebar = false) => {
      if (sessionId) {
        send(backend, { kind: 'session', sessionId })
        return
      }
      setActive(backend)
      latest.current.active = backend
      setConfigure(false)
      if (!keepSidebar && window.matchMedia('(max-width: 900px)').matches)
        frames.current.local?.contentDocument?.getElementById('sidebar-close')?.click()
      setAddress(backend, latest.current.states[backend]?.selected)
    },
    [send, setAddress],
  )
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
        setStates((current) => {
          const { cloud: _previous, ...rest } = current
          return rest
        })
        delete pending.current.cloud
        delete intent.current.cloud
        setCloud(next)
        latest.current.cloud = next
      } else if (credentialRef !== undefined || !latest.current.states.cloud?.connected) {
        setStates((current) => {
          const { cloud: _previous, ...rest } = current
          return rest
        })
        setRevisions((current) => ({ ...current, cloud: current.cloud + 1 }))
      }
      if (activate) select('cloud')
    },
    [select, t],
  )
  const retry = useCallback((backend: BackendId) => {
    setStates((current) => {
      const next = { ...current }
      delete next[backend]
      return next
    })
    setRevisions((current) => ({ ...current, [backend]: current[backend] + 1 }))
  }, [])
  const disconnect = useCallback(() => {
    connectionRevision.current++
    connectionRequest.current?.abort()
    setDiscovering(false)
    setConfigurationError('')
    safeThemeStorage().removeItem(CLOUD_ORIGIN_KEY)
    safeThemeStorage().removeItem(CLOUD_DISCOVERY_KEY)
    setCloud(undefined)
    latest.current.cloud = undefined
    delete pending.current.cloud
    delete intent.current.cloud
    setStates((current) => {
      const { cloud: _previous, ...rest } = current
      return rest
    })
    select('local')
  }, [select])
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
          select(event.data.backend, undefined, true)
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
        if (event.data.kind === 'local-navigation') {
          setActive('local')
          latest.current.active = 'local'
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
          else retry('cloud')
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
        const desired = intent.current[backend]
        if (desired === undefined || desired === (snapshot.selected ?? '')) {
          delete intent.current[backend]
          if (latest.current.active === backend && !latest.current.configure)
            setAddress(backend, snapshot.selected)
        }
      } else if (
        event.data?.type === BACKEND_FRAME_MESSAGE &&
        event.data.kind === 'ack' &&
        pending.current[backend]?.commandId === event.data.commandId
      ) {
        delete pending.current[backend]
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
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [connect, disconnect, retry, select, setAddress, loadCredentials, send])
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
  useEffect(() => {
    if (cloud) frames.current.cloud?.toggleAttribute('inert', sidebarOpen)
  }, [sidebarOpen, cloud])
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
            key={`${backend}:${backend === 'cloud' ? cloud : ''}:${revisions[backend]}`}
            ref={(node) => {
              if (node) frames.current[backend] = node
              else delete frames.current[backend]
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
              initial.active === backend && (backend === 'local' || cloud === initial.remote),
              initialSearch.current,
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
