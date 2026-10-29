import { preserveRouteParams, searchParamRoute } from '@agnes/web-ui'
import { type SettingsMoveTarget, settingsMoved, settingsRoute } from '@agnes/web-units/shell'

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
  const url = new URL(location.href)
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
  const url = new URL(location.href)
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
  const url = new URL(location.href)
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

/** Read the settings route, normalizing legacy page/anchor links without consuming it. */
export function consumeSettingsLink(): { id: string; anchor: string } {
  const address = searchParamRoute('settings')
  const levels = address.read()
  const requested = levels[0] ?? ''
  const route = settingsRoute(requested)
  const url = new URL(location.href)
  const subsection = url.hash.startsWith('#settings-subsection-')
  const anchor = requested ? (subsection ? url.hash.slice(1) : (route.anchor ?? '')) : ''
  if (requested) {
    const subpages = levels.slice(1)
    history.replaceState(history.state, '', address.href([route.id, ...subpages]))
  }
  if (subsection && !requested) {
    const normalized = new URL(location.href)
    normalized.hash = ''
    history.replaceState(history.state, '', normalized)
  }
  return { id: route.id, anchor }
}
