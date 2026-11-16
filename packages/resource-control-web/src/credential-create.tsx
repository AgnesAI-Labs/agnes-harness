import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
import { Banner, Button, useUiText } from '@agnes/web-ui'
import { useEffect, useMemo, useState } from 'react'
import { CredentialEditor } from './credential-editor.js'
import {
  type CredentialFailure,
  CredentialsApi,
  credentialFailure,
  credentialWriteFailure,
} from './credentials-api.js'
import { credentialsCatalog } from './credentials-locale.js'

/** Whether this person may create credentials here: `undefined` when allowed, else the reason. */
export type CredentialWrite = { api: CredentialsApi; blocked: CredentialFailure | undefined }

/** One write-permission lookup, shared by every create entry of a form. */
export function useCredentialWrite(): CredentialWrite {
  const [api] = useState(() => new CredentialsApi())
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
  return useMemo(() => ({ api, blocked }), [api, blocked])
}

function OwnWrite(props: Omit<Parameters<typeof CredentialCreate>[0], 'write'>) {
  return <CredentialCreate {...props} write={useCredentialWrite()} />
}

/**
 * Creates one credential where a form needs it. The write permission is checked first; the editor keeps
 * the value write-only and the caller receives metadata only, to select the new reference. A form with
 * several entries passes one shared `write`; without it the entry looks the permission up itself.
 */
export function CredentialCreate({
  onCreated,
  testId = 'credential-create',
  banner = false,
  disabled = false,
  dismissOn,
  write,
}: {
  onCreated(item: AdminCredentialMetadata): void
  testId?: string
  /** Also explain a blocked write below the button, not only on the disabled button. */
  banner?: boolean
  /** The surrounding form is busy; the entry stays in place but cannot open. */
  disabled?: boolean
  /** An element whose `close` event discards an open editor, such as the hosting native dialog. */
  dismissOn?: () => EventTarget | null | undefined
  write?: CredentialWrite
}) {
  const { t } = useUiText('@agnes/credentials', credentialsCatalog)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const target = dismissOn?.()
    const close = () => setOpen(false)
    target?.addEventListener('close', close)
    return () => target?.removeEventListener('close', close)
  }, [dismissOn])
  if (!write)
    return (
      <OwnWrite
        onCreated={onCreated}
        testId={testId}
        banner={banner}
        disabled={disabled}
        {...(dismissOn ? { dismissOn } : {})}
      />
    )
  const { api, blocked } = write
  return (
    <>
      <Button
        data-testid={testId}
        disabled={disabled || !!blocked}
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
