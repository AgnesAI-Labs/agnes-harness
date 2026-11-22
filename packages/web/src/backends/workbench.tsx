import { remoteFrontendOrigin } from '@agnes/protocol'
import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import { Button, Icon, mountApplication, useDocumentLanguage } from '@agnes/web-ui'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { discoverCloudOrigin, forgetAllRemoteAccess, forgetRemoteAccess } from '../remote-authorization.js'
import { syncWorkbenchAppearance } from './cloud-frame-appearance.js'
import { installCloudFrameAuthorization } from './cloud-frame-authorization.js'
import {
  bindCloudCredential,
  bumpCloudCredentialGeneration,
  forgetCloudCredential,
  readCloudCredentialGeneration,
  readCloudCredentialRef,
  recordCloudCredentialGeneration,
} from './cloud-key.js'
import { watchCloudOrigin } from './cloud-recovery.js'
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
  CLOUD_DISCOVERY_KEY,
  CLOUD_ORIGIN_KEY,
  cloudConnectionState,
  errorCloudSnapshot,
  initialFrameSource,
  initialWorkbench,
  installWorkbenchStorageSync,
  isSharedCloudOrigin,
  sessionFrameSearch,
  workbenchAddress,
} from './workbench-state.js'

const ownsShared = (following: boolean, origin?: string) =>
  following && isSharedCloudOrigin(origin, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY))

