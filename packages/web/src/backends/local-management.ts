import {
  createSettingsController,
  type SettingsController,
  type SettingsControllerOptions,
} from '@agnes/web-admin/settings'
import { settingsRoute } from '@agnes/web-units/shell'
import { isDeferredCloudSettings, redirectFrameSettingsLink } from '../settings-redirects.js'
import { backendFrame, requestLocalManagement } from './frame-context.js'

/** Dialog shortcuts and account-error links follow the same local destination as the sidebar. */
export function routeLocalSettings(
  controller: SettingsController,
): SettingsController & { open(section?: string): Promise<void> } {
  return {
    ...controller,
    open: (section: string = 'model') =>
      redirectFrameSettingsLink(section) || requestLocalManagement({ kind: 'settings', section })
        ? Promise.resolve()
        : controller.open(),
    openAccount: (route) =>
      redirectFrameSettingsLink('model') || requestLocalManagement({ kind: 'settings', section: 'model' })
        ? Promise.resolve()
        : controller.openAccount(route),
  }
}

export function createLocalManagementSettings(
  options: SettingsControllerOptions,
): ReturnType<typeof routeLocalSettings> {
  let pendingSection: string | undefined
  const withSection = <T>(section: string, work: () => T): T => {
    const previous = pendingSection
    pendingSection = section
    try {
      return work()
    } finally {
      pendingSection = previous
    }
  }
  const routed = routeLocalSettings(
    createSettingsController({
      ...options,
      beforeOpen: () =>
        isDeferredCloudSettings() ||
        redirectFrameSettingsLink(
          pendingSection ?? (new URLSearchParams(location.search).get('settings') || 'model'),
        ),
    }),
  )
  return {
    ...routed,
    open: (section: string = 'model') =>
      withSection(section, () => {
        if (!isDeferredCloudSettings() && !(backendFrame() && section.split('/')[0] !== 'diagnostics')) {
          const form = document.getElementById('config-form')
          if (form) form.dataset.settingsSection = settingsRoute(section.split('/')[0] || section).id
        }
        return routed.open(section)
      }),
    openAccount: (route) => withSection('model', () => routed.openAccount(route)),
  }
}
