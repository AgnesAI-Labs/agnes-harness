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
  resolveFeedback,
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
import { type ComponentProps, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CredentialEditor } from './credential-editor.js'
import {
  beginCredentialMutation,
  credentialReplacementScopes,
  pendingCredentialMutations,
} from './credential-mutations.js'
import {
  CREDENTIALS_CHANGED,
  CredentialError,
  type CredentialFailure,
  CredentialsApi,
  cloudCredentialUsage,
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
  const cloudRef = useSyncExternalStore(cloudCredentialUsage.subscribe, cloudCredentialUsage.read)
  const names = item.references.map(
    (ref) => `${t(`reference.${ref.kind}`)} · ${ref.configId} · ${ref.profile}`,
  )
  if (cloudRef === item.id) names.push(t('reference.browserCloud'))
  return (
    // One quiet line under the row: where the credential is used, or that nothing uses it yet.
    <span data-testid="credential-references">
      {names.length ? `${t('used')}: ${names.join('; ')}` : t('unused')}
    </span>
  )
}
const defaultApi = new CredentialsApi()

function referenceKey(item: AdminCredentialMetadata, cloudRef: string | undefined) {
  return item.references
    .map(({ kind, profile, configId }) => JSON.stringify([kind, profile, configId]))
    .concat(item.id === cloudRef ? ['browser-cloud'] : [])
    .sort()
    .join('\n')
}

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
  const [listError, setListError] = useState<CredentialFailure>()
  const [listLoading, setListLoading] = useState(true)
  const [editor, setEditor] = useState<{
    mode: 'create' | 'rename' | 'replace'
    item?: AdminCredentialMetadata
  }>()
  const [removalTarget, setRemovalTarget] = useState<AdminCredentialMetadata>()
  const [confirmedReferences, setConfirmedReferences] = useState<string>()
  const [deleteError, setDeleteError] = useState<CredentialFailure>()
  const [deleting, setDeleting] = useState(false)
  const currentRemoval = removalTarget && items?.find((item) => item.id === removalTarget.id)
  const removing = currentRemoval ?? removalTarget
  const cloudRef = useSyncExternalStore(cloudCredentialUsage.subscribe, cloudCredentialUsage.read)
  const cloudInUse = !!removing && cloudRef === removing.id
  const used = !!removing && (removing.references.length > 0 || cloudInUse)
  const referenceSet = currentRemoval && referenceKey(currentRemoval, cloudRef)
  const confirmed = !listError && referenceSet !== undefined && referenceSet === confirmedReferences
  const removalError =
    deleteError ?? (removing && !currentRemoval && items && !deleting ? 'missing' : undefined)
  const pending = useSyncExternalStore(
    pendingCredentialMutations.subscribe,
    pendingCredentialMutations.getSnapshot,
  )
  const lifetime = useRef(true)
  const listRequest = useRef<AbortController>()
  const blocked = credentialWriteFailure(context)
  useEffect(() => {
    if (!confirmed && confirmedReferences !== undefined) setConfirmedReferences(undefined)
  }, [confirmed, confirmedReferences])
  const refreshList = useCallback(async () => {
    listRequest.current?.abort()
    const abort = new AbortController()
    listRequest.current = abort
    setListLoading(true)
    try {
      const access = await api.context(abort.signal)
      if (abort.signal.aborted) return
      setContext(access)
      if (!access.permissions.includes('credentials.read') || !access.permissions.includes('packages.read')) {
        setItems(undefined)
        throw new CredentialError('denied')
      }
      const next = await api.list(abort.signal)
      if (abort.signal.aborted) return
      setItems(next)
      setListError(undefined)
      return { items: next, access, signal: abort.signal }
    } catch (cause) {
      if (!abort.signal.aborted) {
        setListError(credentialFailure(cause))
        setConfirmedReferences(undefined)
      }
    } finally {
      if (!abort.signal.aborted) setListLoading(false)
    }
  }, [api])
  useEffect(() => {
    lifetime.current = true
    const refresh = () => void refreshList()
    window.addEventListener(CREDENTIALS_CHANGED, refresh)
    refresh()
    return () => {
      lifetime.current = false
      listRequest.current?.abort()
      window.removeEventListener(CREDENTIALS_CHANGED, refresh)
    }
  }, [refreshList])
  async function remove() {
    if (!currentRemoval || blocked || deleting || listLoading) return
    const { id } = currentRemoval
    if (cloudCredentialUsage.read() === id && !confirmed) return
    const finish = beginCredentialMutation(id)
    if (!finish) return
    setRemovalTarget(currentRemoval)
    setDeleting(true)
    setDeleteError(undefined)
    const force = used && confirmed
    try {
      if (force) {
        // Recheck the exact list the user acknowledged before sending a destructive request.
        const latest = await refreshList()
        if (!lifetime.current) return
        const target = latest?.items.find((item) => item.id === id)
        if (
          !latest ||
          latest.signal.aborted ||
          !target ||
          referenceKey(target, cloudCredentialUsage.read()) !== confirmedReferences
        ) {
          setConfirmedReferences(undefined)
          return
        }
        const refusal = credentialWriteFailure(latest.access)
        if (refusal) {
          setConfirmedReferences(undefined)
          setDeleteError(refusal)
          return
        }
      }
      await api.delete({ id, ...(force ? { force: true, confirm: true } : {}) })
      const scopes = credentialReplacementScopes(id)
      for (const scope of Object.values(scopes)) resolveFeedback(scope)
      // Replace any still-visible replacement toast for this credential.
      reportSuccess(scopes.success, t('deleted'))
      if (lifetime.current) {
        setItems((current) => current?.filter((item) => item.id !== id))
        setRemovalTarget(undefined)
      }
      window.dispatchEvent(new CustomEvent(CREDENTIALS_CHANGED, { detail: { mode: 'delete', id } }))
    } catch (cause) {
      if (!lifetime.current) return
      const reason = credentialFailure(cause)
      setDeleteError(reason)
      if (reason === 'referenced') {
        setConfirmedReferences(undefined)
        await refreshList()
      }
    } finally {
      finish()
      if (lifetime.current) setDeleting(false)
    }
  }
  // The inner dialog still consumes Escape while a deletion is pending.
  const cancelRemoval = () => {
    if (!deleting) setRemovalTarget(undefined)
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
    setEditor(next)
    if (inPage) pages.open(CREDENTIAL_PAGE)
  }
  const leavePage = () =>
    pageBody.current?.dispatchEvent(new CustomEvent(SUBPAGE_CLOSE_EVENT, { bubbles: true }))
  const saved = (mode: NonNullable<typeof editor>['mode'], item: AdminCredentialMetadata) => {
    setItems((current) => [item, ...(current ?? []).filter((old) => old.id !== item.id)])
    if (mode !== 'replace') reportSuccess('credentials', t(mode === 'create' ? 'saved' : 'renamed'))
    setEditor(undefined)
  }
  const open = (mode: 'rename' | 'replace', item: AdminCredentialMetadata) => edit({ mode, item })
  const refreshAction = {
    label: t('retry'),
    onSelect: () => void refreshList(),
    busy: listLoading || deleting,
  }
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
            disabled={listLoading}
            onClick={() => void refreshList()}
          />
          <Button
            appearance={section ? 'secondary' : 'primary'}
            data-testid="credential-create"
            disabled={listLoading || !!blocked}
            {...(blocked ? { disabledReason: t(`error.${blocked}`) } : {})}
            onClick={() => edit({ mode: 'create' })}
          >
            {t('create')}
          </Button>
        </>
      }
    >
      {blocked && context && <Banner tone="warning">{t(`error.${blocked}`)}</Banner>}
      {listError && !removing && (
        <StatusMessage kind="error" data-testid="credentials-error" action={refreshAction}>
          {t(`error.${listError}`)}
        </StatusMessage>
      )}
      {listLoading && !items && <Loadable loading hasData={false} shape="rows" />}
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
                  <span role="status">{pending.has(item.id) ? ` · ${t('updatePending')}` : ''}</span>
                </>
              }
              actions={
                <Menu
                  label={t('menu', { name: item.label })}
                  trigger={<IconButton name="ellipsis" label={t('menu', { name: item.label })} />}
                  items={(['rename', 'replace', 'delete'] as const).map((mode) => {
                    const waiting = mode !== 'rename' && pending.has(item.id)
                    const disabledReason = blocked
                      ? t(`error.${blocked}`)
                      : waiting
                        ? t('updatePending')
                        : undefined
                    return {
                      id: mode,
                      label: t(mode),
                      testId: `credential-${mode}`,
                      danger: mode === 'delete',
                      disabled: listLoading || !!disabledReason,
                      ...(disabledReason ? { disabledReason } : {}),
                      onSelect: () => {
                        if (mode !== 'rename' && pendingCredentialMutations.getSnapshot().has(item.id)) return
                        if (mode === 'delete') {
                          setDeleteError(undefined)
                          setConfirmedReferences(undefined)
                          setRemovalTarget(item)
                        } else open(mode, item)
                      },
                    }
                  })}
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
          closable={!deleting}
          keyboard
          mask={{ closable: !deleting }}
          onCancel={cancelRemoval}
          footer={
            <>
              <Button data-testid="credential-delete-cancel" disabled={deleting} onClick={cancelRemoval}>
                {t('cancel')}
              </Button>
              <Button
                data-testid="credential-delete-confirm"
                appearance="primary"
                danger
                disabled={
                  !currentRemoval ||
                  deleting ||
                  listLoading ||
                  !!blocked ||
                  pending.has(removing.id) ||
                  (cloudInUse && !confirmed)
                }
                onClick={() => void remove()}
              >
                {t(used && confirmed ? 'force' : 'delete')}
              </Button>
            </>
          }
        >
          <p>{t('deleteHelp')}</p>
          <References item={removing} />
          {listError && (
            <StatusMessage kind="error" data-testid="credential-delete-refresh-error" action={refreshAction}>
              {t('deleteRefreshFailed')} {t(`error.${listError}`)}
            </StatusMessage>
          )}
          {removalError && (
            <Banner tone="error" data-testid="credential-delete-error">
              {t(`error.${removalError}`)}
            </Banner>
          )}
          {used && (
            <SettingsCheckbox
              data-testid="credential-force-confirm"
              label={t('forceConfirm')}
              checked={confirmed}
              disabled={deleting || listLoading || !!listError || !!blocked || !currentRemoval}
              onChange={(event) => setConfirmedReferences(event.target.checked ? referenceSet : undefined)}
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
