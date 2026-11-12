import { remoteFrontendOrigin } from '@agnes/protocol'
import {
  applyFontScale,
  applyTheme,
  readFontScale,
  readThemePreference,
  resolveTheme,
  safeThemeStorage,
} from '@agnes/web-foundation/theme'
import { Button, Icon, mountApplication, useDocumentLanguage } from '@agnes/web-ui'
import type { SidebarHandle } from '@agnes/web-units/shell'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CLOUD_SETTINGS_SECTION, cloudConnectionAction } from './cloud-settings-bridge.js'
import {
  BACKEND_FRAME_COMMAND,
  BACKEND_FRAME_MESSAGE,
  type BackendCommand,
  type BackendId,
  type BackendSnapshot,
  backendSnapshot,
} from './frame-contract.js'
import { workbenchCatalog } from './workbench-locale.js'
import { WorkbenchSidebar } from './workbench-sidebar.js'
import {
  backendFrameSource,
  CLOUD_ORIGIN_KEY,
  cloudConnectionState,
  initialWorkbench,
  workbenchAddress,
} from './workbench-state.js'

function initialFrameSource(remote: string | undefined, selected: boolean, search: string): string {
  const url = new URL(backendFrameSource(remote), location.origin)
  if (selected)
    for (const [key, value] of new URLSearchParams(search)) {
      if (key !== 'remote' && key !== 'connection') url.searchParams.append(key, value)
    }
  return `${url.pathname}${url.search}`
}

function BackendWorkbench() {
  const [initial] = useState(() =>
    initialWorkbench(location.search, safeThemeStorage().getItem(CLOUD_ORIGIN_KEY)),
  )
  const [cloud, setCloud] = useState(initial.remote)
  const [active, setActive] = useState<BackendId>(initial.active)
  const [configure, setConfigure] = useState(initial.configure)
  const [states, setStates] = useState<Partial<Record<BackendId, BackendSnapshot>>>({})
  const [revisions, setRevisions] = useState({ local: 0, cloud: 0 })
  const sidebar = useRef<SidebarHandle>(null)
  const language = useDocumentLanguage()
  const catalog = workbenchCatalog[language === 'zh-CN' ? 'zh-CN' : 'en']
  const t = (key: keyof typeof catalog) => catalog[key]
  const frames = useRef<Partial<Record<BackendId, HTMLIFrameElement>>>({})
  const pending = useRef<Partial<Record<BackendId, { command: BackendCommand; commandId: string }>>>({})
  const intent = useRef<Partial<Record<BackendId, string>>>({})
  const latest = useRef({ active, cloud, states, configure })
  latest.current = { active, cloud, states, configure }
  const initialSearch = useRef(location.search)
  const setAddress = useCallback((backend: BackendId, sessionId?: string) => {
    const href = workbenchAddress(backend, latest.current.cloud, sessionId)
    if (`${location.pathname}${location.search}` !== href) history.replaceState({}, '', href)
  }, [])
  const send = useCallback(
    (backend: BackendId, command: BackendCommand) => {
      if (backend === 'cloud' && !latest.current.cloud) {
        setConfigure(true)
        return
      }
      if (command.kind !== 'more' && command.kind !== 'refresh') {
        setActive(backend)
        latest.current.active = backend
        setConfigure(false)
        sidebar.current?.close()
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
          location.origin,
        )
    },
    [setAddress],
  )
  const select = useCallback(
    (backend: BackendId, sessionId?: string) => {
      if (sessionId) {
        send(backend, { kind: 'session', sessionId })
        return
      }
      setActive(backend)
      latest.current.active = backend
      setConfigure(false)
      sidebar.current?.close()
      setAddress(backend, latest.current.states[backend]?.selected)
    },
    [send, setAddress],
  )
  const connect = useCallback(
    (value: string, activate = true) => {
      const next = remoteFrontendOrigin(value)
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
      } else if (!latest.current.states.cloud?.connected) {
        setStates((current) => {
          const { cloud: _previous, ...rest } = current
          return rest
        })
        setRevisions((current) => ({ ...current, cloud: current.cloud + 1 }))
      }
      if (activate) select('cloud')
    },
    [select],
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
    safeThemeStorage().removeItem(CLOUD_ORIGIN_KEY)
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
      if (event.origin !== location.origin) return
      const backend = (['local', 'cloud'] as const).find(
        (id) => frames.current[id]?.contentWindow === event.source,
      )
      if (
        !backend ||
        (backend === 'cloud' && frames.current.cloud?.dataset.backendOrigin !== latest.current.cloud)
      )
        return
      const action = cloudConnectionAction(event.data)
      if (action) {
        if (action.action === 'connect') connect(action.origin, false)
        else if (action.action === 'disconnect') disconnect()
        else if (latest.current.cloud) retry('cloud')
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
            location.origin,
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
      } else if (event.data?.type === BACKEND_FRAME_MESSAGE && event.data.kind === 'environment') {
        if (typeof event.data.remote === 'string') connect(event.data.remote)
        else select('local')
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [connect, disconnect, retry, select, setAddress])
  useEffect(() => {
    const state = cloudConnectionState(cloud, states.cloud)
    for (const frame of Object.values(frames.current))
      frame.contentWindow?.postMessage(
        { type: BACKEND_FRAME_MESSAGE, kind: 'cloud-state', state },
        location.origin,
      )
  }, [cloud, states])
  useEffect(() => {
    if (configure && states.local?.ready) send('local', { kind: 'settings', section: CLOUD_SETTINGS_SECTION })
  }, [configure, states.local?.ready, send])
  useEffect(() => {
    if (cloud) safeThemeStorage().setItem(CLOUD_ORIGIN_KEY, cloud)
  }, [cloud])
  const activeTitle =
    active === 'local' ? t('localShort') : `${t('cloudShort')} · ${cloud ? new URL(cloud).host : ''}`
  return (
    <>
      <Button id="sidebar-backdrop" className="sidebar-backdrop" aria-label={t('menu')} />
      <WorkbenchSidebar
        ref={sidebar}
        active={active}
        {...(cloud ? { cloud } : {})}
        states={states}
        t={t}
        select={select}
        command={send}
        configure={() => {
          setConfigure(true)
          sidebar.current?.close()
        }}
      />
      <main className="backend-workbench-main">
        <header className="backend-workbench-toolbar">
          <Button id="sidebar-toggle" className="sidebar-toggle" appearance="ghost" aria-label={t('menu')}>
            <Icon name="menu" />
          </Button>
          <span role="status" aria-label={t('activeBackend')}>
            {activeTitle}
          </span>
        </header>
        <div className="backend-workbench-contexts">
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
                hidden={active !== backend}
                src={initialFrameSource(
                  backend === 'cloud' ? cloud : undefined,
                  initial.active === backend && (backend === 'local' || cloud === initial.remote),
                  initialSearch.current,
                )}
              />
            ),
          )}
        </div>
      </main>
    </>
  )
}

export function mountBackendWorkbench(): void {
  const storage = safeThemeStorage()
  const sync = () => {
    document.documentElement.lang =
      storage.getItem('agnes-locale') ?? (navigator.language.startsWith('zh') ? 'zh-CN' : 'en')
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
