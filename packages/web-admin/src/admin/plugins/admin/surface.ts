import type { ReactNode } from 'react'
import { element } from './dom.js'
import type { PluginAdminViewContext } from './page.js'

/**
 * A page that hosts the plugin controller outside the settings pane. The controller keeps state,
 * operations and the shared dialogs; the surface draws the layout from each view it is handed.
 */
export type PluginPageSurface = Readonly<{
  host: HTMLElement
  render(view: PluginAdminViewContext): ReactNode
}>

/** The status hosts of the settings pane markup, which a page surface replaces with its own. */
export function settingsPaneHosts() {
  return {
    orphanPins: element('orphan-pins', 'section'),
    notice: element('admin-notice', 'p'),
    treeStatus: element('plugin-tree-status', 'p'),
    recovery: element('recovery-notice', 'section'),
    layout: element('plugin-layout', 'div'),
  }
}
