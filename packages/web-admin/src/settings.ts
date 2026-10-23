import type {
  ConfigAccount,
  ConfigAccountInput,
  ConfigModel,
  ConfigProvider,
  ConfigSnapshot,
  ConfigTestResult,
  ModelSettings,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { tr } from '@agnes/web-foundation/locale-bridge'
import {
  renderRegion,
  SettingsAccounts,
  setDisclosureOpen,
  setSettingsSelectOptions,
  unmountRegion,
} from '@agnes/web-ui'
import { createElement } from 'react'
import { oauthControls } from './oauth-controls.js'
import { createAccountPickers } from './provider-picker.js'
import { catalogueErrorText, compatibleModelsPanel } from './settings/account-compatible.js'
import { accountForm, endpointHost, fieldError } from './settings/account-form.js'
import { accountNetworkFields } from './settings/account-network.js'
import { bindAccountPage, linkedAccountRestorer, showAccountDiscard } from './settings/account-page.js'
import {
  accountWelcome,
  COMPATIBLE_PROVIDER,
  defaultAccountLabel,
  providerTiles,
  type RelayPreset,
  settledTest,
} from './settings/account-tiles.js'
import {
  configurationReason,
  errorText,
  focusable,
  option,
  optionalElement,
  readElements,
  renderAccountKeyHint,
  setDialogOpen,
  showSettingsDialog,
} from './settings/dialog.js'
import { reportAccountSaved } from './settings/feedback.js'
import { modelSlotsPanel } from './settings/model-slots.js'
import { sideModelsPanel } from './settings/side-models.js'

export type SettingsControllerOptions = {
  client: Client
  onSaved(snapshot: ConfigSnapshot): Promise<void>
  onError(error: unknown): void
  /** The dialog has just opened; its host owns the URL. */
  onOpen?(): void
  /** The dialog was open and has just closed, by any route. */
  onClose?(): void
}

export type SettingsController = {
  openAccount(route?: string): Promise<void>
  open(): Promise<void>
  close(): void
  isOpen(): boolean
  refreshLocale(): void
  attachInline(host: HTMLElement): () => void
  submitInline(): Promise<boolean>
  setConnected(connected: boolean): void
}

type AsyncPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

/**
 * Owns only the configuration dialog. The app supplies the SDK client and decides what a saved
 * snapshot means for the current session; this controller never creates a second client or reads
 * provider credentials from another store.
 */
export function createSettingsController(options: SettingsControllerOptions): SettingsController {
  const ui = readElements()
  const form = accountForm(ui)
  const networkFields = accountNetworkFields(
    optionalElement('config-account-network', 'div') ?? null,
    tr,
    () => {
      revision += 1
      updateButtons()
    },
  )
  const providerPicker = createAccountPickers(ui)
  let connected = true
  let configuration: ConfigSnapshot | undefined
  // The model pane is independently reconcilable. Resolve its list/button at the point of use;
  // keeping either reference here would make a reopened settings dialog target a detached pane.
  const accountList = () => optionalElement('config-accounts', 'div')
  let renderedAccountList: HTMLElement | undefined
  // The account dialog itself belongs to the stable settings shell, so an in-flight edit survives
  // a model-pane replacement.
  const accountDialog = optionalElement('account-dialog', 'dialog')
  const accountDialogTitle = optionalElement('config-detail-title', 'h3')
  const accountDialogContext = optionalElement('config-account-context', 'p')
  const accountName = optionalElement('config-account-name', 'input')
  const accountBody = accountDialog?.querySelector<HTMLElement>('.account-dialog-body')
  const accounts = () => configuration?.accounts
  // Leaving the page by Back or the browser drops the draft, as closing the dialog did.
  const accountRestore = linkedAccountRestorer(
    ui.dialog,
    () => open(),
    accounts,
    (id) => editAccount(id),
  )
  const accountPage = bindAccountPage(
    ui.dialog,
    accountBody,
    accountDialog,
    () => discardAccount(),
    accountRestore,
  )
  const advanced = optionalElement('config-account-advanced', 'div')
  let inlineHost: HTMLElement | undefined
  let accountStep: 'provider' | 'connection' = 'connection'
  const autoTest = settledTest(() => {
    if (connected && !testPending && !savePending && (ui.dialog.open || inlineHost?.isConnected))
      void test(true)
  })
  let pasted = false
  let draftBaseline = ''
  let accountFocusReturn: HTMLElement | null = null
  const draftSignature = () =>
    JSON.stringify([
      ui.provider.value,
      ui.authMethod.value,
      accountName?.value,
      ui.baseUrl.value,
      ui.apiKey.value,
      ui.models.value,
      ui.thinking?.value,
      ui.contextWindow?.value,
      isCompatible() ? compatible.models().map((model) => model.id) : [],
    ])
  let editingId: string | undefined
  let removingId: string | undefined
  const selectedAccount = (): ConfigAccount | undefined =>
    configuration?.accounts?.find((row) => row.accountId === editingId)
  const defaultLabel = (base: string): string =>
    defaultAccountLabel(base, configuration?.accounts?.map((row) => row.label) ?? [])
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
  const isCompatible = () => providerId() === COMPATIBLE_PROVIDER
  // An OpenAI-compatible account declares its models: listed ones picked, others typed by hand.
  const compatible = compatibleModelsPanel(
    optionalElement('config-compatible-models', 'div'),
    () => {
      tested = compatible.tested()
      renderModels()
    },
    () => void test(),
  )
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
    return (
      ui.models.value !== account.model ||
      (!!name && name !== account.label) ||
      networkFields.changed(account)
    )
  }

  const oauth = oauthControls(ui.oauthMount, options.client.config, {
    input: () => {
      const provider = providers.find((row) => row.id === providerId())
      if (!configuration || !editingId || !accountName || !provider)
        throw new Error(tr('settings.account.notLoaded'))
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
      if (value) form.clearErrors()
      updateButtons()
    },
    ready: (models) => {
      tested = models.length ? { models, verified: true } : undefined
      say(
        models.length
          ? tr('settings.oauth.authorizedVerify')
          : testPending
            ? tr('settings.oauth.awaitingAuth')
            : tr('settings.oauth.cancelled'),
        models.length ? 'ok' : testPending ? 'progress' : '',
      )
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
    token === lifecycle &&
    (ui.dialog.open || !!inlineHost?.isConnected) &&
    (inputRevision === undefined || inputRevision === revision)

  /** The one status line under the key: what is happening, toned so success and waiting read apart. */
  const say = (text: string, tone: '' | 'progress' | 'ok' | 'warn' = ''): void => {
    ui.state.textContent = text
    ui.state.dataset.tone = tone
  }
  const setError = (error: unknown, notify = true): void => {
    const secret = ui.apiKey.value
    const translated = configurationReason(error, tr)
    const message = translated ?? errorText(error, secret, tr)
    // A field's own error is told under it; the connection's result above stays as it was.
    if (!form.error(error, message)) return
    say('')
    // A test nobody asked for by hand reports on its own line only.
    if (!notify) return
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
    if (phase === 'loading') say(tr('settings.state.reading'))
    if (phase === 'error') say(tr('settings.state.readFailed'))
    updateButtons()
  }

  const updateButtons = (): void => {
    const busy = loadPhase === 'loading' || testPending || savePending
    const oauthSelected = isOAuth()
    oauth.visible(oauthSelected)
    oauth.disabled(!connected || busy)
    networkFields.disabled(!connected || busy)
    compatible.show(isCompatible() && !oauthSelected && accountStep === 'connection', !connected || busy)
    ui.apiKey.closest<HTMLElement>('.account-key-field')?.toggleAttribute('hidden', oauthSelected)
    ui.provider.disabled =
      !connected || busy || oauth.operation() !== undefined || selectedAccount() !== undefined
    ui.authMethod.disabled = !connected || busy || oauth.operation() !== undefined
    if (accountName) accountName.disabled = !connected || busy || oauth.operation() !== undefined
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
      !connected ||
      busy ||
      !providerId() ||
      loadPhase === 'error' ||
      (accountStep === 'connection' && oauthSelected && (!modelReadyForSave() || !ui.models.value))
    ui.save.textContent = tr(accountStep === 'provider' ? 'accounts.continue' : 'accounts.save')
    form.sync({
      step: accountStep,
      editing: !!selectedAccount(),
      inline: !!inlineHost,
      provider: providers.find((row) => row.id === providerId()),
      oauth: oauthSelected,
      tested,
      timeouts: networkFields.values(),
    })
    ui.save.setAttribute('aria-busy', String(busy))
    if (accountBody) accountBody.dataset.accountStep = accountStep
    const back = optionalElement('config-account-back', 'button')
    if (back) {
      back.hidden = accountStep !== 'connection' || !!selectedAccount()
      back.disabled = busy
    }

    providerPicker.sync()
  }

  const renderModels = (models: readonly ConfigModel[] = tested?.models ?? []): void => {
    const previousModel = ui.models.value
    setSettingsSelectOptions(ui.models, [
      option(models.length ? tr('settings.model.chooseSaved') : tr('settings.model.testFirst'), ''),
      ...models.map((model) => option(`${model.name} · ${model.id}`, model.id)),
    ])
    const savedModel = models.some((model) => model.id === previousModel)
      ? previousModel
      : (savedProvider()?.model ?? models[0]?.id)
    ui.models.value = savedModel && models.some((model) => model.id === savedModel) ? savedModel : ''
    renderModelSettings()
    updateButtons()
  }

  const chosenModel = () => tested?.models.find((entry) => entry.id === ui.models.value)
  const readModelSettings = (): ModelSettings => form.readModelSettings(chosenModel())
  const renderModelSettings = (): void =>
    form.renderModelSettings(
      chosenModel(),
      modelDrafts.get(ui.models.value) ??
        selectedAccount()?.models.find((entry) => entry.id === ui.models.value)?.defaultSettings ??
        chosenModel()?.defaultSettings ??
        {},
    )

  const renderKeyHint = (): void =>
    renderAccountKeyHint(ui, savedProvider(), providerId(), connected, isOAuth())

  const renderProviders = (): void => {
    const savedProviderId = savedProvider()?.id
    const groups = (['api-key', 'oauth'] as const).map((method) => ({
      label: method === 'oauth' ? tr('settings.provider.subscriptionLogin') : 'API Key',
      options: providers
        .filter((provider) => authMethods(provider).includes(method))
        .map((provider) =>
          option(
            method === 'oauth'
              ? `${provider.label.replace(/\s*subscription$/i, '')}${tr('settings.provider.subscriptionLoginSuffix')}`
              : provider.label,
            providerValue(provider, method),
          ),
        ),
    }))
    setSettingsSelectOptions(
      ui.provider,
      [option(providers.length ? tr('settings.provider.choose') : tr('settings.provider.none'), '')],
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
        option(method === 'oauth' ? tr('settings.provider.subscriptionLogin') : 'API Key', method),
      ),
    )
    const saved = savedProvider()
    const savedAuth = saved && 'authType' in saved ? saved.authType : undefined
    ui.authMethod.value = savedAuth && methods.includes(savedAuth) ? savedAuth : (methods[0] ?? 'api-key')
    if (selected) ui.provider.value = providerValue(selected, ui.authMethod.value)
    ui.authMethodField.hidden = methods.length < 2
    networkFields.load(selectedAccount())
    ui.baseUrl.value = savedProvider()?.baseUrl ?? selected?.baseUrl ?? ''
    // A saved credential is represented only by credentialConfigured. It is never read back here.
    ui.apiKey.value = ''
    renderKeyHint()
  }

  const resetTest = (clearError = true): void => {
    revision += 1
    testGeneration += 1
    testPending = false
    autoTest.cancel()
    const retest = !!tested?.verified
    const saved = selectedAccount()
    tested = isCompatible()
      ? compatible.tested()
      : saved?.models.length
        ? { models: saved.models, verified: false }
        : undefined
    ui.models.value = ''
    renderModels()
    if (clearError) form.clearErrors()
    // Only a connection that had passed needs telling that its result no longer holds.
    say(
      retest
        ? tr('settings.state.connectionChanged')
        : !saved && !ui.apiKey.value.trim() && !isOAuth()
          ? tr('settings.state.notConfigured')
          : '',
      retest ? 'warn' : '',
    )
  }
  /** A changed key is tested once typing settles, at once after a paste; an emptied field tests nothing. */
  const connectionChanged = (delay: number): void => {
    resetTest()
    renderKeyHint()
    // A compatible endpoint may need no key: its address alone is worth listing.
    const ready = ui.apiKey.value.trim() || (isCompatible() && ui.baseUrl.value.trim())
    if (!isOAuth() && ready && accountStep === 'connection') autoTest.schedule(delay)
  }

  const input = (): { providerId: string; accountId?: string; baseUrl?: string; apiKey?: string } => {
    const selectedId = providerId()
    const selected = providers.find((provider) => provider.id === selectedId)
    if (!selectedId || !selected) throw new Error(tr('settings.provider.required'))
    const baseUrl = ui.baseUrl.value.trim()
    const apiKey = ui.apiKey.value
    const row = selectedAccount()
    // A compatible account may have no key to re-enter: the backend refuses to move a stored one.
    const moved = row && baseUrl && row.baseUrl.replace(/\/$/, '') !== baseUrl.replace(/\/$/, '')
    if (moved && !apiKey && !isCompatible())
      throw Object.assign(new Error(tr('settings.key.endpointChanged')), { field: 'apiKey' })
    if (!isOAuth() && selectedAccount()?.authType === 'oauth' && !apiKey)
      throw new Error(tr('settings.provider.switchKeyRequired'))
    return {
      providerId: selectedId,
      ...(editingId ? { accountId: editingId } : {}),
      // An explicit provider default must survive the client boundary so Host can reset a saved
      // custom endpoint. An empty field remains an omitted override per Config*Input semantics.
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    }
  }

  const closeDialog = (): void => setDialogOpen(ui.dialog, false)

  const close = (): void => {
    const wasOpen = ui.dialog.open
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
    if (wasOpen) options.onClose?.()
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
      providers = [...result.providers]
        .sort((a, b) => +(b.id === 'agnes-ai') - +(a.id === 'agnes-ai'))
        .map((row) =>
          row.id === COMPATIBLE_PROVIDER ? { ...row, label: tr('accounts.compatibleName') } : row,
        )
      tested = undefined
      form.clearErrors()
      say('')
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

  const test = async (automatic = false): Promise<void> => {
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
      form.clearErrors()
      say(tr('settings.step.testingModel'), 'progress')
      updateButtons()
      try {
        await options.client.config.oauth({ action: 'test', operationId: oauthId, model })
        if (ownsTest()) {
          if (tested) tested = { ...tested, verified: true }
          say(tr('settings.step.modelVerified'), 'ok')
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
    form.clearErrors()
    say(tr('settings.step.second', { host: endpointHost(ui.baseUrl.value) }), 'progress')
    updateButtons()
    try {
      const result = await options.client.config.test({
        ...request,
        ...(isOAuth() && ui.models.value ? { model: ui.models.value } : {}),
      })
      if (!ownsTest()) return
      if (isOAuth()) tested = result
      if (isCompatible()) {
        compatible.listed(result)
        tested = compatible.tested()
        if (result.verified) say(tr('settings.step.third', { count: result.models.length }), 'ok')
        else say('')
        renderModels()
        return
      }
      if (result.catalogueError) throw new Error(catalogueErrorText(result.catalogueError))
      if (!result.verified) {
        if (!request.apiKey && !savedProvider()?.credentialConfigured) {
          say(tr('settings.state.notConfigured'))
          return
        }
        throw new Error(tr('settings.config.verificationUnknown'))
      }
      if (result.models.length === 0) throw new Error(tr('settings.provider.noCatalog'))
      tested = result
      say(tr('settings.step.third', { count: result.models.length }), 'ok')
      form.clearErrors()
      renderModels(result.models)
    } catch (error) {
      if (!ownsTest()) return
      tested = isCompatible()
        ? compatible.tested()
        : isOAuth() && tested
          ? { ...tested, verified: false }
          : undefined
      renderModels()
      setError(error, !automatic)
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
    let networkTimeouts: NonNullable<ReturnType<typeof networkFields.read>>
    try {
      request = input()
      networkTimeouts = networkFields.read()
      defaultSettings = ui.thinking || ui.contextWindow ? readModelSettings() : undefined
      if (accountName && editingId && !accountName.value.trim())
        throw fieldError('name', tr('settings.account.nameRequired'))
    } catch (error) {
      setError(error)
      return
    }
    savePending = true
    form.clearErrors()
    say(tr('settings.step.saving'))
    updateButtons()
    try {
      const oauthId = oauth.operation()
      const oauthResult = oauthId
        ? await options.client.config.oauth({
            action: 'commit',
            operationId: oauthId,
            model: modelId,
            networkTimeouts,
            ...(defaultSettings === undefined ? {} : { defaultSettings }),
          })
        : undefined
      if (oauthId && !oauthResult?.snapshot) throw new Error(tr('settings.oauth.saveIncomplete'))
      const saved =
        oauthResult?.snapshot ??
        (await options.client.config.save({
          ...request,
          ...(accountName && editingId ? { label: accountName.value.trim() } : {}),
          model: modelId,
          networkTimeouts,
          ...(isCompatible() ? { models: compatible.models() } : {}),
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
      ui.state.textContent = ''
      reportAccountSaved(saved.effect)
      try {
        await options.onSaved(saved)
      } catch {
        ui.error.textContent = tr('settings.saved.refreshFailed')
        return
      }
      if (current(token)) {
        // After saving, close only the account dialog, stay in settings and refresh the list with that account still selected.
        closeAccountDialog()
        renderAccounts()
      }
    } catch (error) {
      if (current(token, inputRevision)) setError(error)
    } finally {
      // Keep the private draft on failure so users can retry; clear after success or a stale result.
      if (!current(token, inputRevision) || !form.hasError()) ui.apiKey.value = ''
      savePending = false
      if (current(token)) updateButtons()
    }
  }

  const verifyAndSave = async (): Promise<boolean> => {
    if (!connected || testPending || savePending || loadPhase === 'loading' || loadPhase === 'error')
      return false
    const token = lifecycle
    const inputRevision = revision
    if (!modelReadyForSave() || !tested?.models.length || !ui.models.value) await test()
    if (!current(token, inputRevision) || !modelReadyForSave() || !ui.models.value) return false
    const previous = configuration?.revision
    await save()
    return configuration?.revision !== previous && !form.hasError()
  }
  const selectProvider = (id: string, preset?: RelayPreset) => {
    ui.provider.value = id
    ui.provider.dispatchEvent(new Event('change', { bubbles: true }))
    accountStep = 'connection'
    updateButtons()
    if (preset) {
      ui.baseUrl.value = preset.baseUrl
      ui.baseUrl.dispatchEvent(new Event('input', { bubbles: true }))
      suggestLabel(preset.label)
    }
    if (isCompatible() && !preset) ui.baseUrl.focus()
    else if (!isOAuth()) ui.apiKey.focus()
  }
  /** A name the person has not typed follows the choice: the preset, else the endpoint's host. */
  const suggestLabel = (base: string) => {
    if (!accountName || !suggestedAccountLabel || accountName.value !== suggestedAccountLabel) return
    accountName.value = defaultLabel(base)
    suggestedAccountLabel = accountName.value
  }
  const renderProviderChoices = () => {
    const host = optionalElement('config-provider-choices', 'div')
    if (host) renderRegion(host, providerTiles(providers, tr, selectProvider))
  }

  const editAccount = (id?: string): void => {
    if (savePending || testPending) return
    modelDrafts.clear()
    editingId = id ?? `acct-${crypto.randomUUID()}`
    suggestedAccountLabel = undefined
    removingId = undefined
    if (accountName) accountName.value = selectedAccount()?.label ?? ''
    renderProviders()
    compatible.reset(selectedAccount()?.models ?? [])
    if (accountName && !id) {
      accountName.value = defaultLabel(providers.find((p) => p.id === providerId())?.label ?? '')
      suggestedAccountLabel = accountName.value
    }
    accountStep = id || inlineHost ? 'connection' : 'provider'
    if (advanced) setDisclosureOpen(advanced, false)
    renderProviderChoices()
    resetTest()
    renderAccounts()
    say('')
    if (accountDialogTitle)
      accountDialogTitle.textContent = id
        ? tr('settings.account.detailsTitle')
        : tr('settings.account.addTitle')
    if (accountDialogContext) accountDialogContext.textContent = id ? tr('settings.account.editContext') : ''
    showAccountDiscard(false)
    draftBaseline = draftSignature()
    if (!inlineHost) openAccountDialog()
  }

  /** Open an account page when settings provides one; otherwise use its dialog, falling back to open when showModal is unavailable. */
  const openAccountDialog = (): void => {
    if (
      !accountDialog ||
      accountPage.open(!configuration?.accounts?.some((a) => a.accountId === editingId), editingId)
    )
      return
    setDialogOpen(accountDialog, true)
    accountFocusReturn = focusable(document.activeElement) ? document.activeElement : null
    ui.provider.focus()
  }

  const closeAccountDialog = (): void => {
    autoTest.cancel()
    providerPicker.close()
    if (oauth.operation() || (testPending && isOAuth())) oauth.clear()
    // Closing this draft invalidates API-key tests as well as OAuth. The settings shell can
    // remain open, so its lifecycle alone cannot reject a late response (which may echo a key).
    revision += 1
    testGeneration += 1
    testPending = false
    updateButtons()
    if (!accountPage.leave() && accountDialog) setDialogOpen(accountDialog, false)
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
      reportAccountSaved(saved.effect)
      try {
        await options.onSaved(saved)
      } catch {
        if (current(token)) ui.error.textContent = tr('settings.saved.refreshFailed')
      }
      if (!current(token)) return
      configuration = saved
      removingId = undefined
      if (!selectedAccount()) editingId = saved.defaultAccountId ?? saved.accounts?.[0]?.accountId
      if (!editingId) editingId = `acct-${crypto.randomUUID()}`
      if (accountName) accountName.value = selectedAccount()?.label ?? ''
      renderProviders()
      resetTest()
      renderAccounts()
      ui.state.textContent = ''
    } catch (error) {
      if (current(token)) setError(error)
    } finally {
      savePending = false
      if (current(token)) updateButtons()
    }
  }
  let renderedSlots: HTMLElement | undefined
  let renderedSideModels: HTMLElement | undefined
  const renderAccounts = (): void => {
    const slotsHost = optionalElement('config-auxiliary-models', 'div')
    if (renderedSlots && renderedSlots !== slotsHost) unmountRegion(renderedSlots)
    renderedSlots = slotsHost
    if (slotsHost) renderRegion(slotsHost, modelSlotsPanel(configuration, tr))
    const sideHost = optionalElement('config-side-models', 'div')
    if (renderedSideModels && renderedSideModels !== sideHost) unmountRegion(renderedSideModels)
    renderedSideModels = sideHost
    if (sideHost)
      renderRegion(
        sideHost,
        sideModelsPanel({
          client: options.client.config,
          configuration,
          canSave: connected && !savePending && !testPending,
          onSaved: async (saved) => {
            await options.onSaved(saved)
            configuration = saved
            renderAccounts()
          },
        }),
      )
    const guard = optionalElement('config-account-guard', 'p')
    if (guard) guard.hidden = !editingId || editingId !== configuration?.defaultAccountId
    const currentAccountList = accountList()
    if (renderedAccountList && renderedAccountList !== currentAccountList) {
      unmountRegion(renderedAccountList)
      renderedAccountList = undefined
    }
    if (!currentAccountList) return
    renderedAccountList = currentAccountList
    if (loadPhase === 'ready' || loadPhase === 'empty')
      loadPhase = configuration?.accounts?.length ? 'ready' : 'empty'
    currentAccountList.dataset.state = loadPhase
    renderRegion(
      currentAccountList,
      createElement(SettingsAccounts, {
        accounts: configuration?.accounts ?? [],
        phase: loadPhase,
        ...accountWelcome(providers, tr, () => editAccount(), selectProvider, close),
        onRetry: () => ui.retry?.click(),
        defaultAccountId: configuration?.defaultAccountId,
        disabled: !connected || loadPhase === 'loading' || testPending || savePending,
        editingId,
        removingId,
        t: tr,
        onEdit: editAccount,
        onAction: (row, action) => void accountAction(row, action),
        onCancelRemove: () => {
          removingId = undefined
          renderAccounts()
        },
      }),
    )
  }
  const discardAccount = () => {
    showAccountDiscard(false)
    closeAccountDialog()
    ui.apiKey.value = ''
    renderAccounts()
    if (accountFocusReturn?.isConnected) accountFocusReturn.focus()
  }
  const requestCloseAccount = () => {
    if (draftSignature() !== draftBaseline) {
      showAccountDiscard(true)
      return
    }
    discardAccount()
  }
  optionalElement('config-account-keep', 'button')?.addEventListener('click', () => {
    showAccountDiscard(false)
    ui.apiKey.focus()
  })
  optionalElement('config-account-discard-confirm', 'button')?.addEventListener('click', discardAccount)
  optionalElement('config-account-cancel', 'button')?.addEventListener('click', requestCloseAccount)
  optionalElement('config-account-back', 'button')?.addEventListener('click', () => {
    if (testPending || savePending) return
    accountStep = 'provider'
    updateButtons()
  })
  optionalElement('account-dialog-close', 'button')?.addEventListener('click', requestCloseAccount)
  accountDialog?.addEventListener('click', (event) => {
    if (event.target === accountDialog) requestCloseAccount()
  })
  accountDialog?.addEventListener('cancel', (event) => {
    event.preventDefault()
    requestCloseAccount()
  })
  ui.provider.addEventListener('change', () => {
    oauth.clear()
    const selected = providers.find((provider) => provider.id === providerId())
    suggestLabel(selected?.label ?? '')
    // A compatible endpoint's registry address is a stand-in; the person gives the real one.
    ui.baseUrl.value = isCompatible() ? '' : (selected?.baseUrl ?? '')
    // Its address is the first thing it needs, so the section holding it opens.
    if (isCompatible() && advanced) setDisclosureOpen(advanced, true)
    ui.apiKey.value = ''
    compatible.reset([])
    const methods = selected?.authMethods ?? [selected?.authType ?? 'api-key']
    setSettingsSelectOptions(
      ui.authMethod,
      methods.map((method) =>
        option(method === 'oauth' ? tr('settings.provider.subscriptionLogin') : 'API Key', method),
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
  accountName?.addEventListener('input', updateButtons)
  ui.baseUrl.addEventListener('input', () => {
    if (isCompatible()) suggestLabel(endpointHost(ui.baseUrl.value) || tr('accounts.compatibleName'))
    connectionChanged(1000)
  })
  ui.apiKey.addEventListener('paste', () => {
    pasted = true
  })
  ui.apiKey.addEventListener('input', () => {
    connectionChanged(pasted ? 0 : 1000)
    pasted = false
  })
  for (const control of [ui.thinking, ui.contextWindow])
    control?.addEventListener('change', () => {
      try {
        modelDrafts.set(ui.models.value, readModelSettings())
        form.clearErrors()
      } catch (error) {
        setError(error)
      }
    })
  ui.models.addEventListener('change', () => {
    renderModelSettings()
    if (isOAuth() && !oauth.operation() && tested) tested = { ...tested, verified: false }
    updateButtons()
  })
  ui.apiKey.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (inlineHost) document.querySelector<HTMLButtonElement>('[data-testid="first-run-next"]')?.click()
      else void verifyAndSave()
    }
  })
  ui.test.addEventListener('click', () => void test())
  ui.form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (accountStep === 'provider') {
      accountStep = 'connection'
      updateButtons()
      ui.apiKey.focus()
    } else void verifyAndSave()
  })
  ui.close.addEventListener('click', () => close())
  ui.dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    close()
  })
  // Close on backdrop clicks: a click on dialog itself, rather than its contents, is a backdrop click;
  // events in embedded iframes do not bubble here, preventing accidental closure.
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
    if ((!ui.dialog.open && !inlineHost) || opening || !connected) return
    const token = ++lifecycle
    const pending = load(token)
      .then(() => {
        if (inlineHost && current(token) && loadPhase !== 'error') editAccount()
      })
      .finally(() => {
        if (opening === pending) opening = undefined
      })
    opening = pending
  })
  updateButtons()

  const open = (): Promise<void> => {
    if (opening || !ui.dialog.isConnected || !ui.models.isConnected) return opening ?? Promise.resolve()
    if (!ui.dialog.open) {
      const active = document.activeElement
      focusReturn = focusable(active) ? active : null
    }
    const token = ++lifecycle
    tested = undefined
    renderModels()
    showSettingsDialog(ui.dialog, options.onOpen)
    setLoadPhase('loading')
    const work = connected
      ? load(token)
      : Promise.resolve().then(() => {
          if (current(token)) {
            setError(new Error(tr('settings.state.offline')))
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
      say(tr('settings.state.disconnected'))
      setLoadPhase('error')
    }
    renderKeyHint()
    updateButtons()
    if (connected && !opening) {
      if (inlineHost) {
        const token = ++lifecycle
        void load(token).then(() => {
          if (current(token) && loadPhase !== 'error') editAccount()
        })
      } else if (ui.dialog.open) void open()
    }
  }

  return {
    attachInline(host) {
      if (!accountBody || !accountDialog) return () => {}
      close()
      inlineHost = host
      host.append(accountBody)
      accountBody.dataset.inline = 'true'
      accountStep = 'connection'
      const token = ++lifecycle
      void load(token).then(() => {
        if (current(token) && loadPhase !== 'error') editAccount()
      })
      return () => {
        if (inlineHost !== host) return
        accountDialog.append(accountBody)
        delete accountBody.dataset.inline
        inlineHost = undefined
        close()
      }
    },
    isOpen: () => ui.dialog.open,
    submitInline: verifyAndSave,
    open,
    openAccount: accountRestore.openRoute,
    close,
    refreshLocale: () => {
      renderAccounts()
      networkFields.render()
    },
    setConnected,
  }
}
