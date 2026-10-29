import type { LocaleTranslator } from '@agnes/web-ui'
import { $ } from './admin-dom.js'

/**
 * A page that hosts the controller outside the settings pane: it supplies the list and status
 * hosts and its own toolbar buttons, and draws no settings heading or navigation tabs.
 */
export type ResourceAdminSurface = Readonly<{
  list: HTMLElement
  notice: HTMLElement
  refresh: HTMLButtonElement
  create: HTMLButtonElement
}>

/** The settings pane's heading and navigation tabs follow the selected resource kind. */
export function renderSettingsChrome(tab: 'skills' | 'mcp', t: LocaleTranslator): void {
  const heading = document.querySelector<HTMLElement>('#resource-settings-pane h2')
  if (heading) {
    heading.closest<HTMLElement>('.config-heading')?.toggleAttribute('hidden', tab === 'skills')
    heading.textContent = t(`tab.${tab}`)
  }
  const addHint = document.querySelector<HTMLElement>(
    '#resource-settings-pane [data-testid="resource-add-hint"]',
  )
  if (addHint) addHint.hidden = true
  for (const [control, selected] of [
    [$('skills-tab', 'button'), tab === 'skills'],
    [$('mcp-tab', 'button'), tab === 'mcp'],
  ] as const) {
    if (control.getAttribute('role') === 'tab') {
      control.setAttribute('aria-selected', String(selected))
      control.tabIndex = selected ? 0 : -1
    } else {
      control.removeAttribute('aria-selected')
      control.setAttribute('aria-current', selected ? 'page' : 'false')
      control.tabIndex = 0
    }
  }
}
