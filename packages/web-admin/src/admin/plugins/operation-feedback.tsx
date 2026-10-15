import type { PackageInstalledDescriptor, PackageOperation } from '@agnes/protocol'
import { resolvePluginMetadata } from '@agnes/protocol'
import { Button, Toast, useUiText } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'

export function PluginOperationFeedback({
  operation,
  installed,
  onEnable,
}: {
  operation: PackageOperation | undefined
  installed: readonly PackageInstalledDescriptor[]
  /** Where a fresh install's 「去启用」 leads: the installed plugin's own page. */
  onEnable?: (packageId: string) => void
}) {
  const { t, locale } = useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const seen = useRef(operation?.operationId)
  const [message, setMessage] = useState<{ text: string; enable?: string }>()
  const operationId = operation?.operationId
  const operationState = operation?.state
  useEffect(() => {
    if (!operation || operationState !== 'completed' || seen.current === operationId) return
    seen.current = operationId
    if (!['enable', 'disable', 'install', 'update', 'remove', 'rollback'].includes(operation.operation))
      return
    const item = installed.find((row) => row.id === operation.packageId)
    const name = resolvePluginMetadata(item?.metadata, locale)?.displayName ?? operation.packageId ?? ''
    if (operation.operation === 'install' && onEnable && operation.packageId)
      setMessage({ text: t('review.installed', { name }), enable: operation.packageId })
    else setMessage({ text: t('ux.success.' + operation.operation, { name }) })
  }, [operationId, operationState, operation, installed, locale, t, onEnable])
  const enable = message?.enable
  return (
    <Toast open={!!message} {...(enable ? { duration: 6000 } : {})} onDismiss={() => setMessage(undefined)}>
      {message?.text}
      {enable && onEnable && (
        <>
          {' · '}
          <Button
            appearance="link"
            data-testid="install-toast-enable"
            onClick={() => {
              setMessage(undefined)
              onEnable(enable)
            }}
          >
            {t('review.enable')}
          </Button>
        </>
      )}
    </Toast>
  )
}
