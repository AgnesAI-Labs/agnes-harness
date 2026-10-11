import type { PackageInstalledDescriptor, PackageOperation } from '@agnes/protocol'
import { resolvePluginMetadata } from '@agnes/protocol'
import { Toast, useUiText } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'

export function PluginOperationFeedback({
  operation,
  installed,
}: {
  operation: PackageOperation | undefined
  installed: readonly PackageInstalledDescriptor[]
}) {
  const { t, locale } = useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const seen = useRef(operation?.operationId)
  const [message, setMessage] = useState('')
  const operationId = operation?.operationId
  const operationState = operation?.state
  useEffect(() => {
    if (!operation || operationState !== 'completed' || seen.current === operationId) return
    seen.current = operationId
    if (!['enable', 'disable', 'install', 'update', 'remove', 'rollback'].includes(operation.operation))
      return
    const item = installed.find((row) => row.id === operation.packageId)
    const name = resolvePluginMetadata(item?.metadata, locale)?.displayName ?? operation.packageId ?? ''
    setMessage(t('ux.success.' + operation.operation, { name }))
  }, [operationId, operationState, operation, installed, locale, t])
  return (
    <Toast open={!!message} onDismiss={() => setMessage('')}>
      {message}
    </Toast>
  )
}
