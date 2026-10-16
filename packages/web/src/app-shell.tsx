import { tr as t } from '@agnes/web-foundation/locale-bridge'
import {
  Button,
  mountApplication,
  RegionErrorBoundary,
  TopProgress,
  useDocumentLanguage,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { renderAppDialogs } from './app-dialogs.js'
import { AppNotice, ConnectionBar, ReadOnlyNotice } from './app-notices.js'
import { SessionReport, SessionViews } from './regions/session-views.js'

/** The elements AppShell renders for controller-owned regions to mount into. */
export type ShellHosts = {
  conversation: HTMLDivElement
  goal: HTMLDivElement
  newSession: HTMLDivElement
  firstRun: HTMLDivElement
  doctorNotice: HTMLDivElement
  viewChat: HTMLButtonElement
  viewTrace: HTMLButtonElement
  panels: HTMLDivElement
  sidebar: HTMLElement
  topbar: HTMLDivElement
  approval: HTMLElement
  composer: HTMLDivElement
  trace: HTMLElement
  rightbar: HTMLElement
  settings: HTMLDialogElement
  dockControls: HTMLDivElement
  homePage: HTMLElement
}
/** What the server and an embedder wrote into the page for the workbench to start with. */
export type ShellConfig = {
  /** The daemon WebSocket address. */
  wsUrl: string | undefined
}

/** React owns the page structure; controller views and plugin outlets are children via portals. */
export function AppShell({ children, hosts }: { children?: ReactNode; hosts?: Partial<ShellHosts> }) {
  useDocumentLanguage()
  // Each host is handed over as it commits, so no controller looks it up in the document.
  const hold =
    <K extends keyof ShellHosts>(key: K) =>
    (node: ShellHosts[K] | null): void => {
      if (hosts && node) hosts[key] = node
    }
  return (
    <>
      {/* The one progress indicator for page reads, driven by the request layer. */}
      <TopProgress />
      <a className="skip-link" href="#main-content">
        {t('index-shell.skip')}
      </a>
      <Button
        id="sidebar-backdrop"
        className="sidebar-backdrop"
        htmlType="button"
        aria-label={t('index-shell.closeNav')}
      ></Button>

      <aside
        ref={hold('sidebar')}
        className="sidebar"
        data-agnes-region="sidebar"
        aria-label={t('index-shell.sessionsNav')}
      ></aside>

      <main id="main-content" tabIndex={-1}>
        {/* One connection status for every surface in the main area, home pages included. */}
        <RegionErrorBoundary region="reconnect">
          <ConnectionBar />
        </RegionErrorBoundary>
        {/* One slim bar: the left part is the replaceable topbar unit, the right part the view controls. */}
        <header className="topbar-row" data-agnes-region="topbar">
          <div ref={hold('topbar')} className="topbar"></div>
          <div className="session-tabs-bar">
            <div id="session-view-controls">
              <RegionErrorBoundary region="topbar">
                <SessionViews chatRef={hold('viewChat')} traceRef={hold('viewTrace')} />
              </RegionErrorBoundary>
            </div>
            {/* Report first; the workbench stays next to the panel it opens. */}
            <div className="topbar-actions">
              <span className="topbar-report-anchor">
                <RegionErrorBoundary region="topbar">
                  <SessionReport />
                </RegionErrorBoundary>
                {/* Keep the Goal command/composer host; it has no topbar menu entry. */}
                <div ref={hold('goal')} id="session-goal-host" className="session-goal-host" />
              </span>
              <div ref={hold('dockControls')} id="workbench-controls"></div>
            </div>
          </div>
        </header>

        <RegionErrorBoundary region="notice">
          <AppNotice />
        </RegionErrorBoundary>
        <RegionErrorBoundary region="read-only">
          <ReadOnlyNotice />
        </RegionErrorBoundary>
        <section
          ref={hold('homePage')}
          id="home-page"
          className="home-page-host"
          data-agnes-region="home-page"
          hidden
        ></section>
        <div className="workbench-split">
          <div
            ref={hold('conversation')}
            id="conversation-shell"
            className="conversation-shell"
            role="tabpanel"
            aria-labelledby="view-chat"
            data-agnes-region="conversation"
          ></div>
          <aside
            ref={hold('trace')}
            id="trace-panel"
            role="tabpanel"
            aria-labelledby="view-trace"
            data-agnes-region="trace"
            hidden
            aria-label={t('index-shell.tracePanel')}
          ></aside>
          <aside id="workbench-right" data-agnes-region="workbench-right" hidden>
            <div id="workbench-right-content"></div>
            <div ref={hold('panels')} id="workbench-plugin-panels"></div>
          </aside>
          <aside id="workbench-bottom" data-agnes-region="workbench-bottom" hidden>
            <div id="workbench-bottom-content"></div>
          </aside>
          <aside
            ref={hold('rightbar')}
            id="rightbar-panel"
            data-agnes-region="rightbar"
            hidden
            aria-label={t('index-shell.rightbarPanel')}
          ></aside>
        </div>

        <section
          ref={hold('approval')}
          id="approval"
          data-agnes-region="approval"
          hidden
          aria-live="polite"
        ></section>
        <div ref={hold('composer')} id="composer-mount"></div>
      </main>

      <div id="agnes-overlay-container" className="agnes-overlay-root">
        <div ref={hold('newSession')} id="new-session-root" className="agnes-overlay-root"></div>

        <div ref={hold('firstRun')} id="first-run-root" className="agnes-overlay-root"></div>
        <div ref={hold('doctorNotice')} id="doctor-notice-root" className="agnes-overlay-root"></div>
        <dialog
          ref={hold('settings')}
          data-agnes-region="dialog"
          id="config"
          aria-labelledby="config-title"
        ></dialog>

        <dialog
          data-agnes-region="dialog"
          id="plugin-detail"
          className="plugin-detail"
          aria-label={t('index-shell.pluginDetailAria')}
        ></dialog>
        <dialog
          data-agnes-region="dialog"
          id="resource-detail"
          className="plugin-detail"
          aria-label={t('index-shell.resourceDetailAria')}
        ></dialog>

        <dialog data-agnes-region="dialog" id="source-dialog" aria-labelledby="source-dialog-title" />
        <dialog data-agnes-region="dialog" id="plugin-confirm" aria-labelledby="plugin-confirm-title" />
        <dialog data-agnes-region="dialog" id="mcp-dialog" aria-labelledby="mcp-dialog-title" />
        <dialog data-agnes-region="dialog" id="admin-confirm" aria-labelledby="admin-confirm-title" />
      </div>
      {children}
    </>
  )
}

const HOSTS = [
  'conversation',
  'goal',
  'newSession',
  'firstRun',
  'doctorNotice',
  'viewChat',
  'viewTrace',
  'panels',
  'sidebar',
  'topbar',
  'approval',
  'composer',
  'trace',
  'rightbar',
  'settings',
  'dockControls',
  'homePage',
] as const satisfies readonly (keyof ShellHosts)[]

/** Mount the one application shell and return the hosts it rendered and the page's start-up facts. */
export function mountAppShell(): { hosts: ShellHosts; config: ShellConfig; dispose(): void } {
  const host = document.getElementById('app-root')
  if (!host) throw new Error('missing #app-root')
  const hosts: Partial<ShellHosts> = {}
  const dispose = mountApplication(host, <AppShell hosts={hosts} />)
  renderAppDialogs()
  for (const key of HOSTS) if (!hosts[key]) throw new Error(`the application shell did not render ${key}`)
  return {
    hosts: hosts as ShellHosts,
    config: {
      wsUrl: document.querySelector<HTMLMetaElement>('meta#agnes-config')?.dataset.ws,
    },
    dispose,
  }
}
