import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
import {
  Banner,
  Button,
  createDocumentLocaleSource,
  createRegionHost,
  mountRegion,
  UiLocaleProvider,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { CredentialEditor } from './credential-editor.js'
import {
  type CredentialFailure,
  CredentialsApi,
  credentialFailure,
  credentialWriteFailure,
} from './credentials-api.js'
import { credentialsCatalog } from './credentials-locale.js'

function InlineCreate({ onCreated }: { onCreated(item: AdminCredentialMetadata): void }) {
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
    const dialog = document.getElementById('mcp-dialog')
    const close = () => setOpen(false)
    dialog?.addEventListener('close', close)
    return () => dialog?.removeEventListener('close', close)
  }, [])
  return (
    <>
      <Button
        data-testid="mcp-credential-create"
        disabled={!!blocked}
        {...(blocked ? { disabledReason: t(`error.${blocked}`) } : {})}
        onClick={() => setOpen(true)}
      >
        {t('create')}
      </Button>
      {blocked && <Banner tone="warning">{t(`error.${blocked}`)}</Banner>}
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
export function mountMcpCredentialCreate(
  control: HTMLSelectElement,
  onCreated: (item: AdminCredentialMetadata) => void,
) {
  const field = control.closest('label')!
  const host = createRegionHost(field.parentElement!, 'div')
  field.after(host)
  const locale = createDocumentLocaleSource({ '@agnes/credentials': credentialsCatalog })
  const dispose = mountRegion(
    host,
    <UiLocaleProvider source={locale.source}>
      <InlineCreate onCreated={onCreated} />
    </UiLocaleProvider>,
  )
  return () => {
    dispose()
    locale.dispose()
    host.remove()
  }
}
