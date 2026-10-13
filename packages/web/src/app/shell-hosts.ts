/**
 * The mount points and shell facts AppShell exposes to the controller layer.
 *
 * AppShell renders these elements; region roots mount into them. This module is the one place the
 * controller layer reads them, so app.ts composes controllers without touching the document.
 */

function host<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const found = document.getElementById(id)
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return found as HTMLElementTagNameMap[K]
}
const optional = (id: string): HTMLElement | undefined => document.getElementById(id) ?? undefined

/** Resolve once, after AppShell has committed. */
export function resolveShellHosts() {
  return {
    /** The daemon WebSocket address the server wrote into the page. */
    wsUrl: host('agnes-config', 'meta').dataset.ws,
    conversation: host('conversation-shell', 'div'),
    goal: host('session-goal-host', 'div'),
    newSession: host('new-session-root', 'div'),
    firstRun: host('first-run-root', 'div'),
    doctorNotice: host('doctor-notice-root', 'div'),
    viewChat: host('view-chat', 'button'),
    viewTrace: host('view-trace', 'button'),
    panels: optional('workbench-plugin-panels'),
    sidebar: document.querySelector<HTMLElement>('aside.sidebar') ?? undefined,
    topbar: document.querySelector<HTMLElement>('header .topbar') ?? undefined,
    approval: optional('approval'),
    composer: optional('composer-mount'),
    trace: optional('trace-panel'),
    rightbar: optional('rightbar-panel'),
    settings: optional('config'),
    dockControls: optional('workbench-controls'),
  }
}
export type ShellHosts = ReturnType<typeof resolveShellHosts>

/** Bring the pending approval into view and put focus on its first available decision. */
export function focusApproval(hosts: ShellHosts): void {
  hosts.approval?.scrollIntoView({ block: 'nearest' })
  hosts.approval?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}

/** Ask the open settings dialog to show one of its sections. */
export function routeSettings(section: string): void {
  document
    .getElementById('config-form')
    ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: section, bubbles: true }))
}

/** Whether the narrow-layout navigation drawer currently covers the workbench. */
export const sidebarDrawerOpen = (): boolean => document.body.classList.contains('sidebar-open')

/** Whether the archived-sessions settings pane is the one on screen. */
export const archivedSettingsShown = (): boolean =>
  document.getElementById('archived-settings-pane')?.hidden === false

/** Embedders may set data-model-refresh-interval-ms on <html>; invalid values use the default. */
export function modelRefreshInterval(): number | undefined {
  const value = Number(document.documentElement.dataset.modelRefreshIntervalMs)
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 2_147_483_647 ? value : undefined
}
