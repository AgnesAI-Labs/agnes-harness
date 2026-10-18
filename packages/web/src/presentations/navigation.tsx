import type { ClientContext } from '@agnes/web-client'
import type {} from '@agnes/web-units/shell'
import { bindNavigationHistory } from '../navigation-history.js'
import { mountSidebarRegion } from '../regions/sidebar.js'

/** Release-owned navigation renderer. State and navigation operations remain host projections. */
export function apply(ctx: ClientContext) {
  return ctx.presentationRoles.register({
    role: 'navigation',
    priority: 100,
    mount(ctx) {
      const port = ctx.presentation.navigation
      if (!port) return () => {}
      const stopHistory = bindNavigationHistory(port.history)
      const view = mountSidebarRegion(ctx.slots, port.container, port.initial, ctx.locale)
      const detach = port.attach(view)
      return () => {
        detach()
        view.dispose()
        stopHistory()
      }
    },
  })
}
