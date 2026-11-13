import {
  createSettingsController,
  type SettingsController,
  type SettingsControllerOptions,
} from '@agnes/web-admin/settings'
import { requestLocalManagement } from './frame-context.js'

/** Dialog shortcuts and account-error links follow the same local destination as the sidebar. */
export function routeLocalSettings(controller: SettingsController): SettingsController {
  return {
    ...controller,
    open: () =>
      requestLocalManagement({ kind: 'settings', section: 'model' }) ? Promise.resolve() : controller.open(),
    openAccount: (route) =>
      requestLocalManagement({ kind: 'settings', section: 'model' })
        ? Promise.resolve()
        : controller.openAccount(route),
  }
}

export function createLocalManagementSettings(options: SettingsControllerOptions): SettingsController {
  return routeLocalSettings(createSettingsController(options))
}
