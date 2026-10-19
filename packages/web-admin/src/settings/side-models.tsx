import type { ConfigAccount, ConfigAccountInput, ConfigModel, ConfigSnapshot } from '@agnes/protocol'
import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import {
  createDocumentLocaleSource,
  SIDE_MODEL_PAGE_IDS,
  SUBPAGE_CLOSE_EVENT,
  setSettingsSideModelPage,
  UiLocaleProvider,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { configurationField } from './dialog.js'
import { SideModelEditor } from './side-models/editor.js'
import { SideModelList } from './side-models/list.js'
import {
  ADAPTER_PRESETS,
  accountIdFor,
  draftProvider,
  type EditorDraft,
  endpointOk,
  failureCode,
  MODEL_ID,
  readModels,
  SIDE_PROVIDERS,
  type SideModelsClient,
  type SideModelsCredentials,
  toDraft,
} from './side-models/model.js'
import { SIDE_MODELS_NAMESPACE, sideModelsCatalog } from './side-models-locale.js'

export type { SideModelsClient, SideModelsCredentials } from './side-models/model.js'

type PanelProps = {
  client: SideModelsClient
  configuration: ConfigSnapshot | undefined
  canSave: boolean
  onSaved(snapshot: ConfigSnapshot): Promise<void> | void
  credentials?: SideModelsCredentials
}

export function SideModelsPanel({ credentials, ...props }: PanelProps) {
  const [locale] = useState(() => createDocumentLocaleSource({ [SIDE_MODELS_NAMESPACE]: sideModelsCatalog }))
  const [store] = useState(() => credentials ?? new CredentialsApi())
  useEffect(() => () => locale.dispose(), [locale])
  return (
    <UiLocaleProvider source={locale.source}>
      <SideModels {...props} credentials={store} />
    </UiLocaleProvider>
  )
}

/** Mount helper for the settings controller's renderRegion, mirroring modelSlotsPanel. */
export function sideModelsPanel(props: PanelProps) {
  return <SideModelsPanel key={props.configuration?.revision ?? 'loading'} {...props} />
}

const closePage = (page: HTMLElement | undefined) =>
  page?.dispatchEvent(new CustomEvent(SUBPAGE_CLOSE_EVENT, { bubbles: true }))

/**
 * The side-model list and its editor. Inside the settings dialog the editor is a pushed page of the
 * model pane (`SIDE_MODEL_PAGE_IDS`): this panel renders it into the page the pane lends, and
 * leaving that page by 返回 or the browser drops the draft. Without that pane it opens below the list.
 */
function SideModels({
  client,
  configuration,
  canSave,
  onSaved,
  credentials,
}: Omit<PanelProps, 'credentials'> & { credentials: SideModelsCredentials }) {
  const { t } = useUiText(SIDE_MODELS_NAMESPACE, sideModelsCatalog)
  const accounts = (configuration?.accounts ?? []).filter((row) =>
    (SIDE_PROVIDERS as readonly string[]).includes(row.providerId),
  )
  const [draft, setDraft] = useState<EditorDraft>()
  /** The settings page the editor is on, and whether it was opened onto one. */
  const [page, setPage] = useState<HTMLElement>()
  const [paged, setPaged] = useState(false)
  const [removing, setRemoving] = useState<string>()
  const [copied, setCopied] = useState<string>()
  const [tested, setTested] = useState<{ accountId: string; key: string }>()
  const copyTimers = useRef<number[]>([])
  useEffect(() => {
    const timers = copyTimers.current
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [])
  const copyRoute = async ({ accountId, route }: ConfigAccount) => {
    const board = navigator.clipboard
    if (!board) return
    await board.writeText(route)
    setCopied(accountId)
    copyTimers.current.push(
      window.setTimeout(() => setCopied((current) => (current === accountId ? undefined : current)), 2000),
    )
  }
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [fieldError, setFieldError] = useState<'baseUrl' | 'credentialRef'>()
  const saved = draft && !draft.isNew ? accounts.find((row) => row.accountId === draft.accountId) : undefined
  const endpointChanged =
    !!draft && !draft.isNew && saved?.baseUrl.replace(/\/$/, '') !== draft.baseUrl.replace(/\/$/, '')
  const [testState, setTestState] = useState('')
  const [options, setOptions] = useState<readonly { id: string; label: string }[]>([])
  useEffect(() => {
    let cancelled = false
    void credentials.list().then(
      (items) => {
        if (!cancelled) setOptions(items)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [credentials])

  const revision = configuration?.revision ?? 0
  const takenIds = new Set(accounts.map((row) => row.accountId))
  const resetMessages = () => {
    setStatus('')
    setFieldError(undefined)
    setTestState('')
  }
  const addDraft = (): EditorDraft => {
    const preset = ADAPTER_PRESETS[draftProvider()]
    return {
      accountId: '',
      isNew: true,
      fallbackId: `jev-${crypto.randomUUID().slice(0, 8)}`,
      label: t(preset.labelKey),
      baseUrl: preset.baseUrl,
      credentialRef: '',
      models: preset.models(),
    }
  }
  /** Open the editor on its settings page when the pane has one, else below the list. */
  const show = (next: EditorDraft) => {
    resetMessages()
    setRemoving(undefined)
    setDraft(next)
    const id = next.isNew ? SIDE_MODEL_PAGE_IDS.add : SIDE_MODEL_PAGE_IDS.edit
    const row = document.querySelector<HTMLButtonElement>(`[data-settings-drill="${id}"]`)
    setPaged(!!row)
    if (row && row.getAttribute('aria-expanded') !== 'true') row.click()
  }
  const openEdit = (account: ConfigAccount) =>
    show({
      accountId: account.accountId,
      isNew: false,
      fallbackId: '',
      label: account.label,
      baseUrl: account.baseUrl,
      credentialRef: '',
      models: account.models.map(toDraft),
    })
  const closeEditor = () => {
    closePage(page)
    setDraft(undefined)
  }

  // The pane lends its page while it is open. A page opened by a link or by history has no draft:
  // the add page starts one, the edit page (which names no entry) closes again.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const attach = useRef<(node: HTMLElement, mode: 'add' | 'edit') => () => void>(() => () => {})
  attach.current = (node, mode) => {
    setPage(node)
    setPaged(true)
    if (!draftRef.current) {
      if (mode === 'add') {
        resetMessages()
        setDraft(addDraft())
      } else queueMicrotask(() => closePage(node))
    }
    return () => {
      setPage((current) => (current === node ? undefined : current))
      setDraft(undefined)
    }
  }
  useEffect(() => {
    setSettingsSideModelPage({ attach: (node, mode) => attach.current(node, mode) })
    return () => setSettingsSideModelPage(undefined)
  }, [])

  const patch = (next: Partial<EditorDraft>) => {
    resetMessages()
    setDraft((current) => (current ? { ...current, ...next } : current))
  }
  const valid = (current: EditorDraft): ConfigModel[] | undefined => {
    if (current.label.trim() === '' || current.label.length > 128) return undefined
    if (!endpointOk(current.baseUrl)) {
      setFieldError('baseUrl')
      return undefined
    }
    if ((current.isNew || endpointChanged) && current.credentialRef === '') {
      setFieldError('credentialRef')
      return undefined
    }
    return readModels(current.models)
  }

  const save = async () => {
    if (!draft || busy || !canSave) return
    const models = valid(draft)
    if (!models) {
      setStatus('side.invalid')
      return
    }
    const selected =
      saved && models.some((model) => model.id === saved.model) ? saved.model : (models[0]?.id ?? '')
    setBusy(true)
    setStatus('')
    try {
      const result = await client.save({
        providerId: draftProvider(),
        accountId: draft.isNew ? accountIdFor(draft.label, takenIds, draft.fallbackId) : draft.accountId,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl,
        ...(draft.credentialRef === '' ? {} : { credentialRef: draft.credentialRef }),
        model: selected,
        models,
        expectedRevision: revision,
      })
      closeEditor()
      await onSaved(result)
      setStatus(result.effect === 'restart-required' ? 'side.savedRestart' : 'side.saved')
    } catch (error) {
      if (failureCode(error) === 'CONFIG_REVISION_CONFLICT') {
        // The read model moved under the editor: reload it before letting anyone retry.
        closeEditor()
        await onSaved(await client.get())
        setStatus('side.conflict')
      } else {
        const field = configurationField(error)
        setFieldError(
          field === 'baseUrl' || field === 'credentialRef'
            ? field
            : failureCode(error) === 'CONFIG_CREDENTIAL_REQUIRED'
              ? 'credentialRef'
              : undefined,
        )
        setStatus('side.failed')
      }
    } finally {
      setBusy(false)
    }
  }

  /** The probe the daemon runs; `accountId` lets it use the saved credential. */
  const runTest = async (input: {
    accountId?: string
    baseUrl: string
    credentialRef: string
    model: string
  }) => {
    const result = await client.test({
      providerId: draftProvider(),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      baseUrl: input.baseUrl,
      ...(input.credentialRef === '' ? {} : { credentialRef: input.credentialRef }),
      model: input.model,
    })
    return result.verified ? 'side.testOk' : 'side.testFailed'
  }
  const testKey = (error: unknown) =>
    failureCode(error) === 'CONFIG_CREDENTIAL_REJECTED' ? 'side.testRejected' : 'side.testFailed'

  const probe = async () => {
    if (!draft || busy) return
    const model = draft.models.find((row) => MODEL_ID.test(row.id))?.id
    if (!model) {
      setTestState('side.invalid')
      return
    }
    setBusy(true)
    setTestState('')
    try {
      setTestState(
        await runTest({
          ...(draft.isNew ? {} : { accountId: draft.accountId }),
          baseUrl: draft.baseUrl,
          credentialRef: draft.credentialRef,
          model,
        }),
      )
    } catch (error) {
      const field = configurationField(error)
      setFieldError(field === 'baseUrl' || field === 'credentialRef' ? field : undefined)
      setTestState(testKey(error))
    } finally {
      setBusy(false)
    }
  }

  const testSaved = async (account: ConfigAccount) => {
    if (busy) return
    setBusy(true)
    setTested(undefined)
    try {
      const key = await runTest({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        credentialRef: '',
        model: account.model,
      })
      setTested({ accountId: account.accountId, key })
    } catch (error) {
      setTested({ accountId: account.accountId, key: testKey(error) })
    } finally {
      setBusy(false)
    }
  }

  const act = async (accountId: string, action: ConfigAccountInput['action']) => {
    if (busy || !canSave) return
    setBusy(true)
    setStatus('')
    try {
      await onSaved(await client.account({ accountId, action, expectedRevision: revision }))
      setRemoving(undefined)
      setStatus('side.saved')
    } catch (error) {
      if (failureCode(error) === 'CONFIG_REVISION_CONFLICT') {
        await onSaved(await client.get())
        setStatus('side.conflict')
      } else {
        setStatus('side.failed')
      }
    } finally {
      setBusy(false)
    }
  }

  const createCredential = async (label: string, value: string) => {
    if (busy || label === '' || value === '') return false
    setBusy(true)
    try {
      const item = await credentials.create(label, value)
      setOptions((current) => [...current, item])
      patch({ credentialRef: item.id })
      return true
    } catch {
      setStatus('side.failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  const ok = status === 'side.saved' || status === 'side.savedRestart'
  const statusLine = (
    <div className="capability-save">
      <span
        role={status && !ok ? 'alert' : 'status'}
        data-tone={ok ? 'success' : 'error'}
        data-testid={status ? 'side-models-status' : undefined}
      >
        {status ? t(status) : ''}
      </span>
    </div>
  )
  const editor = draft && (
    <SideModelEditor
      draft={draft}
      route={saved?.route ?? `account-${accountIdFor(draft.label, takenIds, draft.fallbackId)}`}
      canSave={canSave}
      busy={busy}
      fieldError={fieldError}
      endpointChanged={endpointChanged}
      options={options}
      testState={testState}
      status={statusLine}
      onPatch={patch}
      onModels={(update) => {
        setStatus('')
        setDraft((current) => (current ? { ...current, models: update(current.models) } : current))
      }}
      onCreateCredential={createCredential}
      onProbe={() => void probe()}
      onCancel={closeEditor}
      onSave={() => void save()}
    />
  )
  return (
    <>
      <SideModelList
        accounts={accounts}
        canSave={canSave}
        busy={busy}
        editing={!!draft}
        removing={removing}
        copied={copied}
        tested={tested}
        status={statusLine}
        onAdd={() => show(addDraft())}
        onEdit={openEdit}
        onToggle={(account, next) => void act(account.accountId, next ? 'enable' : 'disable')}
        onCopy={(account) => void copyRoute(account)}
        onTest={(account) => void testSaved(account)}
        onRemove={(account) => setRemoving(account?.accountId)}
        onConfirmRemove={(account) => void act(account.accountId, 'remove')}
      >
        {!paged && editor}
      </SideModelList>
      {paged && page && editor && createPortal(editor, page)}
    </>
  )
}