function BackendWorkbench() {
  const [initial] = useState(() =>
    initialWorkbench(location.search, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY)),
  )
  const followingShared = useRef(
    !new URLSearchParams(location.search).has('remote') ||
      isSharedCloudOrigin(initial.remote, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY)),
  )
  const [cloud, setCloud] = useState(initial.remote)
  const [active, setActive] = useState<BackendId>(initial.active)
  const [configure, setConfigure] = useState(initial.configure)
  const [configurationError, setConfigurationError] = useState('')
  const [candidateError, setCandidateError] = useState('')
  const [credentialOptions, setCredentialOptions] = useState<{ id: string; label: string }[]>()
  const [credentialError, setCredentialError] = useState(false)
  const credentialRequest = useRef<AbortController | undefined>(undefined)
  const connectionRevision = useRef(0)
  const [connectionEpoch, setConnectionEpoch] = useState(0)
  const connectionIntent = useRef<string | undefined>(undefined)
  const rotatedActiveRef = useRef<string | undefined>(undefined)
  const lastHandledGen = useRef(new Map<string, string>())
  const connectionRequest = useRef<AbortController | undefined>(undefined)
  const [discovering, setDiscovering] = useState(false)
  const [states, setStates] = useState<Partial<Record<BackendId, BackendSnapshot>>>({})
  const [cloudFrame, setCloudFrame] = useState({
    revision: 0,
    search: undefined as string | undefined,
    retired: false,
  })
  const abortFrameAuth = useRef<(() => void) | undefined>(undefined)
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
  const diagnosticsBackend = useRef<BackendId>(initial.active)
  const latest = useRef({ active, cloud, states, configure })
  latest.current = { active, cloud, states, configure }
  useEffect(
    () =>
      installCloudFrameAuthorization(
        () => ({ remote: latest.current.cloud, frame: frames.current.cloud }),
        (abort) => {
          abortFrameAuth.current = abort
        },
      ),
    [],
  )
  const initialSearch = useRef(location.search)
  const initialHash = useRef(location.hash)
  const [localAddress] = useState(
    () =>
      new URL(
        localWorkbenchRoute(
          initial.active === 'local'
            ? `/${initialSearch.current}${initialHash.current}`
            : history.state?.aghLocalRoute,
        ) || '/',
        location.origin,
      ),
  )
  const localRoute = useRef(`${localAddress.pathname}${localAddress.search}${localAddress.hash}`)
  const setAddress = useCallback((backend: BackendId, sessionId?: string, push = false) => {
    const href =
      backend === 'local' || !latest.current.cloud
        ? localRoute.current
        : workbenchAddress(backend, latest.current.cloud, sessionId)
    const state = {
      ...(history.state && typeof history.state === 'object' ? history.state : {}),
      aghLocalRoute: localRoute.current,
    }
    if (`${location.pathname}${location.search}${location.hash}` === href) {
      history.replaceState(state, '')
      return
    }
    if (push) history.pushState(state, '', href)
    else history.replaceState(state, '', href)
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
      if (
        changesCloudSession ||
        (backend === 'local' && (command.kind === 'session' || command.kind === 'new'))
      )
        diagnosticsBackend.current = backend
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
      {
        keepSidebar = false,
        restoring = false,
        management = false,
      }: { keepSidebar?: boolean; restoring?: boolean; management?: boolean } = {},
    ) => {
      localManagementActivation.current = undefined
      if (!management) diagnosticsBackend.current = backend
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
  const retireCloudFrame = useCallback(() => {
    clearCloudFrame()
    setCloudFrame((current) => ({ ...current, revision: current.revision + 1, retired: true }))
  }, [clearCloudFrame])
  const restartCloudFrame = useCallback(() => {
    const selected = cloudSelection.current.session
    clearCloudFrame()
    cloudSelection.current.awaiting = selected !== undefined
    setCloudFrame(({ revision }) => ({
      revision: revision + 1,
      search: sessionFrameSearch(selected),
      retired: false,
    }))
  }, [clearCloudFrame])
  const cancelPendingConnect = useCallback(() => {
    connectionRevision.current++
    setConnectionEpoch(connectionRevision.current)
    connectionIntent.current = undefined
    rotatedActiveRef.current = undefined
    connectionRequest.current?.abort()
    connectionRequest.current = undefined
    setDiscovering(false)
  }, [])
  const connect = useCallback(
    async (
      value: string | undefined,
      activate = true,
      credentialRef?: string,
      automatic = false,
      preservedError?: string,
    ) => {
      const revision = ++connectionRevision.current
      setConnectionEpoch(revision)
      connectionIntent.current = credentialRef
      const initialCloud = latest.current.cloud
      const ownedSharedBefore = !automatic || ownsShared(followingShared.current, initialCloud)
      const initialGen = credentialRef ? readCloudCredentialGeneration(credentialRef) : undefined
      connectionRequest.current?.abort()
      const request = new AbortController()
      connectionRequest.current = request
      let succeeded = false
      let candidateFailure = preservedError
      setDiscovering(true)
      setConfigurationError('')
      setCandidateError(preservedError ?? '')
      let next: string
      try {
        const items =
          credentialRef === undefined ? undefined : await new CredentialsApi().list(request.signal)
        if (
          revision !== connectionRevision.current ||
          request.signal.aborted ||
          (credentialRef !== undefined && readCloudCredentialGeneration(credentialRef) !== initialGen)
        )
          return
        if (credentialRef !== undefined && !items?.some((item) => item.id === credentialRef))
          throw Error('CLOUD_CREDENTIAL_NOT_FOUND')
        if (credentialRef !== undefined && value !== undefined && !automatic)
          forgetRemoteAccess(remoteFrontendOrigin(value))
        next =
          value === undefined
            ? await discoverCloudOrigin(credentialRef ?? '', request.signal)
            : remoteFrontendOrigin(value)
        const ownsSharedNow =
          !automatic || (ownedSharedBefore && ownsShared(followingShared.current, initialCloud))
        if (
          revision !== connectionRevision.current ||
          request.signal.aborted ||
          (credentialRef !== undefined && readCloudCredentialGeneration(credentialRef) !== initialGen) ||
          (automatic &&
            (!initialCloud ||
              latest.current.cloud !== initialCloud ||
              readCloudCredentialRef(initialCloud) !== credentialRef ||
              (ownedSharedBefore && !ownsSharedNow)))
        )
          return
        if (credentialRef !== undefined) {
          bindCloudCredential(next, credentialRef, items ?? [])
          if (ownsSharedNow) {
            const keepManaged =
              value === undefined ||
              (automatic && safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY) === credentialRef)
            if (keepManaged) safeThemeStorage().setItem(CLOUD_DISCOVERY_KEY, credentialRef)
            else safeThemeStorage().removeItem(CLOUD_DISCOVERY_KEY)
          }
        }
        if (!readCloudCredentialRef(next)) {
          setConfigurationError(t('keyRequired'))
          setConfigure(true)
          return
        }
        succeeded = true
        rotatedActiveRef.current = undefined
        if (ownsSharedNow) {
          followingShared.current = true
          safeThemeStorage().setItem(CLOUD_ORIGIN_KEY, next)
        }
        if (next !== latest.current.cloud) {
          const session = automatic ? cloudSelection.current.session : undefined
          clearCloudFrame()
          cloudSelection.current = { session, awaiting: session !== undefined }
          setCloudFrame({ revision: 0, search: sessionFrameSearch(session), retired: false })
          setCloud(next)
          latest.current.cloud = next
          if (!activate && latest.current.active === 'cloud' && !latest.current.configure)
            setAddress('cloud', session)
        } else if (credentialRef !== undefined || !latest.current.states.cloud?.connected) restartCloudFrame()
        if (activate) select('cloud')
      } catch (error) {
        if (revision === connectionRevision.current && !request.signal.aborted) {
          const failure =
            error instanceof Error && error.message.startsWith('CLOUD_')
              ? error.message
              : t('credentialsUnavailable')
          const affectsActive =
            !latest.current.cloud ||
            credentialRef === undefined ||
            readCloudCredentialRef(latest.current.cloud) === credentialRef
          if (affectsActive) {
            if (latest.current.cloud && credentialRef !== undefined) {
              forgetRemoteAccess(latest.current.cloud)
              abortFrameAuth.current?.()
              retireCloudFrame()
            }
            setConfigurationError(failure)
          } else {
            candidateFailure = failure
            setCandidateError(failure)
          }
        }
      } finally {
        if (revision === connectionRevision.current) {
          connectionIntent.current = undefined
          setDiscovering(false)
          const rotatedRef = succeeded ? undefined : rotatedActiveRef.current
          rotatedActiveRef.current = undefined
          if (
            rotatedRef &&
            rotatedRef !== credentialRef &&
            latest.current.cloud &&
            readCloudCredentialRef(latest.current.cloud) === rotatedRef
          ) {
            const managed =
              ownsShared(followingShared.current, latest.current.cloud) &&
              safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY) === rotatedRef
            void connect(
              managed ? undefined : latest.current.cloud,
              false,
              rotatedRef,
              true,
              candidateFailure,
            )
          }
        }
      }
    },
    [clearCloudFrame, restartCloudFrame, retireCloudFrame, select, setAddress, t],
  )
  const disconnect = useCallback(() => {
    const previous = latest.current.cloud
    cancelPendingConnect()
    abortFrameAuth.current?.()
    if (previous) forgetRemoteAccess(previous)
    else forgetAllRemoteAccess()
    if (previous && ownsShared(followingShared.current, previous)) {
      const previousRef = readCloudCredentialRef(previous)
      forgetCloudCredential(previous)
      safeThemeStorage().removeItem(CLOUD_ORIGIN_KEY)
      if (!previousRef || safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY) === previousRef)
        safeThemeStorage().removeItem(CLOUD_DISCOVERY_KEY)
    }
    followingShared.current = true
    setConfigurationError('')
    setCandidateError('')
    setCloud(undefined)
    latest.current.cloud = undefined
    clearCloudFrame()
    cloudSelection.current = { session: undefined, awaiting: false }
    setCloudFrame({ revision: 0, search: undefined, retired: false })
    select('local')
  }, [cancelPendingConnect, clearCloudFrame, select])
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
          const section = new URL(route, location.origin).searchParams.get('settings')
          if (
            section?.split('/')[0] === 'diagnostics' &&
            diagnosticsBackend.current === 'cloud' &&
            latest.current.cloud
          ) {
            send('cloud', { kind: 'settings', section })
            return
          }
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
        send(
          commandBackend(backend === 'local' ? diagnosticsBackend.current : backend, management),
          management,
        )
        return
      }
      const action = cloudConnectionAction(event.data)
      if (action && backend === 'local') {
        if (action.action === 'connect') connect(action.origin, false, action.credentialRef)
        else if (action.action === 'credential-replaced') {
          const remote = latest.current.cloud
          const ref = action.credentialRef
          const gen = action.generation
            ? (recordCloudCredentialGeneration(ref, action.generation), readCloudCredentialGeneration(ref))
            : bumpCloudCredentialGeneration(ref)
          if (lastHandledGen.current.get(ref) === gen) return
          lastHandledGen.current.set(ref, gen)
          if (remote && readCloudCredentialRef(remote) === ref) {
            forgetRemoteAccess(remote)
            abortFrameAuth.current?.()
            retireCloudFrame()
            if (!connectionIntent.current || connectionIntent.current === ref) {
              rotatedActiveRef.current = undefined
              const managed =
                ownsShared(followingShared.current, remote) &&
                safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY) === ref
              void connect(managed ? undefined : remote, false, ref, true)
            } else {
              rotatedActiveRef.current = ref
            }
          }
        } else if (action.action === 'disconnect') disconnect()
        else if (action.action === 'refresh-credentials') loadCredentials()
        else if (action.action === 'manage-credentials')
          send('local', { kind: 'settings', section: 'credentials' })
        else if (latest.current.cloud) {
          setCandidateError('')
          const ref = ownsShared(followingShared.current, latest.current.cloud)
            ? safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY)
            : null
          if (ref && readCloudCredentialRef(latest.current.cloud) === ref)
            void connect(undefined, false, ref, true)
          else {
            forgetRemoteAccess(latest.current.cloud)
            restartCloudFrame()
          }
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
        if (backend === 'local' && localManagementActivation.current === event.data.commandId)
          select('local', { management: true })
        if (restoring && latest.current.active === 'local') setAddress('local')
      } else if (
        event.data?.type === BACKEND_FRAME_MESSAGE &&
        event.data.kind === 'error' &&
        typeof event.data.message === 'string'
      ) {
        setStates((current) => ({
          ...current,
          [backend]: errorCloudSnapshot(event.data.message.slice(0, 4096), current[backend]?.rows),
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
  }, [connect, disconnect, retireCloudFrame, restartCloudFrame, select, setAddress, loadCredentials, send])
  const restoredCloud = useRef(false)
  useEffect(() => {
    if (restoredCloud.current || !states.local?.ready) return
    restoredCloud.current = true
    const ref = safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY)
    if (
      !new URLSearchParams(initialSearch.current).has('remote') &&
      ref &&
      ownsShared(followingShared.current, cloud) &&
      cloud &&
      readCloudCredentialRef(cloud) === ref
    )
      void connect(undefined, false, ref, true)
  }, [states.local?.ready, connect, cloud])
  useEffect(
    () =>
      installWorkbenchStorageSync({
        cloud: () => latest.current.cloud,
        followingShared: () => followingShared.current,
        handledGen: lastHandledGen,
        onReplaced: (ref) => {
          const remote = latest.current.cloud
          if (!remote) return
          forgetRemoteAccess(remote)
          abortFrameAuth.current?.()
          retireCloudFrame()
          if (!connectionIntent.current || connectionIntent.current === ref) {
            rotatedActiveRef.current = undefined
            const managed =
              ownsShared(followingShared.current, remote) &&
              safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY) === ref
            void connect(managed ? undefined : remote, false, ref, true)
          } else rotatedActiveRef.current = ref
        },
        onOriginChange: (next, sameRef) => {
          const session = sameRef ? cloudSelection.current.session : undefined
          cancelPendingConnect()
          abortFrameAuth.current?.()
          setConfigurationError('')
          setCandidateError('')
          clearCloudFrame()
          cloudSelection.current = { session, awaiting: session !== undefined }
          setCloudFrame({ revision: 0, search: sessionFrameSearch(session), retired: false })
          setCloud(next)
          latest.current.cloud = next
          if (!next) select('local')
          else if (latest.current.active === 'cloud' && !latest.current.configure)
            setAddress('cloud', session)
        },
        onBindingChange: (remote, bound) => {
          cancelPendingConnect()
          forgetRemoteAccess(remote)
          abortFrameAuth.current?.()
          if (!bound) {
            retireCloudFrame()
            setConfigurationError('CLOUD_CREDENTIAL_REQUIRED')
          } else restartCloudFrame()
        },
      }),
    [cancelPendingConnect, clearCloudFrame, connect, restartCloudFrame, retireCloudFrame, select, setAddress],
  )
  useEffect(() => {
    const displayedError = configurationError || candidateError
    const state = {
      ...cloudConnectionState(cloud, states.cloud),
      ...(discovering
        ? { status: 'connecting' }
        : configurationError && !states.cloud?.connected
          ? { status: 'error' }
          : {}),
      ...(cloud && readCloudCredentialRef(cloud) ? { credentialRef: readCloudCredentialRef(cloud) } : {}),
      ...(credentialOptions ? { credentialOptions } : {}),
      credentialError,
      ...(displayedError ? { error: displayedError } : {}),
    }
    for (const frame of [frames.current.local].filter((frame): frame is HTMLIFrameElement => !!frame))
      frame.contentWindow?.postMessage(
        { type: BACKEND_FRAME_MESSAGE, kind: 'cloud-state', state },
        location.origin,
      )
  }, [candidateError, cloud, states, configurationError, credentialOptions, credentialError, discovering])
  useEffect(() => {
    if (configure && states.local?.ready) send('local', { kind: 'settings', section: CLOUD_SETTINGS_SECTION })
  }, [configure, states.local?.ready, send])
  const cloudConnected = states.cloud?.connected
  useEffect(() => {
    if (
      !cloud ||
      !ownsShared(followingShared.current, cloud) ||
      cloudConnected !== false ||
      discovering ||
      configurationError
    )
      return
    const ref = safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY)
    if (!ref || readCloudCredentialRef(cloud) !== ref) return
    if (connectionIntent.current && connectionIntent.current !== ref) return
    const revision = connectionEpoch
    return watchCloudOrigin(
      cloud,
      (signal) => discoverCloudOrigin(ref, signal),
      (origin) => {
        if (
          connectionRevision.current === revision &&
          latest.current.cloud === cloud &&
          readCloudCredentialRef(cloud) === ref
        )
          void connect(origin, false, ref, true)
      },
      (reason) => {
        if (connectionRevision.current === revision && latest.current.cloud === cloud)
          setConfigurationError(reason)
      },
    )
  }, [cloud, cloudConnected, connect, discovering, configurationError, connectionEpoch])

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
        backend === 'cloud' && (!cloud || cloudFrame.retired) ? null : (
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
              backend === 'local' ||
                cloudFrame.search !== undefined ||
                (initial.active === 'cloud' && cloud === initial.remote),
              backend === 'local'
                ? initial.active === 'local'
                  ? initialSearch.current
                  : localAddress.search
                : (cloudFrame.search ?? initialSearch.current),
              backend === 'local'
                ? initial.active === 'local'
                  ? initialHash.current
                  : localAddress.hash
                : initialHash.current,
              cloudFrameOrigin(),
            )}
          />
        ),
      )}
    </main>
  )
}

export function mountBackendWorkbench(): void {
  syncWorkbenchAppearance()
  const root = document.getElementById('app-root')
  if (!root) throw new Error('missing #app-root')
  mountApplication(root, <BackendWorkbench />)
}
