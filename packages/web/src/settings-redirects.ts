import { type SettingsMoveTarget, settingsMoved, settingsRoute } from '@agnes/web-units'

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
  history.replaceState(history.state, '', url)
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
    history.replaceState(history.state, '', url)
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
  if (url.hash.startsWith('#settings-subsection-')) url.hash = ''
  history.replaceState(history.state, '', url)
}

/**
 * Whether startup should point at settings: accounts exist but none serves a usable model. This is
 * a notice with an action; loading the page never opens the dialog by itself.
 */
export function needsModelNotice(state: { modelsRead: boolean; models: number; accounts: number }): boolean {
  return state.modelsRead && state.models === 0 && state.accounts > 0
}

/**
 * A settings link is followed once: read the page and subsection it names, then take both out of
 * the address, so a refresh shows the workbench instead of opening the dialog again. Other
 * fragments stay.
 */
export function consumeSettingsLink(): { id: string; anchor: string } {
  const url = new URL(location.href)
  const id = url.searchParams.get('settings') ?? ''
  const subsection = url.hash.startsWith('#settings-subsection-')
  const anchor = id && subsection ? url.hash.slice(1) : ''
  if (!url.searchParams.has('settings') && !subsection) return { id, anchor }
  url.searchParams.delete('settings')
  if (subsection) url.hash = ''
  history.replaceState(history.state, '', url)
  return { id, anchor }
}
