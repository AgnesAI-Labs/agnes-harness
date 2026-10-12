import { tr as t } from '@agnes/web-foundation/locale-bridge'
import { Button, mountApplication, useDocumentLanguage } from '@agnes/web-ui'
import { renderAppDialogs } from './app-dialogs.js'
import { SessionViews } from './regions/session-views.js'

/** React owns the page structure; controller views and plugin outlets are children via portals. */
export function AppShell() {
  useDocumentLanguage()
  return (
    <>
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
        className="sidebar"
        data-agnes-region="sidebar"
        aria-label={t('index-shell.sessionsNav')}
      ></aside>

      <main id="main-content" tabIndex={-1}>
        <header className="topbar" data-agnes-region="topbar"></header>

        <p id="notice" role="alert" />
        <p id="reconnect-notice" role="status" hidden />
        <div className="workbench-split">
          <div className="session-tabs-bar">
            <div id="workbench-controls"></div>
            <div id="session-goal-host" className="session-goal-host" />
            <div id="session-view-controls">
              <SessionViews />
            </div>
          </div>
          <div
            id="conversation-shell"
            className="conversation-shell"
            role="tabpanel"
            aria-labelledby="view-chat"
            data-agnes-region="conversation"
          ></div>
          <aside
            id="trace-panel"
            role="tabpanel"
            aria-labelledby="view-trace"
            data-agnes-region="trace"
            hidden
            aria-label={t('index-shell.tracePanel')}
          ></aside>
          <aside id="workbench-right" data-agnes-region="workbench-right" hidden>
            <div id="workbench-right-content"></div>
            <div id="workbench-plugin-panels"></div>
          </aside>
          <aside id="workbench-bottom" data-agnes-region="workbench-bottom" hidden>
            <div id="workbench-bottom-content"></div>
          </aside>
          <aside
            id="rightbar-panel"
            data-agnes-region="rightbar"
            hidden
            aria-label={t('index-shell.rightbarPanel')}
          ></aside>
        </div>

        <section id="approval" data-agnes-region="approval" hidden aria-live="polite"></section>
        <div id="composer-mount"></div>
      </main>

      <div id="agnes-overlay-container" />
      <div id="new-session-root" className="agnes-overlay-root"></div>

      <div id="first-run-root" className="agnes-overlay-root"></div>
      <div id="doctor-notice-root" className="agnes-overlay-root"></div>
      <dialog data-agnes-region="dialog" id="config" aria-labelledby="config-title"></dialog>

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
    </>
  )
}

export function mountAppShell(): () => void {
  const host = document.getElementById('app-root')
  if (!host) throw new Error('missing #app-root')
  const dispose = mountApplication(host, <AppShell />)
  renderAppDialogs()
  return dispose
}
