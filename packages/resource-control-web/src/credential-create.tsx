import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
import { Banner, Button, useUiText } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { CredentialEditor } from './credential-editor.js'
import {
  type CredentialFailure,
  CredentialsApi,
  credentialFailure,
  credentialWriteFailure,
} from './credentials-api.js'
import { credentialsCatalog } from './credentials-locale.js'

/**
 * Creates one credential where a form needs it. The write permission is checked first; the editor keeps
 * the value write-only and the caller receives metadata only, to select the new reference.
 */
export function CredentialCreate({
  onCreated,
  testId = 'credential-create',
  banner = false,
  dismissOn,
}: {
  onCreated(item: AdminCredentialMetadata): void
  testId?: string
  /** Also explain a blocked write below the button, not only on the disabled button. */
  banner?: boolean
  /** An element whose `close` event discards an open editor, such as the hosting native dialog. */
  dismissOn?: () => EventTarget | null | undefined
}) {
  const { t } = useUiText('@agnes/credentials', credentialsCatalog)
  const [api] = useState(() => new CredentialsApi())
  const [open, setOpen] = useState(false)
  const [blocked, setBlocked] = useState<CredentialFailure | undefined>('unavailable')
  useEffect(() => {
    const abort = new AbortController()
    void api
      .context(abort.signal)
      .then((context) => {
        if (!abort.signal.aborted) setBlocked(credentialWriteFailure(context))
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setBlocked(credentialFailure(cause))
      })
    return () => abort.abort()
  }, [api])
  useEffect(() => {
    const target = dismissOn?.()
    const close = () => setOpen(false)
    target?.addEventListener('close', close)
    return () => target?.removeEventListener('close', close)
  }, [dismissOn])
  return (
    <>
      <Button
        data-testid={testId}
        disabled={!!blocked}
        {...(blocked ? { disabledReason: t(`error.${blocked}`) } : {})}
        onClick={() => setOpen(true)}
      >
        {t('create')}
      </Button>
      {banner && blocked && <Banner tone="warning">{t(`error.${blocked}`)}</Banner>}
      {open && (
        <CredentialEditor
          api={api}
          mode="create"
          onCancel={() => setOpen(false)}
          onSaved={(item) => {
            onCreated(item)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}
