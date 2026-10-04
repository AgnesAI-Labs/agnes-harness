import type {
  ConfigAccount,
  ConfigAccountInput,
  ConfigModel,
  ConfigProvider,
  ConfigSnapshot,
  ConfigTestResult,
  ModelSettings,
  ThinkingLevel,
} from '@agnes/protocol'
import { minimumContextBudget } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import {
  modelThinkingOptions,
  parseContextBudget,
  renderRegion,
  SettingsAccounts,
  setSettingsSelectOptions,
  unmountRegion,
} from '@agnes/web-ui'
import { createElement } from 'react'
import { oauthControls } from './oauth-controls.js'
import type { Translate } from './presentation.js'
import { createAccountPickers } from './provider-picker.js'

export type SettingsControllerOptions = {
  client: Client
  onSaved(snapshot: ConfigSnapshot): Promise<void>
  onError(error: unknown): void
  t: Translate
}

export type SettingsController = {
  open(): Promise<void>
  close(): void
  refreshLocale(): void
  setConnected(connected: boolean): void
}

type AsyncPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

const CONFIGURATION_REASON_KEYS: Readonly<Record<string, string>> = {
  CONFIG_AUTH_FAILED: 'settings.config.authFailed',
  CONFIG_AUTH_EXPIRED: 'settings.config.authExpired',
  CONFIG_AUTH_BUSY: 'settings.config.authBusy',
  CONFIG_INVALID_INPUT: 'settings.config.invalidInput',
  CONFIG_UNKNOWN_PROVIDER: 'settings.config.unknownProvider',
  CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED: 'settings.config.endpointUnsupported',
  CONFIG_CREDENTIAL_REQUIRED: 'settings.config.credentialRequired',
  CONFIG_CREDENTIAL_STORE: 'settings.config.credentialStore',
  CONFIG_PROVIDER_UNAVAILABLE: 'settings.config.providerUnavailable',
  CONFIG_TEST_FAILED: 'settings.config.testFailed',
  CONFIG_SUBSCRIPTION_AUTH: 'settings.config.subscriptionAuth',
  CONFIG_SUBSCRIPTION_QUOTA: 'settings.config.subscriptionQuota',
  CONFIG_SUBSCRIPTION_RATE_LIMIT: 'settings.config.subscriptionRateLimit',
  CONFIG_SUBSCRIPTION_TIMEOUT: 'settings.config.subscriptionTimeout',
  CONFIG_SUBSCRIPTION_MODEL: 'settings.config.subscriptionModel',
  CONFIG_SUBSCRIPTION_FAILED: 'settings.config.subscriptionFailed',
  CONFIG_MODEL_UNAVAILABLE: 'settings.config.modelUnavailable',
  CONFIG_REVISION_CONFLICT: 'settings.config.revisionConflict',
  CONFIG_PERSIST_FAILED: 'settings.config.persistFailed',
  CONFIG_INVALID_STATE: 'settings.config.invalidState',
}

function configurationReason(error: unknown, t: (key: string) => string): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const data =
    'data' in error && error.data !== null && typeof error.data === 'object' ? error.data : undefined
  const reason = data && 'reason' in data && typeof data.reason === 'string' ? data.reason : undefined
  const key = reason === undefined ? undefined : CONFIGURATION_REASON_KEYS[reason]
  return key === undefined ? undefined : t(key)
}

type SettingsElements = {
  dialog: HTMLDialogElement
  form: HTMLFormElement
  provider: HTMLSelectElement
  authMethod: HTMLSelectElement
  authMethodField: HTMLElement
  oauthMount: HTMLElement
  baseUrl: HTMLInputElement
  apiKey: HTMLInputElement
  test: HTMLButtonElement
  models: HTMLSelectElement
  thinking?: HTMLSelectElement | undefined
  contextWindow?: HTMLInputElement | undefined
  modelSettingsHint?: HTMLParagraphElement | undefined
  save: HTMLButtonElement
  error: HTMLParagraphElement
  state: HTMLParagraphElement
  keyHint: HTMLParagraphElement | undefined
  retry: HTMLButtonElement | undefined
  close: HTMLButtonElement
}

function element<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const found = document.getElementById(id)
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return found as HTMLElementTagNameMap[K]
}

function optionalElement<K extends keyof HTMLElementTagNameMap>(
  id: string,
  tag: K,
): HTMLElementTagNameMap[K] | undefined {
  const found = document.getElementById(id)
  return found?.tagName.toLowerCase() === tag ? (found as HTMLElementTagNameMap[K]) : undefined
}

