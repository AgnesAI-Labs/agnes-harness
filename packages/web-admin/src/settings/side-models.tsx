import type {
  ConfigAccount,
  ConfigAccountInput,
  ConfigModel,
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigTestInput,
  ConfigTestResult,
} from '@agnes/protocol'
import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import {
  Badge,
  Button,
  createDocumentLocaleSource,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsSelect,
  StateSwitch,
  UiLocaleProvider,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { settingsCatalog } from './locales.js'
import { SIDE_MODELS_NAMESPACE, sideModelsCatalog } from './side-models-locale.js'

/** The one payload-only provider the account store serves today; the dropdown is a slot, not a list. */
const SIDE_PROVIDERS = ['typesafe-systemone'] as const
type SideProviderId = (typeof SIDE_PROVIDERS)[number]
const draftProvider = (): SideProviderId => SIDE_PROVIDERS[0]
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

export type SideModelsClient = {
  get(): Promise<ConfigSnapshot>
  save(input: ConfigSaveInput): Promise<ConfigSnapshot>
  test(input: ConfigTestInput): Promise<ConfigTestResult>
  account(input: ConfigAccountInput): Promise<ConfigSnapshot>
}

export type SideModelsCredentials = {
  list(): Promise<readonly { id: string; label: string }[]>
  create(label: string, value: string): Promise<{ id: string; label: string }>
}

type ModelDraft = {
  key: string
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  /** The pricing fold: collapsed rows carry no cost, whatever the inputs hold. */
  showCost: boolean
  costInput: string
  costOutput: string
  costCacheRead: string
  costCacheWrite: string
}

type EditorDraft = {
  accountId: string
  isNew: boolean
  /** The generated id a new entry falls back to when its label yields no slug. */
  fallbackId: string
  label: string
  baseUrl: string
  credentialRef: string
  models: ModelDraft[]
}

function failureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const details = 'details' in error ? (error as { details?: { code?: unknown } }).details : undefined
  if (typeof details?.code === 'string') return details.code
  const data = 'data' in error ? (error as { data?: { reason?: unknown } }).data : undefined
  if (typeof data?.reason === 'string') return data.reason
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * The endpoint precheck mirrors the wire layer's rules — no template, no inline credentials, no
 * query or fragment, and plain http only on loopback — so the form fails before the save round-trip.
 * The daemon re-checks every one of these.
 */
function endpointOk(value: string): boolean {
  if (/[{}]/.test(value) || /[?#]/.test(value) || value !== value.trim()) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username !== '' || url.password !== '' || url.hostname === '') return false
  if (url.protocol === 'http:') {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!(host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host))) return false
  }
  return true
}

const MODEL_ID = /^[^\p{Cc}\p{Z}\s]{1,256}$/u
const POSITIVE = /^[1-9]\d*$/
const PRICE = /^\d+(\.\d+)?$/

function blankModel(): ModelDraft {
  return {
    key: crypto.randomUUID(),
    id: '',
    name: '',
    contextWindow: '',
    maxTokens: '',
    showCost: false,
    costInput: '',
    costOutput: '',
    costCacheRead: '',
    costCacheWrite: '',
  }
}

function toDraft(model: ConfigModel): ModelDraft {
  return {
    key: crypto.randomUUID(),
    id: model.id,
    name: model.name,
    contextWindow: String(model.contextWindow ?? ''),
    maxTokens: String(model.maxTokens ?? ''),
    showCost: model.cost !== undefined,
    costInput: model.cost ? String(model.cost.input) : '',
    costOutput: model.cost ? String(model.cost.output) : '',
    costCacheRead: model.cost ? String(model.cost.cacheRead) : '',
    costCacheWrite: model.cost ? String(model.cost.cacheWrite) : '',
  }
}

/** The five editable fields become a stored model row; capability fields stay with the template. */
function readModels(rows: readonly ModelDraft[]): ConfigModel[] | undefined {
  if (rows.length === 0) return undefined
  const models: ConfigModel[] = []
  for (const row of rows) {
    const costs = [row.costInput, row.costOutput, row.costCacheRead, row.costCacheWrite]
    const priced = row.showCost && costs.some((value) => value.trim() !== '')
    if (
      !MODEL_ID.test(row.id) ||
      row.name.trim() === '' ||
      row.name.length > 256 ||
      !POSITIVE.test(row.contextWindow) ||
      !POSITIVE.test(row.maxTokens) ||
      (priced && !costs.every((value) => PRICE.test(value)))
    )
      return undefined
    models.push({
      id: row.id,
      name: row.name,
      contextWindow: Number(row.contextWindow),
      maxTokens: Number(row.maxTokens),
      ...(priced
        ? {
            cost: {
              input: Number(row.costInput),
              output: Number(row.costOutput),
              cacheRead: Number(row.costCacheRead),
              cacheWrite: Number(row.costCacheWrite),
            },
          }
        : {}),
    })
  }
  return new Set(models.map((model) => model.id)).size === models.length ? models : undefined
}

/**
 * What a new entry pre-fills per adapter, so the form asks only for a credential. Every value is a
 * draft: the user can edit all of it before saving. Keyed by adapter id so the next payload-only
 * adapter gets its own entry instead of a branch.
 */
const ADAPTER_PRESETS: Record<
  SideProviderId,
  { labelKey: string; baseUrl: string; models: () => ModelDraft[] }
> = {
  'typesafe-systemone': {
    labelKey: 'side.prefillLabel.typesafe-systemone',
    baseUrl: DEFAULT_BASE_URL,
    models: () => [
      {
        ...blankModel(),
        id: 'typesafe/jev-1.13-20260917',
        name: 'Jev 1.13 (2026-09-17)',
        contextWindow: '65536',
        maxTokens: '32768',
      },
    ],
  },
}

/**
 * The account id a new entry gets, derived from its label: lowercase kebab, within the account-id
 * rule, falling back to the generated id when the label has no ASCII letters or digits, and
 * suffixed when another account already has it.
 */
function accountIdFor(label: string, taken: ReadonlySet<string>, fallback: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  const root = slug || fallback
  let candidate = root
  for (let suffix = 2; taken.has(candidate); suffix++)
    candidate = `${root.slice(0, 44)}-${suffix}`
  return candidate
}

export function SideModelsPanel({
  client,
  configuration,
  canSave,
  onSaved,
  credentials,
}: {
  client: SideModelsClient
  configuration: ConfigSnapshot | undefined
  canSave: boolean
  onSaved(snapshot: ConfigSnapshot): Promise<void> | void
  credentials?: SideModelsCredentials
}) {
  const [locale] = useState(() =>
    createDocumentLocaleSource({
      [SIDE_MODELS_NAMESPACE]: sideModelsCatalog,
      // The badge text is the admin catalog's existing payload-only annotation, not a copy.
      '@agnes/web/runtime-settings': settingsCatalog,
    }),
  )
  const [store] = useState(() => credentials ?? new CredentialsApi())
  useEffect(() => () => locale.dispose(), [locale])
  return (
    <UiLocaleProvider source={locale.source}>
      <SideModels
        client={client}
        configuration={configuration}
        canSave={canSave}
        onSaved={onSaved}
        credentials={store}
      />
    </UiLocaleProvider>
  )
}

/** Mount helper for the settings controller's renderRegion, mirroring modelSlotsPanel. */
export function sideModelsPanel(props: {
  client: SideModelsClient
  configuration: ConfigSnapshot | undefined
  canSave: boolean
  onSaved(snapshot: ConfigSnapshot): Promise<void> | void
  credentials?: SideModelsCredentials
}) {
  return <SideModelsPanel key={props.configuration?.revision ?? 'loading'} {...props} />
}

function SideModels({
  client,
  configuration,
  canSave,
  onSaved,
  credentials,
}: {
  client: SideModelsClient
  configuration: ConfigSnapshot | undefined
  canSave: boolean
  onSaved(snapshot: ConfigSnapshot): Promise<void> | void
  credentials: SideModelsCredentials
}) {
  const { t, hostT } = useUiText(SIDE_MODELS_NAMESPACE, sideModelsCatalog)
  const accounts = (configuration?.accounts ?? []).filter((row) =>
    (SIDE_PROVIDERS as readonly string[]).includes(row.providerId),
  )
  const [draft, setDraft] = useState<EditorDraft>()
  const [removing, setRemoving] = useState<string>()
  const [copied, setCopied] = useState<string>()
  const copyTimers = useRef<number[]>([])
  useEffect(() => {
    const timers = copyTimers.current
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [])
  const copyRoute = async (accountId: string, route: string) => {
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
  const [testState, setTestState] = useState('')
  const [options, setOptions] = useState<readonly { id: string; label: string }[]>([])
  const [newLabel, setNewLabel] = useState('')
  const [newValue, setNewValue] = useState('')
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
  const openAdd = () => {
    setStatus('')
    setTestState('')
    const preset = ADAPTER_PRESETS[draftProvider()]
    setDraft({
      accountId: '',
      isNew: true,
      fallbackId: `jev-${crypto.randomUUID().slice(0, 8)}`,
      label: t(preset.labelKey),
      baseUrl: preset.baseUrl,
      credentialRef: '',
      models: preset.models(),
    })
  }
  const openEdit = (account: ConfigAccount) => {
    setStatus('')
    setTestState('')
    setDraft({
      accountId: account.accountId,
      isNew: false,
      fallbackId: '',
      label: account.label,
      baseUrl: account.baseUrl,
      credentialRef: '',
      models: account.models.map(toDraft),
    })
  }
  const patch = (next: Partial<EditorDraft>) => {
    setStatus('')
    setTestState('')
    setDraft((current) => (current ? { ...current, ...next } : current))
  }
  const patchModel = (index: number, next: Partial<ModelDraft>) => {
    setStatus('')
    setDraft((current) =>
      current
        ? {
            ...current,
            models: current.models.map((row, at) => (at === index ? { ...row, ...next } : row)),
          }
        : current,
    )
  }
  const valid = (current: EditorDraft): ConfigModel[] | undefined => {
    if (current.label.trim() === '' || current.label.length > 128) return undefined
    if (!endpointOk(current.baseUrl)) return undefined
    if (current.isNew && current.credentialRef === '') return undefined
    return readModels(current.models)
  }

  const save = async () => {
    if (!draft || busy || !canSave) return
    const models = valid(draft)
    if (!models) {
      setStatus('side.invalid')
      return
    }
    const prior = accounts.find((row) => row.accountId === draft.accountId)
    const selected =
      prior && models.some((model) => model.id === prior.model) ? prior.model : (models[0]?.id ?? '')
    setBusy(true)
    setStatus('')
    try {
      const saved = await client.save({
        providerId: draftProvider(),
        accountId: draft.isNew ? accountIdFor(draft.label, takenIds, draft.fallbackId) : draft.accountId,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl,
        ...(draft.credentialRef === '' ? {} : { credentialRef: draft.credentialRef }),
        model: selected,
        models,
        expectedRevision: revision,
      })
      await onSaved(saved)
      setDraft(undefined)
      setStatus(saved.effect === 'restart-required' ? 'side.savedRestart' : 'side.saved')
    } catch (error) {
      if (failureCode(error) === 'CONFIG_REVISION_CONFLICT') {
        // The read model moved under the editor: reload it before letting anyone retry.
        await onSaved(await client.get())
        setDraft(undefined)
        setStatus('side.conflict')
      } else {
        setStatus('side.failed')
      }
    } finally {
      setBusy(false)
    }
  }

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
      const result = await client.test({
        providerId: draftProvider(),
        ...(draft.isNew ? {} : { accountId: draft.accountId }),
        baseUrl: draft.baseUrl,
        ...(draft.credentialRef === '' ? {} : { credentialRef: draft.credentialRef }),
        model,
      })
      setTestState(result.verified ? 'side.testOk' : 'side.testFailed')
    } catch (error) {
      setTestState(
        failureCode(error) === 'CONFIG_CREDENTIAL_REJECTED' ? 'side.testRejected' : 'side.testFailed',
      )
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

  const createCredential = async () => {
    if (busy || newLabel.trim() === '' || newValue.trim() === '') return
    setBusy(true)
    try {
      const item = await credentials.create(newLabel.trim(), newValue.trim())
      setOptions((current) => [...current, item])
      setNewLabel('')
      setNewValue('')
      patch({ credentialRef: item.id })
    } catch {
      setStatus('side.failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="capability-panel" data-testid="side-models">
      <SettingsGroup role="group" aria-labelledby="side-models-title">
        <SettingsItem
          icon="git-branch"
          label={<span data-testid="side-models-title">{t('side.title')}</span>}
          labelId="side-models-title"
          description={<span data-testid="side-models-note">{t('side.note')}</span>}
        />
        {accounts.length === 0 && !draft && (
          <SettingsItem label={t('side.empty')} data-testid="side-models-empty" />
        )}
        {accounts.map((account) => (
          <SettingsGroup key={account.accountId} data-testid={`side-model-${account.accountId}`}>
            <SettingsItem
              icon="globe"
              label={account.label}
              description={
                <>
                  <span data-testid="side-model-badge">
                    <Badge tone="warn">{hostT('providerCapability.payloadOnly')}</Badge>
                  </span>{' '}
                  <span translate="no">
                    {t(`side.adapter.${account.providerId}`)} · {account.route} · {account.baseUrl} ·{' '}
                    {t('side.modelCount', { count: account.models.length })} ·{' '}
                    {t(account.credentialConfigured ? 'side.credentialConfigured' : 'side.credentialMissing')}
                  </span>
                  <br />
                  <span data-testid="side-model-route-hint">{t('side.routeHint')}</span>
                </>
              }
            >
              <Button
                data-testid={`side-model-copy-${account.accountId}`}
                disabled={busy}
                onClick={() => void copyRoute(account.accountId, account.route)}
              >
                {t('side.copyRoute')}
              </Button>
              {copied === account.accountId && (
                <span role="status" data-testid={`side-model-copied-${account.accountId}`}>
                  {t('side.copied')}
                </span>
              )}
              <StateSwitch
                testId={`side-model-toggle-${account.accountId}`}
                label={t('side.enabled')}
                checked={account.enabled}
                disabled={!canSave || busy}
                onToggle={(next) => void act(account.accountId, next ? 'enable' : 'disable')}
              />
              <Button
                data-testid={`side-model-edit-${account.accountId}`}
                disabled={!canSave || busy}
                onClick={() => openEdit(account)}
              >
                {t('side.edit')}
              </Button>
              <Button
                data-testid={`side-model-remove-${account.accountId}`}
                disabled={!canSave || busy}
                onClick={() => {
                  if (removing === account.accountId) void act(account.accountId, 'remove')
                  else setRemoving(account.accountId)
                }}
              >
                {removing === account.accountId ? t('side.removeConfirm') : t('side.remove')}
              </Button>
            </SettingsItem>
          </SettingsGroup>
        ))}
        <SettingsItem label={t('side.add')}>
          <Button
            appearance="primary"
            data-testid="side-model-add"
            disabled={!canSave || busy}
            onClick={openAdd}
          >
            {t('side.add')}
          </Button>
        </SettingsItem>
        {draft && (
          <div className="capability-engine-fields" data-testid="side-editor">
            <SettingsItem label={t('side.adapter')}>
              <SettingsSelect data-testid="side-adapter" value={draftProvider()} disabled>
                {SIDE_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {t(`side.adapter.${id}`)}
                  </option>
                ))}
              </SettingsSelect>
            </SettingsItem>
            <SettingsItem
              label={t('side.label')}
              description={
                draft.isNew ? (
                  <span data-testid="side-route-preview">
                    {t('side.routePreview', {
                      route: `account-${accountIdFor(draft.label, takenIds, draft.fallbackId)}`,
                    })}
                  </span>
                ) : undefined
              }
            >
              <SettingsInput
                data-testid="side-label"
                value={draft.label}
                disabled={busy}
                onChange={(event) => patch({ label: event.target.value })}
              />
            </SettingsItem>
            <SettingsItem label={t('side.baseUrl')}>
              <SettingsInput
                data-testid="side-base-url"
                value={draft.baseUrl}
                disabled={busy}
                onChange={(event) => patch({ baseUrl: event.target.value })}
              />
            </SettingsItem>
            <SettingsItem label={t('side.credential')}>
              <SettingsSelect
                data-testid="side-credential"
                value={draft.credentialRef}
                disabled={busy}
                onChange={(event) => patch({ credentialRef: event.target.value })}
              >
                <option value="">{t(draft.isNew ? 'side.credentialChoose' : 'side.credentialKeep')}</option>
                {options.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </SettingsSelect>
            </SettingsItem>
            <SettingsItem label={t('side.credentialCreate')} stacked>
              <div>
                <SettingsInput
                  data-testid="side-credential-new-label"
                  placeholder={t('side.credentialNewLabel')}
                  value={newLabel}
                  disabled={busy}
                  onChange={(event) => setNewLabel(event.target.value)}
                />
                <SettingsInput
                  data-testid="side-credential-new-value"
                  placeholder={t('side.credentialNewValue')}
                  type="password"
                  value={newValue}
                  disabled={busy}
                  onChange={(event) => setNewValue(event.target.value)}
                />
                <Button
                  data-testid="side-credential-create"
                  disabled={busy || newLabel.trim() === '' || newValue.trim() === ''}
                  onClick={() => void createCredential()}
                >
                  {t('side.credentialCreate')}
                </Button>
              </div>
            </SettingsItem>
            <SettingsItem label={t('side.models')} stacked>
              <div>
                {draft.models.map((row, index) => (
                  <div key={row.key} data-testid={`side-model-row-${index}`}>
                    <SettingsInput
                      data-testid={`side-model-id-${index}`}
                      placeholder={t('side.modelId')}
                      value={row.id}
                      disabled={busy}
                      onChange={(event) => patchModel(index, { id: event.target.value })}
                    />
                    <SettingsInput
                      data-testid={`side-model-name-${index}`}
                      placeholder={t('side.modelName')}
                      value={row.name}
                      disabled={busy}
                      onChange={(event) => patchModel(index, { name: event.target.value })}
                    />
                    <SettingsInput
                      data-testid={`side-model-context-${index}`}
                      placeholder={t('side.modelContext')}
                      inputMode="numeric"
                      value={row.contextWindow}
                      disabled={busy}
                      onChange={(event) => patchModel(index, { contextWindow: event.target.value })}
                    />
                    <SettingsInput
                      data-testid={`side-model-tokens-${index}`}
                      placeholder={t('side.modelTokens')}
                      inputMode="numeric"
                      value={row.maxTokens}
                      disabled={busy}
                      onChange={(event) => patchModel(index, { maxTokens: event.target.value })}
                    />
                    <Button
                      data-testid={`side-model-cost-toggle-${index}`}
                      aria-expanded={row.showCost}
                      disabled={busy}
                      onClick={() => patchModel(index, { showCost: !row.showCost })}
                    >
                      {t('side.costToggle')}
                    </Button>
                    {row.showCost && (
                      <>
                        <SettingsInput
                          data-testid={`side-model-cost-input-${index}`}
                          placeholder={t('side.modelCost')}
                          inputMode="decimal"
                          value={row.costInput}
                          disabled={busy}
                          onChange={(event) => patchModel(index, { costInput: event.target.value })}
                        />
                        <SettingsInput
                          data-testid={`side-model-cost-output-${index}`}
                          placeholder={t('side.costOutput')}
                          inputMode="decimal"
                          value={row.costOutput}
                          disabled={busy}
                          onChange={(event) => patchModel(index, { costOutput: event.target.value })}
                        />
                        <SettingsInput
                          data-testid={`side-model-cost-cache-read-${index}`}
                          placeholder={t('side.costCacheRead')}
                          inputMode="decimal"
                          value={row.costCacheRead}
                          disabled={busy}
                          onChange={(event) => patchModel(index, { costCacheRead: event.target.value })}
                        />
                        <SettingsInput
                          data-testid={`side-model-cost-cache-write-${index}`}
                          placeholder={t('side.costCacheWrite')}
                          inputMode="decimal"
                          value={row.costCacheWrite}
                          disabled={busy}
                          onChange={(event) => patchModel(index, { costCacheWrite: event.target.value })}
                        />
                      </>
                    )}
                    {draft.models.length > 1 && (
                      <Button
                        data-testid={`side-model-row-remove-${index}`}
                        disabled={busy}
                        onClick={() =>
                          setDraft((current) =>
                            current
                              ? { ...current, models: current.models.filter((_, at) => at !== index) }
                              : current,
                          )
                        }
                      >
                        {t('side.modelRemove')}
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  data-testid="side-model-row-add"
                  disabled={busy}
                  onClick={() =>
                    setDraft((current) =>
                      current ? { ...current, models: [...current.models, blankModel()] } : current,
                    )
                  }
                >
                  {t('side.modelAdd')}
                </Button>
              </div>
            </SettingsItem>
            <p data-testid="side-test-note">{t('side.testNote')}</p>
            {testState && (
              <span role={testState === 'side.testOk' ? 'status' : 'alert'} data-testid="side-test-status">
                {t(testState)}
              </span>
            )}
            <div className="capability-save">
              <Button data-testid="side-test" disabled={busy} onClick={() => void probe()}>
                {t('side.test')}
              </Button>
              <Button data-testid="side-cancel" disabled={busy} onClick={() => setDraft(undefined)}>
                {t('side.cancel')}
              </Button>
              <Button
                appearance="primary"
                data-testid="side-save"
                disabled={!canSave || busy}
                onClick={() => void save()}
              >
                {t('side.save')}
              </Button>
            </div>
          </div>
        )}
        <div className="capability-save">
          <span
            role={status && status !== 'side.saved' && status !== 'side.savedRestart' ? 'alert' : 'status'}
            data-tone={status === 'side.saved' || status === 'side.savedRestart' ? 'success' : 'error'}
            data-testid={status ? 'side-models-status' : undefined}
          >
            {status ? t(status) : ''}
          </span>
        </div>
      </SettingsGroup>
    </div>
  )
}
