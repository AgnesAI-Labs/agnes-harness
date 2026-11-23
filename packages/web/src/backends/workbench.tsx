import { remoteFrontendOrigin } from '@agnes/protocol'
import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import {
  Button,
  cancelDialogHost,
  Icon,
  mountApplication,
  releaseDialogModal,
  useDocumentLanguage,
} from '@agnes/web-ui'
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { watchCloudBackendRecovery } from './cloud-recovery.js'
import { CLOUD_SETTINGS_SECTION, type CloudConnectionAction } from './cloud-settings-bridge.js'
import { backendFrame, cloudFrameOrigin } from './frame-context.js'
import {
  BACKEND_FRAME_COMMAND,
  type BackendCommand,
  type BackendId,
  type BackendSnapshot,
  commandBackend,
} from './frame-contract.js'
import {
  applyWorkbenchAddress,
  consumeWorkbenchBoot,
  executeLocalBackendCommand,
  installWorkbenchHistory,
  installWorkbenchStorageSync,
  localCloudSettings,
  localSidebarProjection,
  receiveCloudFrameMessage,
  registerWorkbenchController,
  restoreWorkbenchPopstate,
  setCurrentLocalRoute,
  setLocalWorkbenchHost,
} from './local-workbench-bus.js'
import { workbenchCatalog } from './workbench-locale.js'
import {
  CLOUD_DISCOVERY_KEY,
  CLOUD_ORIGIN_KEY,
  cloudConnectionState,
  cloudFrameSource,
  errorCloudSnapshot,
  isNarrowSidebarOpen,
  isSharedCloudOrigin,
  observeNarrowSidebarOpen,
  sessionFrameSearch,
} from './workbench-state.js'

const ownsShared = (following: boolean, origin?: string) =>
  following && isSharedCloudOrigin(origin, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY))

