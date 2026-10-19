import type { PackageInstalledDescriptor, PackageOperation } from '@agnes/protocol'
import { resolvePluginMetadata } from '@agnes/protocol'
import { publishFeedback, resolveFeedback, useUiText } from '@agnes/web-ui'
import { useEffect, useRef } from 'react'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'

export function PluginOperationFeedback({
  operation,
  installed,
  onEnable,
}: {
  operation: PackageOperation | undefined
  installed: readonly PackageInstalledDescriptor[]
  onEnable?: (packageId: string) => void
}) {
  const { t, locale } = useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const initial = useRef(operation?.operationId)
  useEffect(() => {
    // The notice asks for an enable; once one is set, readiness shows on the plugin itself.
    for (const item of installed) if (item.desired === 'enabled') resolveFeedback(`plugin-enable:${item.id}`)
    if (operation?.state !== 'completed' || initial.current === operation.operationId) return
    const kind = operation.operation
    if (!['enable', 'disable', 'install', 'update', 'remove', 'rollback'].includes(kind)) return
    const item = installed.find((row) => row.id === operation.packageId)
    const name = resolvePluginMetadata(item?.metadata, locale)?.displayName ?? operation.packageId ?? ''
    const id = operation.packageId
    publishFeedback({
      id: operation.operationId,
      scope: `plugin-enable:${id}`,
      outcome: 'success',
      message: t(`ux.success.${kind}`, { name }),
      ...(kind === 'install' && id && onEnable && item?.desired !== 'enabled'
        ? {
            effect: {
              kind: 'enable-required' as const,
              message: t('review.enableRequired'),
              action: { label: t('review.enable'), onSelect: () => onEnable(id) },
            },
          }
        : {}),
    })
  }, [operation, installed, locale, t, onEnable])
  return null
}
