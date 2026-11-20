import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
import {
  Button,
  Dialog,
  Field,
  getOverlayContainer,
  publishFeedback,
  reportSuccess,
  resolveFeedback,
  SettingsInput,
  StatusMessage,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { beginCredentialMutation, credentialReplacementScopes } from './credential-mutations.js'
import {
  CREDENTIALS_CHANGED,
  type CredentialFailure,
  type CredentialsApi,
  credentialFailure,
} from './credentials-api.js'
import { credentialsCatalog } from './credentials-locale.js'

/** Secret values live only in the draft input, never in React state or persisted client storage. */
export function CredentialEditor({
  api,
  item,
  mode,
  onCancel,
  onSaved,
  layout = 'dialog',
}: {
  api: CredentialsApi
  item?: AdminCredentialMetadata
  mode: 'create' | 'rename' | 'replace'
  onCancel(): void
  onSaved(item: AdminCredentialMetadata): void
  /** `page`: the form is the body of a settings page (its title is the page's), not a dialog. */
  layout?: 'dialog' | 'page'
}) {
  const { t } = useUiText('@agnes/credentials', credentialsCatalog)
  const [container] = useState(() => getOverlayContainer(document.activeElement as HTMLElement))
  const value = useRef<HTMLInputElement>(null)
  const [label, setLabel] = useState(item?.label ?? '')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CredentialFailure>()
  const active = useRef(true)
  const submitting = useRef(false)
  useEffect(() => {
    active.current = true
    const input = value.current
    return () => {
      active.current = false
      if (input) input.value = ''
    }
  }, [])
  async function save() {
    if (submitting.current || (mode !== 'create' && !item)) return
    const replacing = mode === 'replace' ? item : undefined
    const finish = replacing ? beginCredentialMutation(replacing.id) : undefined
    if (replacing && !finish) return
    const input = value.current
    const scopes = replacing ? credentialReplacementScopes(replacing.id) : undefined
    submitting.current = true
    setBusy(true)
    setError(undefined)
    if (scopes) resolveFeedback(scopes.refusal)
    let result: AdminCredentialMetadata
    try {
      if (replacing) result = await api.set(replacing.id, input?.value ?? '')
      else if (mode === 'rename' && item) result = await api.rename(item.id, label.trim())
      else result = await api.create(label.trim(), input?.value ?? '')
    } catch (cause) {
      const reason = credentialFailure(cause)
      if (scopes && replacing && reason === 'unconfirmed') {
        publishFeedback({
          id: crypto.randomUUID(),
          scope: scopes.unconfirmed,
          outcome: 'unknown',
          message: t('error.unconfirmed', { name: replacing.label }),
        })
      } else if (active.current) setError(reason)
      else if (scopes)
        publishFeedback({
          id: crypto.randomUUID(),
          scope: scopes.refusal,
          outcome: 'error',
          message: t(`error.${reason}`),
        })
      return
    } finally {
      // Clear the draft before sharing metadata, even after the editor has unmounted.
      if (input) input.value = ''
      finish?.()
      submitting.current = false
      if (active.current) {
        setVisible(false)
        setBusy(false)
      }
    }
    if (!active.current && !scopes) return
    if (scopes) {
      // A receipt only confirms this write. A previous request with a lost response could still arrive later.
      const reconnect = result.references.some((reference) => reference.kind === 'mcp')
      if (!reconnect) resolveFeedback(scopes.success)
      reportSuccess(
        scopes.success,
        t('replaced'),
        reconnect ? { kind: 'reconnect-required', message: t('reconnect') } : undefined,
      )
    }
    window.dispatchEvent(new Event(CREDENTIALS_CHANGED))
    if (active.current) onSaved(result)
  }
  const footer = (
    <>
      <Button data-testid="credential-cancel" disabled={busy} onClick={onCancel}>
        {t('cancel')}
      </Button>
      <Button
        appearance="primary"
        data-testid="credential-save"
        loading={busy}
        disabled={busy || (mode !== 'replace' && !label.trim())}
        onClick={() => {
          document
            .getElementById('credential-editor-form')
            ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        }}
      >
        {t('save')}
      </Button>
    </>
  )
  const form = (
    <form
      id="credential-editor-form"
      data-testid="credential-editor"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      {error && (
        <StatusMessage
          kind="error"
          data-testid="credential-error"
          {...(mode === 'rename' ? { action: { label: t('retry'), onSelect: () => void save(), busy } } : {})}
        >
          {t(`error.${error}`)}
          {mode !== 'rename' && ` ${t('reenter')}`}
        </StatusMessage>
      )}
      {mode !== 'replace' && (
        <Field label={t('label')}>
          <SettingsInput
            id="credential-label"
            data-testid="credential-label"
            value={label}
            maxLength={128}
            required
            disabled={busy}
            autoFocus
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
      )}
      {mode !== 'rename' && (
        <>
          <Field label={t('value')} hint={t('hint')}>
            <SettingsInput
              ref={value}
              id="credential-value"
              data-testid="credential-value"
              type={visible ? 'text' : 'password'}
              autoComplete="new-password"
              maxLength={65536}
              required
              disabled={busy}
              autoFocus={mode === 'replace'}
            />
          </Field>
          <Button
            data-testid="credential-show"
            aria-pressed={visible}
            disabled={busy}
            onClick={() => setVisible((current) => !current)}
          >
            {t(visible ? 'hide' : 'show')}
          </Button>
        </>
      )}
    </form>
  )
  if (layout === 'page')
    return (
      <div className="agnes-settings-stack credential-editor-page">
        {form}
        <div className="agnes-settings-apply">
          <span />
          {footer}
        </div>
      </div>
    )
  return (
    <Dialog
      getContainer={() => container}
      open
      destroyOnHidden
      title={t(mode === 'create' ? 'create' : mode)}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: !busy }}
      onCancel={() => {
        if (!busy) {
          if (value.current) value.current.value = ''
          onCancel()
        }
      }}
      footer={footer}
    >
      {form}
    </Dialog>
  )
}