export function CloudWorkbenchStage({ children }: { children?: ReactNode } = {}) {
  const [boot] = useState(consumeWorkbenchBoot)
  const { initial } = boot
  const followingShared = useRef(
    !new URLSearchParams(boot.initialSearch).has('remote') ||
      isSharedCloudOrigin(initial.remote, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY)),
  )
  const [cloud, setCloud] = useState(initial.remote)
  const [active, setActive] = useState<BackendId>(initial.active)
  const [configure, setConfigure] = useState(initial.configure)
  const [configurationError, setConfigurationError] = useState('')
  const [candidateError, setCandidateError] = useState('')
  const [credentialOptions, setCredentialOptions] = useState<{ id: string; label: string }[]>()
  const [credentialError, setCredentialError] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [states, setStates] = useState<Partial<Record<BackendId, BackendSnapshot>>>({})
  const [cloudFrame, setCloudFrame] = useState({
    revision: 0,
    search: undefined as string | undefined,
    retired: false,
  })
  const [sidebarOpen, setSidebarOpen] = useState(isNarrowSidebarOpen)
  const credentialRequest = useRef<AbortController | undefined>(undefined)
  const connectionRevision = useRef(0)
  const [connectionEpoch, setConnectionEpoch] = useState(0)
  const connectionIntent = useRef<string | undefined>(undefined)
  const rotatedActiveRef = useRef<string | undefined>(undefined)
  const lastHandledGen = useRef(new Map<string, string>())
  const connectionRequest = useRef<AbortController | undefined>(undefined)
  const abortFrameAuth = useRef<(() => void) | undefined>(undefined)
  const cloudFrameRef = useRef<HTMLIFrameElement | undefined>(undefined)
  const pendingCloud = useRef<{ command: BackendCommand; commandId: string } | undefined>(undefined)
  const cloudSelection = useRef({
    session: initial.active === 'cloud' ? initial.session : undefined,
    awaiting: initial.active === 'cloud' && initial.session !== undefined,
  })
  const diagnosticsBackend = useRef<BackendId>(initial.active)
  const localRoute = useRef(boot.localRoute)
  const coalesceNextLocalPush = useRef(false)
  const suspendingOverlays = useRef(false)
  const latest = useRef({ active, cloud, states, configure })
  latest.current = { active, cloud, states, configure }
  const language = useDocumentLanguage()
  const catalog = workbenchCatalog[language === 'zh-CN' ? 'zh-CN' : 'en']
  const t = useCallback((key: keyof typeof catalog) => catalog[key], [catalog])

  useLayoutEffect(() => {
    setCurrentLocalRoute(localRoute.current)
  }, [])

  useLayoutEffect(() => {
    setLocalWorkbenchHost(true)
    return () => setLocalWorkbenchHost(false)
  }, [])

  useLayoutEffect(() => {
    if (active === 'cloud' && cloud) {
      document.body.dataset.aghActiveBackend = 'cloud'
      suspendingOverlays.current = true
      try {
        for (const dialog of document.querySelectorAll<HTMLDialogElement>(
          '#agnes-overlay-container dialog[open]',
        )) {
          cancelDialogHost(dialog)
          if (dialog.open) releaseDialogModal(dialog)
        }
      } finally {
        suspendingOverlays.current = false
      }
    } else delete document.body.dataset.aghActiveBackend
    return () => {
      delete document.body.dataset.aghActiveBackend
    }
  }, [active, cloud])

  useEffect(
    () =>
      observeNarrowSidebarOpen((open) => {
        setSidebarOpen(open)
        cloudFrameRef.current?.toggleAttribute('inert', open)
      }),
    [],
  )

  const loadCredentials = useCallback(() => {
    credentialRequest.current?.abort()
    const request = new AbortController()
    credentialRequest.current = request
    const deadline = setTimeout(() => request.abort(), 15_000)
    void new CredentialsApi()
      .list(request.signal)
      .then((items) => {
        if (request.signal.aborted) return
        setCredentialOptions(items.map(({ id, label }) => ({ id, label })))
        setCredentialError(false)
      })
      .catch(() => {
        if (request.signal.aborted && credentialRequest.current !== request) return
        setCredentialOptions([])
        setCredentialError(true)
      })
      .finally(() => clearTimeout(deadline))
  }, [])

  useEffect(() => () => credentialRequest.current?.abort(), [])
  useEffect(() => () => connectionRequest.current?.abort(), [])
  useEffect(
    () =>
      installCloudFrameAuthorization(
        () => ({ remote: latest.current.cloud, frame: cloudFrameRef.current }),
        (abort) => {
          abortFrameAuth.current = abort
        },
      ),
    [],
  )

  const setAddress = useCallback((backend: BackendId, sessionId?: string, push = false) => {
    applyWorkbenchAddress(backend, latest.current.cloud, localRoute.current, sessionId, push)
  }, [])

  const sendCloud = useCallback((command: BackendCommand) => {
    const frame = cloudFrameRef.current
    const entry = { command, commandId: crypto.randomUUID() }
    pendingCloud.current = entry
    if (frame?.contentWindow && latest.current.states.cloud?.ready)
      frame.contentWindow.postMessage(
        { type: BACKEND_FRAME_COMMAND, ...command, commandId: entry.commandId },
        new URL(frame.src, location.origin).origin,
      )
  }, [])

  const select = useCallback(
    (
      backend: BackendId,
      {
        keepSidebar = false,
        restoring = false,
        management = false,
      }: { keepSidebar?: boolean; restoring?: boolean; management?: boolean } = {},
    ) => {
      if (backend === 'cloud' && !latest.current.cloud) {
        setConfigure(true)
        latest.current.configure = true
        executeLocalBackendCommand({ kind: 'settings', section: CLOUD_SETTINGS_SECTION })
        return
      }
      if (!management) diagnosticsBackend.current = backend
      const switching = latest.current.active !== backend
      if (backend === 'cloud' && latest.current.cloud) document.body.dataset.aghActiveBackend = 'cloud'
      else delete document.body.dataset.aghActiveBackend
      setActive(backend)
      latest.current.active = backend
      setConfigure(false)
      latest.current.configure = false
      if (!keepSidebar && window.matchMedia('(max-width: 900px)').matches)
        document.body.classList.remove('sidebar-open')
      const selected =
        backend === 'cloud' ? cloudSelection.current.session : latest.current.states.local?.selected
      setAddress(backend, selected, switching && !restoring)
      if (switching && backend === 'local' && !management && !restoring)
        executeLocalBackendCommand({ kind: 'restore-local-route', route: localRoute.current })
    },
    [setAddress],
  )

  const send = useCallback(
    (backend: BackendId, command: BackendCommand, restoring = false) => {
      backend = commandBackend(backend, command)
      if (backend === 'cloud' && !latest.current.cloud) {
        setConfigure(true)
        latest.current.configure = true
        executeLocalBackendCommand({ kind: 'settings', section: CLOUD_SETTINGS_SECTION })
        return
      }
      const switching = latest.current.active !== backend
      const changesCloudSession =
        backend === 'cloud' && (command.kind === 'session' || command.kind === 'new')
      const localManagement =
        switching && backend === 'local' && (command.kind === 'settings' || command.kind === 'home')
      if (
        changesCloudSession ||
        (backend === 'local' && (command.kind === 'session' || command.kind === 'new'))
      )
        diagnosticsBackend.current = backend
      if (backend === 'cloud') {
        if (command.kind !== 'more' && command.kind !== 'refresh') {
          if (latest.current.cloud) document.body.dataset.aghActiveBackend = 'cloud'
          setActive('cloud')
          latest.current.active = 'cloud'
          setConfigure(false)
          latest.current.configure = false
          if (window.matchMedia('(max-width: 900px)').matches) document.body.classList.remove('sidebar-open')
          if (switching && !restoring && !changesCloudSession)
            setAddress('cloud', cloudSelection.current.session, true)
        }
        if (changesCloudSession) {
          const sessionId = command.kind === 'session' ? command.sessionId : ''
          cloudSelection.current = { session: sessionId, awaiting: true }
          if (!restoring) setAddress('cloud', sessionId, true)
        }
        sendCloud(command)
        return
      }
      if (localManagement) {
        delete document.body.dataset.aghActiveBackend
        setActive('local')
        latest.current.active = 'local'
        setConfigure(false)
        latest.current.configure = false
        setAddress('local', undefined, true)
        coalesceNextLocalPush.current = true
        queueMicrotask(() => {
          coalesceNextLocalPush.current = false
        })
      } else if (command.kind !== 'more' && command.kind !== 'refresh') {
        delete document.body.dataset.aghActiveBackend
        setActive('local')
        latest.current.active = 'local'
        setConfigure(false)
        latest.current.configure = false
        if (switching && !restoring) setAddress('local', undefined, true)
      }
      executeLocalBackendCommand(command)
    },
    [sendCloud, setAddress],
  )

  const clearCloudFrame = useCallback(() => {
    abortFrameAuth.current?.()
    cloudFrameRef.current = undefined
    pendingCloud.current = undefined
    const { cloud: _previous, ...rest } = latest.current.states
    latest.current.states = rest
    setStates((current) => {
      const { cloud: _previous, ...other } = current
      return other
    })
  }, [])

  const retireCloudFrame = useCallback(
    (error?: string) => {
      clearCloudFrame()
      if (error) {
        const snapshot = errorCloudSnapshot(error)
        latest.current.states = { ...latest.current.states, cloud: snapshot }
        setStates((current) => ({ ...current, cloud: snapshot }))
      }
      setCloudFrame((current) => ({ ...current, revision: current.revision + 1, retired: true }))
    },
    [clearCloudFrame],
  )

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
      let timedOut = false
      let succeeded = false
      let candidateFailure = preservedError
      const deadline = setTimeout(() => {
        timedOut = true
        request.abort()
      }, 30_000)
      setDiscovering(true)
      setConfigurationError('')
      setCandidateError(preservedError ?? '')
      let next: string
      let ownsSharedNow = !automatic
      try {
        const items =
          credentialRef === undefined ? undefined : await new CredentialsApi().list(request.signal)
        if (timedOut) throw Error('CLOUD_DISCOVERY_TIMEOUT')
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
        const canApply = () => {
          ownsSharedNow =
            !automatic || (ownedSharedBefore && ownsShared(followingShared.current, initialCloud))
          return !(
            timedOut ||
            revision !== connectionRevision.current ||
            request.signal.aborted ||
            (credentialRef !== undefined && readCloudCredentialGeneration(credentialRef) !== initialGen) ||
            (automatic &&
              (!initialCloud ||
                latest.current.cloud !== initialCloud ||
                readCloudCredentialRef(initialCloud) !== credentialRef ||
                (ownedSharedBefore && !ownsSharedNow)))
          )
        }
        next =
          value === undefined
            ? await discoverCloudOrigin(credentialRef ?? '', request.signal, undefined, canApply)
            : remoteFrontendOrigin(value)
        if (timedOut) throw Error('CLOUD_DISCOVERY_TIMEOUT')
        if (!canApply()) return
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
          executeLocalBackendCommand({ kind: 'settings', section: CLOUD_SETTINGS_SECTION })
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
        if (revision === connectionRevision.current && (!request.signal.aborted || timedOut)) {
          const failure = timedOut
            ? 'CLOUD_DISCOVERY_TIMEOUT'
            : error instanceof Error && error.message.startsWith('CLOUD_')
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
              retireCloudFrame(failure)
            }
            setConfigurationError(failure)
          } else {
            candidateFailure = failure
            setCandidateError(failure)
          }
        }
      } finally {
        clearTimeout(deadline)
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

  const handleCloudAction = useCallback(
    (action: CloudConnectionAction) => {
      if (action.action === 'connect') void connect(action.origin, false, action.credentialRef)
      else if (action.action === 'credential-replaced') {
        const remote = latest.current.cloud
        const ref = action.credentialRef
        const gen = action.generation
          ? (recordCloudCredentialGeneration(ref, action.generation), readCloudCredentialGeneration(ref))
          : bumpCloudCredentialGeneration(ref)
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
    },
    [connect, disconnect, loadCredentials, restartCloudFrame, retireCloudFrame, send],
  )

  useLayoutEffect(
    () =>
      registerWorkbenchController({
        select: (backend, options) => select(backend, options),
        command: (backend, command) => send(backend, command),
        cloudAction: handleCloudAction,
        routeDiagnostics: (section) => {
          if (diagnosticsBackend.current !== 'cloud' || !latest.current.cloud) return false
          send('cloud', { kind: 'settings', section })
          return true
        },
        localSnapshot: (snapshot) => {
          latest.current.states = { ...latest.current.states, local: snapshot }
          setStates((current) => ({ ...current, local: snapshot }))
        },
      }),
    [handleCloudAction, select, send],
  )

  useLayoutEffect(
    () =>
      installWorkbenchHistory({
        suspending: () => suspendingOverlays.current,
        diagnosticsCloud: () => diagnosticsBackend.current === 'cloud' && Boolean(latest.current.cloud),
        cloudActive: () => latest.current.active === 'cloud' && Boolean(latest.current.cloud),
        localRoute,
        coalesceNextPush: coalesceNextLocalPush,
        onCloudDiagnostics: (section) => send('cloud', { kind: 'settings', section }),
      }),
    [send],
  )

  useEffect(() => {
    const receive = (event: MessageEvent) =>
      receiveCloudFrameMessage(event, {
        frame: cloudFrameRef.current,
        cloud: latest.current.cloud,
        activeCloud: latest.current.active === 'cloud' && !latest.current.configure,
        pending: pendingCloud,
        selection: cloudSelection,
        onCommand: (backend, command) => send(backend, command),
        onSnapshot: (snapshot) => {
          setStates((current) => ({ ...current, cloud: snapshot }))
          latest.current.states = { ...latest.current.states, cloud: snapshot }
        },
        onAddress: (session) => setAddress('cloud', session),
        onError: (error) =>
          setStates((current) => ({
            ...current,
            cloud: errorCloudSnapshot(error, current.cloud?.rows),
          })),
      })
    const restoreAddress = () =>
      restoreWorkbenchPopstate({
        cloud: () => latest.current.cloud,
        localRoute,
        selectCloud: () => select('cloud', { restoring: true }),
        sendCloudSession: (session) =>
          send('cloud', session ? { kind: 'session', sessionId: session } : { kind: 'new' }, true),
        activateLocal: () => {
          delete document.body.dataset.aghActiveBackend
          diagnosticsBackend.current = 'local'
          setActive('local')
          latest.current.active = 'local'
        },
      })
    window.addEventListener('message', receive)
    window.addEventListener('popstate', restoreAddress)
    return () => {
      window.removeEventListener('message', receive)
      window.removeEventListener('popstate', restoreAddress)
    }
  }, [select, send, setAddress])

  const restoredCloud = useRef(false)
  useEffect(() => {
    if (restoredCloud.current || !states.local?.ready) return
    restoredCloud.current = true
    const ref = safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY)
    if (
      !new URLSearchParams(boot.initialSearch).has('remote') &&
      ref &&
      ownsShared(followingShared.current, cloud) &&
      cloud &&
      readCloudCredentialRef(cloud) === ref
    )
      void connect(undefined, false, ref, true)
  }, [boot.initialSearch, cloud, connect, states.local?.ready])

  useEffect(
    () =>
      installWorkbenchStorageSync({
        cloud: () => latest.current.cloud,
        followingShared: () => followingShared.current,
        handledGen: lastHandledGen,
        onReplaced: (credentialRef, generation) =>
          handleCloudAction({ action: 'credential-replaced', credentialRef, generation }),
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
          if (!bound) retireCloudFrame('CLOUD_CREDENTIAL_REQUIRED')
          else restartCloudFrame()
        },
      }),
    [
      cancelPendingConnect,
      clearCloudFrame,
      handleCloudAction,
      restartCloudFrame,
      retireCloudFrame,
      select,
      setAddress,
    ],
  )

  useEffect(() => {
    const credentialRef = cloud ? readCloudCredentialRef(cloud) : undefined
    const displayedError = configurationError || candidateError
    localCloudSettings.publish({
      ...cloudConnectionState(cloud, states.cloud),
      ...(discovering
        ? { status: 'connecting' }
        : configurationError && !states.cloud?.connected
          ? { status: 'error' }
          : {}),
      ...(credentialRef ? { credentialRef } : {}),
      ...(credentialOptions ? { credentialOptions } : {}),
      credentialError,
      ...(displayedError ? { error: displayedError } : {}),
    })
  }, [candidateError, cloud, configurationError, credentialError, credentialOptions, discovering, states])

  useEffect(() => {
    if (configure && states.local?.ready) send('local', { kind: 'settings', section: CLOUD_SETTINGS_SECTION })
  }, [configure, send, states.local?.ready])

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
    const ref = readCloudCredentialRef(cloud)
    if (!ref) return
    if (connectionIntent.current && connectionIntent.current !== ref) return
    const managed = safeThemeStorage().getItem(CLOUD_DISCOVERY_KEY) === ref
    const revision = connectionEpoch
    const canWatch = () =>
      connectionRevision.current === revision &&
      latest.current.cloud === cloud &&
      readCloudCredentialRef(cloud) === ref
    return watchCloudBackendRecovery({
      cloud,
      credentialRef: ref,
      managed,
      canWatch,
      onRecovered: (origin) => void connect(origin, false, ref, true),
      onFailed: (reason) => {
        if (connectionRevision.current === revision && latest.current.cloud === cloud)
          setConfigurationError(reason)
      },
    })
  }, [cloud, cloudConnected, configurationError, connect, connectionEpoch, discovering])

  useLayoutEffect(() => {
    localSidebarProjection.publish({ active, ...(cloud ? { cloud } : {}), states })
    return () => localSidebarProjection.publish(undefined)
  }, [active, cloud, states])

  if (!cloud || backendFrame()) return <>{children}</>
  return (
    <>
      <section className="backend-cloud-stage" hidden={active !== 'cloud'}>
        {active === 'cloud' && !sidebarOpen && (
          <Button
            className="backend-cloud-menu"
            appearance="ghost"
            aria-label={t('menu')}
            onClick={() => document.getElementById('sidebar-toggle')?.click()}
          >
            <Icon name="menu" />
          </Button>
        )}
        {!cloudFrame.retired && (
          <iframe
            key={`cloud:${cloud}:${cloudFrame.revision}`}
            ref={(node) => {
              if (node) {
                cloudFrameRef.current = node
                node.toggleAttribute('inert', sidebarOpen)
              } else cloudFrameRef.current = undefined
            }}
            title={t('cloud')}
            className="backend-workbench-frame"
            data-agh-backend-frame="1"
            data-backend-origin={cloud}
            data-testid="backend-frame-cloud"
            allow="clipboard-write"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
            hidden={active !== 'cloud' || sidebarOpen}
            src={cloudFrameSource(
              cloud,
              cloudFrame.search !== undefined || (initial.active === 'cloud' && cloud === initial.remote),
              cloudFrame.search ?? boot.initialSearch,
              cloudFrameOrigin(),
            )}
          />
        )}
      </section>
      {children}
    </>
  )
}

export function mountBackendWorkbench(): void {
  syncWorkbenchAppearance()
  const root = document.getElementById('app-root')
  if (!root) throw new Error('missing #app-root')
  mountApplication(root, <CloudWorkbenchStage />)
}
