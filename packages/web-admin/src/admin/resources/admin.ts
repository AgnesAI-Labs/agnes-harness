import type { ResourceAdminMount, ResourceAdminOptions } from '@agnes/resource-control-web/admin'
import { tr } from '@agnes/web-foundation/locale-bridge'

export type { ResourceAdminMount, ResourceAdminOptions } from '@agnes/resource-control-web/admin'
/** Host owns the settings IA; the public resource controller owns operations and state. */
export function adaptResourceAdmin(
  mounted: ResourceAdminMount,
  options: ResourceAdminOptions = {},
): ResourceAdminMount {
  const describe = (tab: 'skills' | 'mcp' = 'skills') => {
    const subtitle = document.querySelector<HTMLElement>('#resource-settings-pane > .config-heading p')
    if (!subtitle) return
    const key = tab === 'skills' ? 'resources.skillsDescription' : 'resources.mcpDescription'
    subtitle.dataset.i18n = key
    subtitle.textContent = tr(key)
  }
  describe(options.tab)
  return {
    ...mounted,
    setTab(tab) {
      mounted.setTab(tab)
      describe(tab)
    },
    async sync(scope, settings) {
      await mounted.sync(scope, settings)
      describe(scope.tab)
    },
  }
}
