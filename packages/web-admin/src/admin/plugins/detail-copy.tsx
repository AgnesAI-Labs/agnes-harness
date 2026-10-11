import { Button, SettingsState, Toast, useUiText } from '@agnes/web-ui'
import { useState } from 'react'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'

export function PluginDetailCopy({ value }: { value: string }) {
  const { t } = useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <>
      <Button
        size="small"
        onClick={() => {
          setFailed(false)
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => setFailed(true))
          if (!navigator.clipboard) setFailed(true)
        }}
      >
        {t('ux.copy')}
      </Button>
      {failed && <SettingsState tone="error">{t('ux.copyFailed')}</SettingsState>}
      <Toast open={copied} onDismiss={() => setCopied(false)}>
        {t('ux.copied')}
      </Toast>
    </>
  )
}