function readElements(): SettingsElements {
  return {
    dialog: element('config', 'dialog'),
    form: element('config-form', 'form'),
    provider: element('config-provider', 'select'),
    authMethod: element('config-auth-method', 'select'),
    authMethodField: element('config-auth-method-field', 'label'),
    oauthMount: element('config-oauth-controls', 'div'),
    baseUrl: element('config-base-url', 'input'),
    apiKey: element('config-api-key', 'input'),
    test: element('config-test', 'button'),
    models: element('config-model', 'select'),
    thinking: optionalElement('config-thinking', 'select'),
    contextWindow: optionalElement('config-context-window', 'input'),
    modelSettingsHint: optionalElement('config-model-settings-hint', 'p'),
    save: element('config-save', 'button'),
    error: element('config-error', 'p'),
    state: element('config-state', 'p'),
    keyHint: optionalElement('config-key-hint', 'p'),
    retry: optionalElement('config-retry', 'button'),
    close: element('config-close', 'button'),
  }
}

const option = (label: string, value: string) => ({ label, value })

function errorText(error: unknown, secret: string, t: (key: string) => string): string {
  const message =
    configurationReason(error, t) ??
    (error instanceof Error ? error.message : t('settings.config.requestFailed'))
  return secret ? message.split(secret).join('[redacted]') : message
}

function focusable(value: Element | null): value is HTMLElement {
  return value !== null && typeof (value as HTMLElement).focus === 'function'
}

/**
 * Owns only the configuration dialog. The app supplies the SDK client and decides what a saved
 * snapshot means for the current session; this controller never creates a second client or reads
 * provider credentials from another store.
 */
