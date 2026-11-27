import { preserveRouteParams, SETTINGS_ROUTE_EVENT, searchParamRoute } from '@agnes/web-ui'
import { type SettingsMoveTarget, settingsMoved, settingsRoute } from '@agnes/web-units/shell'
import { backendFrame, requestLocalManagement } from './backends/frame-context.js'
import { hasPendingCloudBoot, localLocationUrl } from './backends/local-workbench-bus.js'

export const isDeferredCloudSettings = (): boolean =>
  !backendFrame() && (hasPendingCloudBoot() || new URLSearchParams(location.search).has('remote'))

export function redirectFrameSettingsLink(
  section: string | null = new URLSearchParams(location.search).get('settings'),
): boolean {
  if (!backendFrame() || !section) return false
  const relayed = section === 'model/account' ? 'model' : section
  if (!requestLocalManagement({ kind: 'settings', section: relayed })) return false
  clearSettingsLink()
  return true
}

export function applySettingsSectionRoute(section: string): string {
  const [head = section, ...subpages] = section.split('/').filter(Boolean)
  if (subpages.length) {
    history.replaceState(
      history.state,
      '',
      searchParamRoute('settings').href([settingsRoute(head).id, ...subpages]),
    )
    window.dispatchEvent(new Event(SETTINGS_ROUTE_EVENT))
  }
  return head
}

/** The new home of the page an old `?settings=<id>` link names, when it left the settings dialog. */
export function movedSettingsTarget(id: string): SettingsMoveTarget | undefined {
  // The link's own name first: a consolidated ID (examples → discover) can have a home of its own.
  return settingsMoved(id) ?? settingsMoved(settingsRoute(id).id)
}

/**
 * Rewrite an old settings link that names a page which is now a full page: `?settings=schedules`
 * becomes `?page=automation&tab=schedules`. Runs before anything reads the address, so the home
 * routing opens the page as if the link had named it. Links to the session search and the archived
 * list keep their `settings` value: the caller opens those from the sidebar.
 */
export function rewriteMovedSettingsLink(): SettingsMoveTarget | undefined {
  if (isDeferredCloudSettings() || redirectFrameSettingsLink()) return undefined
  const url = localLocationUrl()
  const id = url.searchParams.get('settings')
  const target = id ? movedSettingsTarget(id) : undefined
  if (target?.kind !== 'page') return target
  url.searchParams.delete('settings')
  url.searchParams.set('page', target.page)
  if (target.tab) url.searchParams.set('tab', target.tab)
  else url.searchParams.delete('tab')
  if (url.hash.startsWith('#settings-subsection-')) url.hash = ''
  history.replaceState(history.state, '', preserveRouteParams(url))
  return target
}

/**
 * Open the sidebar target an old settings link names (`?settings=history`, `?settings=archived`)
 * and drop the stale value from the address. Returns whether the link was one of these.
 */
export function openMovedSettingsLink(
  id: string,
  actions: { searchSessions(): void; showArchived(): void },
): boolean {
  const target = movedSettingsTarget(id)
  if (!target || target.kind === 'page') return false
  if (target.kind === 'session-search') actions.searchSessions()
  else actions.showArchived()
  const url = localLocationUrl()
  if (url.searchParams.get('settings') === id) {
    url.searchParams.delete('settings')
    history.replaceState(history.state, '', preserveRouteParams(url))
  }
  return true
}

/** Open where a moved settings page lives now: a home page, the session search or the archived list. */
export function openMovedSettings(
  target: SettingsMoveTarget,
  actions: { openPage(page: string, tab?: string): void; searchSessions(): void; showArchived(): void },
): void {
  if (target.kind === 'page') actions.openPage(target.page, target.tab)
  else if (target.kind === 'session-search') actions.searchSessions()
  else actions.showArchived()
}

/**
 * Drop the settings page from the address once the dialog closes, so a refresh shows the workbench
 * instead of opening the dialog again.
 */
export function clearSettingsLink(): void {
  if (isDeferredCloudSettings()) return
  const url = localLocationUrl()
  if (!url.searchParams.has('settings')) return
  url.searchParams.delete('settings')
  url.searchParams.delete('account')
  if (url.hash.startsWith('#settings-subsection-')) url.hash = ''
  history.replaceState(history.state, '', preserveRouteParams(url))
}

/**
 * Whether startup should point at settings: accounts exist but none serves a usable model. This is
 * a notice with an action; loading the page never opens the dialog by itself.
 */
export function needsModelNotice(state: { modelsRead: boolean; models: number; accounts: number }): boolean {
  return state.modelsRead && state.models === 0 && state.accounts > 0
}

export function settingsLinkTarget(link: { id: string; anchor: string }): string {
  const anchored = link.anchor.replace(/^settings-subsection-/, '')
  const anchoredRoute = settingsRoute(anchored)
  return anchoredRoute.id === link.id && anchoredRoute.anchor === link.anchor ? anchored : link.id
}

export function resolveRestoredSettingsLink(
  close: () => void,
  openHome: (page: string, tab?: string) => void,
): { id: string; target: string } | undefined {
  if (redirectFrameSettingsLink()) {
    close()
    return undefined
  }
  const moved = rewriteMovedSettingsLink()
  if (moved?.kind === 'page') {
    close()
    openHome(moved.page, moved.tab)
    return undefined
  }
  const link = consumeSettingsLink()
  if (!link.id) {
    close()
    return undefined
  }
  return { id: link.id, target: settingsLinkTarget(link) }
}

/** Read the settings route, normalizing legacy page/anchor links without consuming it. */
export function consumeSettingsLink(): { id: string; anchor: string } {
  const deferred = isDeferredCloudSettings()
  const address = searchParamRoute('settings')
  const url = localLocationUrl()
  const levels = deferred
    ? (url.searchParams.get('settings')?.split('/').filter(Boolean) ?? [])
    : address.read()
  const requested = levels[0] ?? ''
  const route = settingsRoute(requested)
  const subsection = url.hash.startsWith('#settings-subsection-')
  const anchor = requested ? (subsection ? url.hash.slice(1) : (route.anchor ?? '')) : ''
  const currentHref = `${location.pathname}${location.search}${location.hash}`
  if (!deferred && requested) {
    const nextHref = address.href([route.id, ...levels.slice(1)])
    if (nextHref !== currentHref) history.replaceState(history.state, '', nextHref)
  }
  if (!deferred && subsection && !requested) {
    const normalized = localLocationUrl()
    normalized.hash = ''
    history.replaceState(history.state, '', normalized)
  }
  return { id: route.id, anchor }
}
