import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import type { PluginAdminPage } from './page.js'

/** All mutations continue through the existing review/confirmation and permission checks. */
export function projectedStatusAction(page: PluginAdminPage, item: PackageInstalledDescriptor) {
  const action = item.primaryStatus?.nextAction
  if (!action || action === 'none') return undefined
  const view = page.viewContext()
  if (action === 'trust' || action === 'enable')
    return {
      label: view.t('action.enable'),
      disabled:
        !view.canEffect('packages.activate') ||
        (!item.trusted && (!view.canEffect('packages.trust') || !item.capabilityHash)) ||
        view.packageBusy(item.id),
      run: () => page.confirmEnable(item),
    }
  return {
    label: view.t(`status.${action}`),
    disabled: view.packageBusy(item.id),
    run: async () => {
      if (action === 'restart') {
        page.configureConfirm({
          title: () => view.t('status.restartTitle'),
          description: () => view.t('status.restartHelp'),
          label: () => view.t('status.understood'),
          run: async () => {},
        })
        return
      }
      page.closeDetail()
      document.dispatchEvent(
        new CustomEvent('agnes:settings-page', {
          detail:
            action === 'install-dependency'
              ? 'discover'
              : action === 'configure-credential'
                ? 'security'
                : 'diagnostics',
        }),
      )
    },
  }
}

/** Catalog entries remain installation candidates, without an installed lifecycle projection. */
export function catalogPrimaryAction(page: PluginAdminPage, catalog: PackageCatalogDescriptor) {
  const view = page.viewContext()
  const installed = view.state.installed.some((candidate) => candidate.id === catalog.id)
  return {
    label:
      catalog.compatibility === 'unsupported'
        ? view.t('action.unsupported')
        : view.t(installed ? 'action.check-update' : 'action.check-install'),
    disabled:
      !view.canEffect('packages.install') ||
      catalog.compatibility === 'unsupported' ||
      (installed && view.packageBusy(catalog.id)) ||
      view.inspecting(catalog.id),
    run: async () => {
      await view.inspectCatalog(catalog)
    },
  }
}
