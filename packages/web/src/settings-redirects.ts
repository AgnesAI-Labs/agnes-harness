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
