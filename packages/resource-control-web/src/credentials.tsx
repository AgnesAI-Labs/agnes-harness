import type { PackageAdminContext } from '@agnes/protocol'
import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Loadable,
  Menu,
  reportSuccess,
  SettingsCheckbox,
  SettingsDrill,
  SettingsList,
  SettingsPage,
  SettingsSection,
  StatusMessage,
  SUBPAGE_CLOSE_EVENT,
  useSettingsSubpages,
  useUiText,
} from '@agnes/web-ui'
import { type ComponentProps, useEffect, useRef, useState } from 'react'
import { CredentialEditor } from './credential-editor.js'
import {
  CREDENTIALS_CHANGED,
  type CredentialFailure,
  CredentialsApi,
  credentialFailure,
  credentialWriteFailure,
} from './credentials-api.js'
import { credentialsCatalog } from './credentials-locale.js'

export { useCredentialOptions } from './credential-options.js'

/** The settings subpage that holds the credential editor. */
const CREDENTIAL_PAGE = 'credential'

export { CREDENTIALS_CHANGED, CredentialsApi } from './credentials-api.js'
export { credentialsCatalog } from './credentials-locale.js'

function References({ item }: { item: AdminCredentialMetadata }) {
  const { t } = useUiText('@agnes/credentials', credentialsCatalog)
  return (
    // One quiet line under the row: where the credential is used, or that nothing uses it yet.
    <span data-testid="credential-references">
      {item.references.length
        ? `${t('used')}: ${item.references
            .map((ref) => `${t(`reference.${ref.kind}`)} · ${ref.configId} · ${ref.profile}`)
            .join('; ')}`
        : t('unused')}
    </span>
  )
}
const defaultApi = new CredentialsApi()
export function CredentialsPage({
  api = defaultApi,
  section = false,
}: {
  api?: CredentialsApi
  /** Render as one titled part of another page instead of a page of its own. */
  section?: boolean
}) {
  const { t, locale } = useUiText('@agnes/credentials', credentialsCatalog)
  const [items, setItems] = useState<AdminCredentialMetadata[]>()
  const [context, setContext] = useState<PackageAdminContext>()
  const [error, setError] = useState<CredentialFailure>()
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [editor, setEditor] = useState<{
    mode: 'create' | 'rename' | 'replace'
    item?: AdminCredentialMetadata
  }>()
  const [removing, setRemoving] = useState<AdminCredentialMetadata>()
  const [confirmed, setConfirmed] = useState(false)
  const lifetime = useRef(true)
  const deleting = useRef(false)
  const blocked = credentialWriteFailure(context)
  useEffect(() => {
    lifetime.current = true
    return () => {
      lifetime.current = false
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly refreshes the metadata.
  useEffect(() => {
    const abort = new AbortController()
    setBusy(true)
    setError(undefined)
    void (async () => {
      try {
        const access = await api.context(abort.signal)
        if (abort.signal.aborted) return
        setContext(access)
        if (
          !access.permissions.includes('credentials.read') ||
          !access.permissions.includes('packages.read')
        ) {
          setItems(undefined)
          throw new Error('denied')
        }
        const next = await api.list(abort.signal)
        if (!abort.signal.aborted) setItems(next)
      } catch (cause) {
        if (!abort.signal.aborted)
          setError(cause instanceof Error && cause.message === 'denied' ? 'denied' : credentialFailure(cause))
      } finally {
        if (!abort.signal.aborted) setBusy(false)
      }
    })()
    return () => abort.abort()
  }, [api, revision])
  async function remove(force = false) {
    if (!removing || blocked || deleting.current || (force && !confirmed)) return
    deleting.current = true
    setBusy(true)
    setError(undefined)
    try {
      await api.delete({ id: removing.id, ...(force ? { force: true, confirm: true } : {}) })
      if (!lifetime.current) return
      setItems((current) => current?.filter((item) => item.id !== removing.id))
      setRemoving(undefined)
      reportSuccess('credentials', t('deleted'))
      window.dispatchEvent(new Event(CREDENTIALS_CHANGED))
    } catch (cause) {
      if (!lifetime.current) return
      const reason = credentialFailure(cause)
      setError(reason)
      if (reason === 'referenced') {
        try {
          const next = await api.list()
          if (!lifetime.current) return
          setItems(next)
          setRemoving(next.find((item) => item.id === removing.id) ?? removing)
          setConfirmed(false)
        } catch {
          /* Preserve the refusal and never infer missing references. */
        }
      }
    } finally {
      deleting.current = false
      if (lifetime.current) setBusy(false)
    }
  }
  // As a section of a settings page the editor is a page of that page; standalone it is a dialog.
  const pages = useSettingsSubpages()
  const inPage = section && pages.available
  const pageBody = useRef<HTMLDivElement>(null)
  const pageOpen = pages.stack.includes(CREDENTIAL_PAGE)
  const wasOpen = useRef(false)
  // Leaving the page by Back or the browser drops the draft.
  useEffect(() => {
    if (wasOpen.current && !pageOpen) setEditor(undefined)
    wasOpen.current = pageOpen
  }, [pageOpen])
  const edit = (next: NonNullable<typeof editor>) => {
    setError(undefined)
    setEditor(next)
    if (inPage) pages.open(CREDENTIAL_PAGE)
  }
  const leavePage = () =>
    pageBody.current?.dispatchEvent(new CustomEvent(SUBPAGE_CLOSE_EVENT, { bubbles: true }))
  const saved = (mode: NonNullable<typeof editor>['mode'], item: AdminCredentialMetadata) => {
    setItems((current) => [item, ...(current ?? []).filter((old) => old.id !== item.id)])
    reportSuccess(
      'credentials',
      t(mode === 'create' ? 'saved' : mode === 'rename' ? 'renamed' : 'replaced'),
      mode === 'replace' ? { kind: 'reconnect-required', message: t('reconnect') } : undefined,
    )
    setEditor(undefined)
  }
  const open = (mode: 'rename' | 'replace', item: AdminCredentialMetadata) => edit({ mode, item })
  // As a page the list fills the pane; as a section it is one titled group on the host page.
  const Frame = section ? SettingsSection : CredentialsFrame
  return (
    <Frame
      title={t('title')}
      description={t('description')}
      data-testid="credentials-page"
      actions={
        <>
          <IconButton
            name="refresh-cw"
            label={t('retry')}
            data-testid="credentials-refresh"
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          />
          <Button
            appearance={section ? 'secondary' : 'primary'}
            data-testid="credential-create"
            disabled={busy || !!blocked}
            {...(blocked ? { disabledReason: t(`error.${blocked}`) } : {})}
            onClick={() => edit({ mode: 'create' })}
          >
            {t('create')}
          </Button>
        </>
      }
    >
      {blocked && context && <Banner tone="warning">{t(`error.${blocked}`)}</Banner>}
      {error && !removing && (
        <StatusMessage
          kind="error"
          data-testid="credentials-error"
          action={{ label: t('retry'), onSelect: () => setRevision((value) => value + 1), busy }}
        >
          {t(`error.${error}`)}
        </StatusMessage>
      )}
      {busy && !items && <Loadable loading hasData={false} shape="rows" />}
      {items?.length === 0 && (
        <EmptyState icon={<Icon name="key-round" />} title={t('empty')} description={t('emptyHelp')} />
      )}
      {!!items?.length && (
        <SettingsList>
          {items.map((item) => (
            <ListRow
              key={item.id}
              data-testid="credential-row"
              data-credential-id={item.id}
              icon={<Icon name="key-round" size={20} />}
              title={item.label}
              meta={
                <>
                  {t('type')} · {t('created', { date: new Date(item.createdAt).toLocaleDateString(locale) })}
                </>
              }
              actions={
                <Menu
                  label={t('menu', { name: item.label })}
                  trigger={<IconButton name="ellipsis" label={t('menu', { name: item.label })} />}
                  items={(['rename', 'replace', 'delete'] as const).map((mode) => ({
                    id: mode,
                    label: t(mode),
                    testId: `credential-${mode}`,
                    danger: mode === 'delete',
                    disabled: busy || !!blocked,
                    ...(blocked ? { disabledReason: t(`error.${blocked}`) } : {}),
                    onSelect: () => {
                      if (mode === 'delete') {
                        setError(undefined)
                        setConfirmed(false)
                        setRemoving(item)
                      } else open(mode, item)
                    },
                  }))}
                />
              }
            >
              <References item={item} />
            </ListRow>
          ))}
        </SettingsList>
      )}
      {editor && !inPage && (
        <CredentialEditor
          api={api}
          {...editor}
          onCancel={() => setEditor(undefined)}
          onSaved={(item) => saved(editor.mode, item)}
        />
      )}
      {/* Inside settings the editor is a page of its own, opened from the list's actions. */}
      {inPage && (
        <SettingsDrill
          id={CREDENTIAL_PAGE}
          hidden
          label={t(editor?.mode === 'rename' || editor?.mode === 'replace' ? editor.mode : 'create')}
          title={editor?.item ? `${t(editor.mode)} · ${editor.item.label}` : t('create')}
          description={t('description')}
        >
          {editor && (
            <div ref={pageBody}>
              <CredentialEditor
                api={api}
                {...editor}
                layout="page"
                onCancel={() => leavePage()}
                onSaved={(item) => {
                  saved(editor.mode, item)
                  leavePage()
                }}
              />
            </div>
          )}
        </SettingsDrill>
      )}
      {removing && (
        <Dialog
          open
          destroyOnHidden
          title={t('deleteTitle', { name: removing.label })}
          closable={!busy}
          keyboard={!busy}
          mask={{ closable: !busy }}
          onCancel={() => {
            if (!busy) setRemoving(undefined)
          }}
          footer={
            <>
              <Button
                data-testid="credential-delete-cancel"
                disabled={busy}
                onClick={() => setRemoving(undefined)}
              >
                {t('cancel')}
              </Button>
              <Button
                data-testid="credential-delete-confirm"
                appearance="primary"
                danger
                disabled={busy || !!blocked}
                onClick={() => void remove(removing.references.length > 0 && confirmed)}
              >
                {t(removing.references.length && confirmed ? 'force' : 'delete')}
              </Button>
            </>
          }
        >
          <p>{t('deleteHelp')}</p>
          <References item={removing} />
          {error && (
            <Banner tone="error" data-testid="credential-delete-error">
              {t(`error.${error}`)}
            </Banner>
          )}
          {removing.references.length > 0 && (
            <SettingsCheckbox
              data-testid="credential-force-confirm"
              label={t('forceConfirm')}
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
          )}
        </Dialog>
      )}
    </Frame>
  )
}
function CredentialsFrame(props: Omit<ComponentProps<typeof SettingsPage>, 'variant'>) {
  return <SettingsPage {...props} variant="list" />
}