export function createSettingsController(options: SettingsControllerOptions): SettingsController {
  const { t } = options
  const ui = readElements()
  const providerPicker = createAccountPickers(ui, t)
  let connected = true
  let configuration: ConfigSnapshot | undefined
  // The model pane is independently reconcilable. Resolve its list/button at the point of use;
  // keeping either reference here would make a reopened settings dialog target a detached pane.
  const accountList = () => optionalElement('config-accounts', 'div')
  let renderedAccountList: HTMLElement | undefined
  const addAccount = () => optionalElement('config-add-account', 'button')
  // The account dialog itself belongs to the stable settings shell, so an in-flight edit survives
  // a model-pane replacement.
  const accountDialog = optionalElement('account-dialog', 'dialog')
  const accountDialogTitle = optionalElement('config-detail-title', 'h3')
  const accountDialogContext = optionalElement('config-account-context', 'p')
  const accountName = optionalElement('config-account-name', 'input')
  let editingId: string | undefined
  let removingId: string | undefined
  const selectedAccount = (): ConfigAccount | undefined =>
    configuration?.accounts?.find((row) => row.accountId === editingId)
  const savedProvider = () => {
    const row = selectedAccount()
    return configuration?.accounts !== undefined
      ? row
        ? {
            id: row.providerId,
            model: row.model,
            baseUrl: row.baseUrl,
            credentialConfigured: row.credentialConfigured,
            authType: row.authType,
          }
        : undefined
      : configuration?.provider
  }
  let providers: ConfigProvider[] = []
  const modelDrafts = new Map<string, ModelSettings>()
  let tested: ConfigTestResult | undefined
  let testPending = false
  let savePending = false
  let loadPhase: AsyncPhase = 'idle'
  let testGeneration = 0
  let revision = 0
  let lifecycle = 0
  let opening: Promise<void> | undefined
  let focusReturn: HTMLElement | null = null
  let suggestedAccountLabel: string | undefined
  const providerId = () => ui.provider.value.split(':')[0] ?? ''
  const canUseSavedModels = (): boolean => {
    const account = selectedAccount()
    return (
      !!account &&
      !!tested?.models.length &&
      account.providerId === providerId() &&
      account.authType === ui.authMethod.value &&
      account.baseUrl.replace(/\/$/, '') === ui.baseUrl.value.trim().replace(/\/$/, '') &&
      !ui.apiKey.value
    )
  }
  const authMethods = (provider: ConfigProvider) => provider.authMethods ?? [provider.authType ?? 'api-key']
  const providerValue = (provider: ConfigProvider, auth: string) =>
    auth === 'oauth' && authMethods(provider).includes('api-key') ? `${provider.id}:oauth` : provider.id
  const isOAuth = () => ui.authMethod.value === 'oauth'
  const hasUnverifiedSavedChanges = (): boolean => {
    const account = selectedAccount()
    if (!account || !canUseSavedModels()) return false
    const name = accountName?.value.trim()
    return ui.models.value !== account.model || (!!name && name !== account.label)
  }

  const oauth = oauthControls(ui.oauthMount, options.client.config, t, {
    input: () => {
      const provider = providers.find((row) => row.id === providerId())
      if (!configuration || !editingId || !accountName || !provider)
        throw new Error(t('settings.account.notLoaded'))
      const label = accountName.value.trim() || provider.label
      if (!accountName.value.trim()) suggestedAccountLabel = label
      accountName.value = label
      return {
        action: 'start',
        providerId: provider.id,
        accountId: editingId,
        label,
        expectedRevision: configuration.revision,
      }
    },
    provider: () => providers.find((provider) => provider.id === providerId()),
    pending: (value) => {
      testGeneration += 1
      testPending = value
      if (value) ui.error.textContent = ''
      updateButtons()
    },
    ready: (models) => {
      tested = models.length ? { models, verified: true } : undefined
      ui.state.textContent = models.length
        ? t('settings.oauth.authorizedVerify')
        : testPending
          ? t('settings.oauth.awaitingAuth')
          : t('settings.oauth.cancelled')
      renderModels()
      if (models.length) ui.models.focus()
    },
    error: (error) => setError(error),
  })
  const modelReadyForSave = (): boolean =>
    !!tested?.verified ||
    (isOAuth() && oauth.operation() !== undefined && ui.models.value !== '') ||
    hasUnverifiedSavedChanges()
  const current = (token: number, inputRevision?: number): boolean =>
    token === lifecycle && ui.dialog.open && (inputRevision === undefined || inputRevision === revision)

  const setError = (error: unknown): void => {
    const secret = ui.apiKey.value
    const translated = configurationReason(error, t)
    const message = translated ?? errorText(error, secret, t)
    ui.error.textContent = message
    ui.state.textContent = ''
    try {
      // Provider failures can echo request details. Do not pass a raw credential to the app-level
      // notice sink; preserving the original error is safe only when no redaction or translation
      // was required.
      options.onError(secret || translated ? new Error(message) : error)
    } catch {
      // An app-level error sink cannot break the dialog's own cleanup path.
    }
  }

  const setLoadPhase = (phase: AsyncPhase): void => {
    loadPhase = phase
    const currentAccountList = accountList()
    if (currentAccountList) currentAccountList.dataset.state = phase
    if (ui.retry) ui.retry.hidden = phase !== 'error'
    if (phase === 'loading') ui.state.textContent = t('settings.state.reading')
    if (phase === 'error') ui.state.textContent = t('settings.state.readFailed')
    updateButtons()
  }

  const updateButtons = (): void => {
    const busy = loadPhase === 'loading' || testPending || savePending
    const oauthSelected = isOAuth()
    oauth.visible(oauthSelected)
    oauth.disabled(!connected || busy)
    if (ui.apiKey.closest('label')) (ui.apiKey.closest('label') as HTMLElement).hidden = oauthSelected
    ui.provider.disabled =
      !connected || busy || oauth.operation() !== undefined || selectedAccount() !== undefined
    ui.authMethod.disabled = !connected || busy || oauth.operation() !== undefined
    if (accountName) accountName.disabled = !connected || busy || oauth.operation() !== undefined
    const currentAddAccount = addAccount()
    if (currentAddAccount) currentAddAccount.disabled = !connected || busy
    renderAccounts()
    ui.baseUrl.disabled = !connected || busy || oauthSelected
    ui.apiKey.disabled = !connected || busy || oauthSelected
    ui.test.disabled =
      !connected ||
      busy ||
      (oauthSelected && (oauth.operation() ? !tested?.models.length || !ui.models.value : !selectedAccount()))
    ui.models.disabled = !connected || busy || !tested?.models.length || (!oauthSelected && !tested.verified)
    if (ui.thinking) ui.thinking.disabled = ui.models.disabled
    if (ui.contextWindow) ui.contextWindow.disabled = ui.models.disabled
    ui.save.disabled =
      !connected || busy || !modelReadyForSave() || !tested?.models.length || ui.models.value === ''
    providerPicker.sync()
  }

  const renderModels = (models: readonly ConfigModel[] = tested?.models ?? []): void => {
    const previousModel = ui.models.value
    setSettingsSelectOptions(ui.models, [
      option(models.length ? t('settings.model.chooseSaved') : t('settings.model.testFirst'), ''),
      ...models.map((model) => option(`${model.name} · ${model.id}`, model.id)),
    ])
    const savedModel = models.some((model) => model.id === previousModel)
      ? previousModel
      : (savedProvider()?.model ?? (models.length === 1 ? models[0]?.id : undefined))
    ui.models.value = savedModel && models.some((model) => model.id === savedModel) ? savedModel : ''
    renderModelSettings()
    updateButtons()
  }

  const readModelSettings = (): ModelSettings => {
    const model = tested?.models.find((entry) => entry.id === ui.models.value)
    const thinking = ui.thinking?.value ?? model?.defaultSettings?.thinking
    const window = ui.contextWindow?.value.trim() ?? String(model?.defaultSettings?.contextWindow ?? '')
    const tokens = parseContextBudget(window)
    if (
      thinking &&
      !modelThinkingOptions(model?.thinkingLevelMap, t).some((option) => option.value === thinking)
    ) {
      ui.thinking?.setAttribute('aria-invalid', 'true')
      throw new Error(t('settings.model.thinkingUnsupported'))
    }
    ui.thinking?.setAttribute('aria-invalid', 'false')
    if (
      window &&
      (tokens === undefined ||
        tokens < minimumContextBudget(model?.contextWindow) ||
        (model?.contextWindow !== undefined && tokens > model.contextWindow))
    ) {
      ui.contextWindow?.setAttribute('aria-invalid', 'true')
      throw new Error(
        t('settings.model.contextRange', {
          min: minimumContextBudget(model?.contextWindow).toLocaleString(),
        }),
      )
    }
    ui.contextWindow?.setAttribute('aria-invalid', 'false')
    return {
      ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
      ...(tokens === undefined ? {} : { contextWindow: tokens }),
    }
  }
  const renderModelSettings = (): void => {
    const model = tested?.models.find((entry) => entry.id === ui.models.value)
    const defaults =
      modelDrafts.get(ui.models.value) ??
      selectedAccount()?.models.find((entry) => entry.id === ui.models.value)?.defaultSettings ??
      model?.defaultSettings ??
      {}
    if (ui.thinking) {
      const options = modelThinkingOptions(model?.thinkingLevelMap, t)
      if (defaults.thinking && !options.some((option) => option.value === defaults.thinking))
        options.push({
          value: defaults.thinking,
          label: t('settings.model.savedThinkingUnavailable', { value: defaults.thinking }),
        })
      setSettingsSelectOptions(ui.thinking, options)
      ui.thinking.value = defaults.thinking ?? ''
    }
    if (ui.contextWindow) {
      ui.contextWindow.value = String(defaults.contextWindow ?? '')
      if (model?.contextWindow) ui.contextWindow.max = String(model.contextWindow)
      else ui.contextWindow.removeAttribute('max')
      ui.contextWindow.setAttribute('aria-invalid', 'false')
    }
    if (ui.modelSettingsHint)
      ui.modelSettingsHint.textContent =
        (model?.contextWindow
          ? `${t('settings.model.capacity', { tokens: model.contextWindow.toLocaleString() })} `
          : '') + t('settings.model.budgetHint')
  }

  const renderKeyHint = (): void => {
    if (!ui.keyHint) return
    const reusesSavedKey =
      connected && savedProvider()?.id === providerId() && savedProvider()?.credentialConfigured
    if (isOAuth()) {
      ui.keyHint.textContent = t('settings.key.oauthHint')
      return
    }
    ui.keyHint.textContent = reusesSavedKey
      ? t('settings.key.savedHint')
      : connected
        ? t('settings.key.inputHint')
        : t('settings.key.offlineCleared')
  }

  const renderProviders = (): void => {
    const savedProviderId = savedProvider()?.id
    const groups = (['api-key', 'oauth'] as const).map((method) => ({
      label: method === 'oauth' ? t('settings.provider.subscriptionLogin') : 'API Key',
      options: providers
        .filter((provider) => authMethods(provider).includes(method))
        .map((provider) =>
          option(
            method === 'oauth'
              ? `${provider.label.replace(/\s*subscription$/i, '')}${t('settings.provider.subscriptionLoginSuffix')}`
              : provider.label,
            providerValue(provider, method),
          ),
        ),
    }))
    setSettingsSelectOptions(
      ui.provider,
      [option(providers.length ? t('settings.provider.choose') : t('settings.provider.none'), '')],
      groups,
    )
    if (savedProviderId && providers.some((provider) => provider.id === savedProviderId))
      ui.provider.value = savedProviderId
    else if (providers[0]) ui.provider.value = providers[0].id
    const selected = providers.find((provider) => provider.id === providerId())
    const methods = selected?.authMethods ?? [selected?.authType ?? 'api-key']
    setSettingsSelectOptions(
      ui.authMethod,
      methods.map((method) =>
        option(method === 'oauth' ? t('settings.provider.subscriptionLogin') : 'API Key', method),
      ),
    )
    const saved = savedProvider()
    const savedAuth = saved && 'authType' in saved ? saved.authType : undefined
    ui.authMethod.value = savedAuth && methods.includes(savedAuth) ? savedAuth : (methods[0] ?? 'api-key')
    if (selected) ui.provider.value = providerValue(selected, ui.authMethod.value)
    ui.authMethodField.hidden = methods.length < 2
    ui.baseUrl.value = savedProvider()?.baseUrl ?? selected?.baseUrl ?? ''
    // A saved credential is represented only by credentialConfigured. It is never read back here.
    ui.apiKey.value = ''
    renderKeyHint()
  }

  const resetTest = (clearError = true): void => {
    revision += 1
    testGeneration += 1
    testPending = false
    const saved = selectedAccount()
    tested = saved?.models.length ? { models: saved.models, verified: false } : undefined
    ui.models.value = ''
    renderModels()
    if (clearError) ui.error.textContent = ''
    ui.state.textContent = t('settings.state.connectionChanged')
  }

  const input = (): { providerId: string; accountId?: string; baseUrl?: string; apiKey?: string } => {
    const selectedId = providerId()
    const selected = providers.find((provider) => provider.id === selectedId)
    if (!selectedId || !selected) throw new Error(t('settings.provider.required'))
    const baseUrl = ui.baseUrl.value.trim()
    const apiKey = ui.apiKey.value
    if (!isOAuth() && selectedAccount()?.authType === 'oauth' && !apiKey)
      throw new Error(t('settings.provider.switchKeyRequired'))
    return {
      providerId: selectedId,
      ...(editingId ? { accountId: editingId } : {}),
      // An explicit provider default must survive the client boundary so Host can reset a saved
      // custom endpoint. An empty field remains an omitted override per Config*Input semantics.
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    }
  }

  const show = (): void => {
    if (ui.dialog.open) return
    try {
      ui.dialog.showModal()
    } catch {
      // Minimal DOM implementations and older embedders may expose only the open attribute.
      ui.dialog.setAttribute('open', '')
    }
  }

  const closeDialog = (): void => {
    if (ui.dialog.open) {
      try {
        ui.dialog.close()
      } catch {
        ui.dialog.removeAttribute('open')
      }
    }
  }

  const close = (): void => {
    oauth.clear()
    testPending = false
    closeAccountDialog()
    lifecycle += 1
    revision += 1
    opening = undefined
    tested = undefined
    loadPhase = 'idle'
    const currentAccountList = accountList()
    if (currentAccountList) currentAccountList.dataset.state = 'idle'
    if (ui.retry) ui.retry.hidden = true
    renderModels()
    ui.apiKey.value = ''
    closeDialog()
    updateButtons()
    const target = focusReturn
    focusReturn = null
    if (focusable(target) && target.isConnected !== false) target.focus()
  }

  const load = async (token: number): Promise<void> => {
    if (current(token)) setLoadPhase('loading')
    try {
      const [snapshot, result] = await Promise.all([
        options.client.config.get(),
        options.client.config.providers(),
      ])
      if (!current(token)) return
      configuration = snapshot
      editingId = snapshot.defaultAccountId ?? snapshot.accounts?.[0]?.accountId
      if (snapshot.accounts && !editingId) editingId = `acct-${crypto.randomUUID()}`
      if (accountName) accountName.value = selectedAccount()?.label ?? ''
      removingId = undefined
      renderAccounts()
      providers = [...result.providers].sort((a, b) => +(b.id === 'agnes-ai') - +(a.id === 'agnes-ai'))
      tested = undefined
      ui.error.textContent = ''
      ui.state.textContent = snapshot.configured ? t('settings.step.loadedSaved') : t('settings.step.first')
      renderProviders()
      renderModels()
      setLoadPhase(snapshot.accounts?.length ? 'ready' : 'empty')
    } catch (error) {
      if (current(token)) {
        setError(error)
        setLoadPhase('error')
      }
    }
  }

  const test = async (): Promise<void> => {
    if (!connected || testPending || savePending) return
    const token = lifecycle
    const inputRevision = revision
    const generation = ++testGeneration
    const ownsTest = () => current(token, inputRevision) && generation === testGeneration
    const oauthId = isOAuth() ? oauth.operation() : undefined
    if (oauthId) {
      const model = ui.models.value
      if (!model) return
      testPending = true
      ui.error.textContent = ''
      ui.state.textContent = t('settings.step.testingModel')
      updateButtons()
      try {
        await options.client.config.oauth({ action: 'test', operationId: oauthId, model })
        if (ownsTest()) {
          if (tested) tested = { ...tested, verified: true }
          ui.state.textContent = t('settings.step.modelVerified')
        }
      } catch (error) {
        if (ownsTest()) setError(error)
      } finally {
        if (ownsTest()) {
          testPending = false
          updateButtons()
        }
      }
      return
    }
    let request: ReturnType<typeof input>
    try {
      request = input()
    } catch (error) {
      setError(error)
      return
    }
    testPending = true
    ui.error.textContent = ''
    ui.state.textContent = t('settings.step.second')
    updateButtons()
    try {
      const result = await options.client.config.test({
        ...request,
        ...(isOAuth() && ui.models.value ? { model: ui.models.value } : {}),
      })
      if (!ownsTest()) return
      if (isOAuth()) tested = result
      if (!result.verified || result.models.length === 0) throw new Error(t('settings.provider.noCatalog'))
      tested = result
      ui.state.textContent = t('settings.step.third', { count: result.models.length })
      ui.error.textContent = ''
      renderModels(result.models)
    } catch (error) {
      if (!ownsTest()) return
      tested = isOAuth() && tested ? { ...tested, verified: false } : undefined
      renderModels()
      setError(error)
    } finally {
      if (ownsTest()) {
        testPending = false
        updateButtons()
      }
    }
  }

  const save = async (): Promise<void> => {
    if (
      !connected ||
      testPending ||
      savePending ||
      !tested?.models.length ||
      !modelReadyForSave() ||
      !ui.models.value
    )
      return
    const token = lifecycle
    const inputRevision = revision
    const modelId = ui.models.value
    let request: ReturnType<typeof input>
    let defaultSettings: ModelSettings | undefined
    try {
      request = input()
      defaultSettings = ui.thinking || ui.contextWindow ? readModelSettings() : undefined
      if (accountName && editingId && !accountName.value.trim())
        throw new Error(t('settings.account.nameRequired'))
    } catch (error) {
      setError(error)
      return
    }
    savePending = true
    ui.error.textContent = ''
    ui.state.textContent = t('settings.step.saving')
    updateButtons()
    try {
      const oauthId = oauth.operation()
      const oauthResult = oauthId
        ? await options.client.config.oauth({
            action: 'commit',
            operationId: oauthId,
            model: modelId,
            ...(defaultSettings === undefined ? {} : { defaultSettings }),
          })
        : undefined
      if (oauthId && !oauthResult?.snapshot) throw new Error(t('settings.oauth.saveIncomplete'))
      const saved =
        oauthResult?.snapshot ??
        (await options.client.config.save({
          ...request,
          ...(accountName && editingId ? { label: accountName.value.trim() } : {}),
          model: modelId,
          ...(defaultSettings === undefined ? {} : { defaultSettings }),
          ...(configuration ? { expectedRevision: configuration.revision } : {}),
        }))
      if (!current(token, inputRevision)) {
        // The write still succeeded after the dialog was closed or edited. Let the app refresh its
        // session/model projection, while keeping the stale response away from this controller's UI.
        try {
          await options.onSaved(saved)
        } catch (error) {
          try {
            options.onError(error)
          } catch {
            // Error reporting is best effort after the dialog has gone stale.
          }
        }
        return
      }
      oauth.clear()
      configuration = saved
      tested = undefined
      ui.state.textContent =
        saved.effect === 'restart-required'
          ? t('settings.saved.restartRequired')
          : t('settings.saved.newSessionsOnly')
      try {
        await options.onSaved(saved)
      } catch (error) {
        setError(error)
        return
      }
      if (current(token)) {
        // 保存成功后只收起账户弹窗、留在设置里并刷新列表（该账户保持选中）。
        closeAccountDialog()
        renderAccounts()
      }
    } catch (error) {
      if (current(token, inputRevision)) setError(error)
    } finally {
      // The field is cleared after every save attempt, including a conflict or transport failure.
      ui.apiKey.value = ''
      savePending = false
      if (current(token)) updateButtons()
    }
  }

  const editAccount = (id?: string): void => {
    if (savePending || testPending) return
    modelDrafts.clear()
    editingId = id ?? `acct-${crypto.randomUUID()}`
    suggestedAccountLabel = undefined
    removingId = undefined
    if (accountName) accountName.value = selectedAccount()?.label ?? ''
    renderProviders()
    resetTest()
    renderAccounts()
    ui.state.textContent = id ? t('settings.account.editingHint') : t('settings.account.addingHint')
    if (accountDialogTitle)
      accountDialogTitle.textContent = id
        ? t('settings.account.detailsTitle')
        : t('settings.account.addTitle')
    if (accountDialogContext)
      accountDialogContext.textContent = id
        ? t('settings.account.editContext')
        : t('settings.account.addContext')
    openAccountDialog()
  }

  /** 打开账户弹窗；showModal 不可用时退回 open 属性（与设置弹窗同一套兜底）。 */
  const openAccountDialog = (): void => {
    if (!accountDialog) return
    try {
      accountDialog.showModal()
    } catch {
      accountDialog.setAttribute('open', '')
    }
    accountName?.focus()
  }

  const closeAccountDialog = (): void => {
    providerPicker.close()
    if (oauth.operation() || (testPending && isOAuth())) {
      oauth.clear()
      testPending = false
      resetTest()
      updateButtons()
    }
    if (!accountDialog?.open) return
    try {
      accountDialog.close()
    } catch {
      accountDialog.removeAttribute('open')
    }
  }
  const accountAction = async (row: ConfigAccount, action: ConfigAccountInput['action']): Promise<void> => {
    if (!connected || savePending || testPending || !configuration) return
    if (action === 'remove' && removingId !== row.accountId) {
      removingId = row.accountId
      renderAccounts()
      return
    }
    const token = lifecycle
    savePending = true
    ui.apiKey.value = ''
    updateButtons()
    try {
      const saved = await options.client.config.account({
        accountId: row.accountId,
        action,
        expectedRevision: configuration.revision,
      })
      await options.onSaved(saved)
      if (!current(token)) return
      configuration = saved
      removingId = undefined
      if (!selectedAccount()) editingId = saved.defaultAccountId ?? saved.accounts?.[0]?.accountId
      if (!editingId) editingId = `acct-${crypto.randomUUID()}`
      if (accountName) accountName.value = selectedAccount()?.label ?? ''
      renderProviders()
      resetTest()
      renderAccounts()
      ui.state.textContent =
        saved.effect === 'restart-required'
          ? t('settings.saved.restartNeeded')
          : t('settings.saved.newSessions')
    } catch (error) {
      if (current(token)) setError(error)
    } finally {
      savePending = false
      if (current(token)) updateButtons()
    }
  }
  const renderAccounts = (): void => {
    const currentAccountList = accountList()
    if (renderedAccountList && renderedAccountList !== currentAccountList) {
      unmountRegion(renderedAccountList)
      renderedAccountList = undefined
    }
    if (!currentAccountList) return
    renderedAccountList = currentAccountList
    renderRegion(
      currentAccountList,
      createElement(SettingsAccounts, {
        accounts: configuration?.accounts ?? [],
        defaultAccountId: configuration?.defaultAccountId,
        disabled: !connected || loadPhase === 'loading' || testPending || savePending,
        editingId,
        removingId,
        t,
        onEdit: editAccount,
        onAction: (row, action) => void accountAction(row, action),
        onCancelRemove: () => {
          removingId = undefined
          renderAccounts()
        },
      }),
    )
  }
  optionalElement('account-dialog-close', 'button')?.addEventListener('click', () => {
    closeAccountDialog()
    renderAccounts()
  })
  accountDialog?.addEventListener('click', (event) => {
    if (event.target === accountDialog) {
      closeAccountDialog()
      renderAccounts()
    }
  })
  accountDialog?.addEventListener('cancel', () => {
    oauth.clear()
    testPending = false
    resetTest()
    updateButtons()
  })
  ui.provider.addEventListener('change', () => {
    oauth.clear()
    const selected = providers.find((provider) => provider.id === providerId())
    if (accountName && suggestedAccountLabel && accountName.value === suggestedAccountLabel) {
      accountName.value = selected?.label ?? ''
      suggestedAccountLabel = accountName.value
    }
    ui.baseUrl.value = selected?.baseUrl ?? ''
    ui.apiKey.value = ''
    const methods = selected?.authMethods ?? [selected?.authType ?? 'api-key']
    setSettingsSelectOptions(
      ui.authMethod,
      methods.map((method) =>
        option(method === 'oauth' ? t('settings.provider.subscriptionLogin') : 'API Key', method),
      ),
    )
    ui.authMethod.value = ui.provider.value.endsWith(':oauth') ? 'oauth' : (methods[0] ?? 'api-key')
    ui.authMethodField.hidden = methods.length < 2
    renderKeyHint()
    resetTest()
    updateButtons()
  })
  ui.authMethod.addEventListener('change', () => {
    oauth.clear()
    const selected = providers.find((provider) => provider.id === providerId())
    if (selected) ui.provider.value = providerValue(selected, ui.authMethod.value)
    if (selected && isOAuth()) ui.baseUrl.value = selected.baseUrl
    ui.apiKey.value = ''
    renderKeyHint()
    resetTest()
    updateButtons()
  })
  ui.baseUrl.addEventListener('input', () => resetTest())
  ui.apiKey.addEventListener('input', () => resetTest())
  for (const control of [ui.thinking, ui.contextWindow])
    control?.addEventListener('change', () => {
      try {
        modelDrafts.set(ui.models.value, readModelSettings())
        ui.error.textContent = ''
      } catch (error) {
        setError(error)
      }
    })
  ui.models.addEventListener('change', () => {
    renderModelSettings()
    if (isOAuth() && !oauth.operation() && tested) tested = { ...tested, verified: false }
    updateButtons()
  })
  ui.test.addEventListener('click', () => void test())
  ui.form.addEventListener('submit', (event) => {
    event.preventDefault()
    void save()
  })
  ui.close.addEventListener('click', () => close())
  ui.dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    close()
  })
  // 点遮罩关闭。落在 dialog 自身（而非其内容）的点击即遮罩点击；
  // 面板里嵌的 iframe 事件不会冒泡到这里，所以不会误关。
  ui.dialog.addEventListener('click', (event) => {
    // `EventTarget` may come from the embedded browser realm in tests, so do not rely on a
    // cross-realm `instanceof Element` check for this delegated, replaceable-pane control.
    const target = event.target as { closest?: (selector: string) => Element | null } | null
    if (target?.closest?.('#config-add-account')) {
      editAccount()
      return
    }
    if (event.target === ui.dialog) close()
  })
  ui.retry?.addEventListener('click', () => {
    if (!ui.dialog.open || opening || !connected) return
    const token = ++lifecycle
    const pending = load(token).finally(() => {
      if (opening === pending) opening = undefined
    })
    opening = pending
  })
  updateButtons()

  const open = (): Promise<void> => {
    if (opening) return opening
    if (!ui.dialog.open) {
      const active = document.activeElement
      focusReturn = focusable(active) ? active : null
    }
    const token = ++lifecycle
    tested = undefined
    renderModels()
    show()
    setLoadPhase('loading')
    const work = connected
      ? load(token)
      : Promise.resolve().then(() => {
          if (current(token)) {
            setError(new Error(t('settings.state.offline')))
            setLoadPhase('error')
          }
        })
    const pending = work.finally(() => {
      if (opening === pending) opening = undefined
    })
    opening = pending
    return pending
  }

  const setConnected = (value: boolean): void => {
    if (connected === value) {
      updateButtons()
      return
    }
    connected = value
    if (!value) {
      oauth.clear()
      testPending = false
    }
    lifecycle += 1
    resetTest(false)
    if (!connected) {
      // Allow a reconnect to start a fresh load even if the old network request never settles.
      opening = undefined
      ui.apiKey.value = ''
      ui.state.textContent = t('settings.state.disconnected')
      setLoadPhase('error')
    }
    renderKeyHint()
    updateButtons()
    if (connected && ui.dialog.open && !opening) void open()
  }

  return { open, close, refreshLocale: renderAccounts, setConnected }
}
