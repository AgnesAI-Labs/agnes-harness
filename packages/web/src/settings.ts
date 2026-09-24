import type {
  ConfigAccount,
  ConfigAccountInput,
  ConfigModel,
  ConfigProvider,
  ConfigSnapshot,
  ConfigTestResult,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { oauthControls } from './oauth-controls.js'
import { createAccountPickers } from './provider-picker.js'

export type SettingsControllerOptions = {
  client: Client
  onSaved(snapshot: ConfigSnapshot): Promise<void>
  onError(error: unknown): void
}

export type SettingsController = {
  open(): Promise<void>
  close(): void
  setConnected(connected: boolean): void
}

type AsyncPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

const CONFIGURATION_REASON_MESSAGES: Readonly<Record<string, string>> = {
  CONFIG_AUTH_FAILED: '登录未完成，请重试或使用设备码登录。',
  CONFIG_AUTH_EXPIRED: '登录操作已过期，请重新登录。',
  CONFIG_AUTH_BUSY: '正在处理登录，请稍后重试。',
  CONFIG_INVALID_INPUT: '配置输入无效，请检查 Provider、Base URL、密钥和模型。',
  CONFIG_UNKNOWN_PROVIDER: '所选 Provider 不可用，请重新选择。',
  CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED: '该 Provider 不支持自定义 Base URL，请恢复默认地址。',
  CONFIG_CREDENTIAL_REQUIRED: '需要 API key，请输入密钥后重试。',
  CONFIG_CREDENTIAL_STORE: '本地凭据存储不可用，请检查本机配置。',
  CONFIG_PROVIDER_UNAVAILABLE: 'Provider 模型目录不可用，请检查网络或 Base URL。',
  CONFIG_TEST_FAILED: 'Provider 连接测试未通过，请检查地址和密钥。',
  CONFIG_SUBSCRIPTION_AUTH: '上游拒绝了订阅授权或访问权限，请重新授权并核对登录账号。',
  CONFIG_SUBSCRIPTION_QUOTA: '上游报告额度或余额不足，请检查订阅用量。',
  CONFIG_SUBSCRIPTION_RATE_LIMIT: '上游请求限流，请稍后重试。',
  CONFIG_SUBSCRIPTION_TIMEOUT: '模型测试超时，请检查网络后重试。',
  CONFIG_SUBSCRIPTION_MODEL: '上游未找到所选模型，请选择其他模型重试。',
  CONFIG_SUBSCRIPTION_FAILED: '授权已完成，但所选模型的推理测试失败；请重试或改选模型。账户尚未保存。',
  CONFIG_MODEL_UNAVAILABLE: '所选模型不可用，请重新测试并选择返回的模型。',
  CONFIG_REVISION_CONFLICT: '配置已被其他客户端修改，请重新打开设置后再试。',
  CONFIG_PERSIST_FAILED: '配置保存失败，请稍后重试。',
  CONFIG_INVALID_STATE: '本地配置状态无效，请检查配置文件。',
  CONFIG_FAILED: '配置请求失败，请稍后重试。',
}

function configurationReason(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const data =
    'data' in error && error.data !== null && typeof error.data === 'object' ? error.data : undefined
  const reason = data && 'reason' in data && typeof data.reason === 'string' ? data.reason : undefined
  return reason === undefined ? undefined : CONFIGURATION_REASON_MESSAGES[reason]
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
    save: element('config-save', 'button'),
    error: element('config-error', 'p'),
    state: element('config-state', 'p'),
    keyHint: optionalElement('config-key-hint', 'p'),
    retry: optionalElement('config-retry', 'button'),
    close: element('config-close', 'button'),
  }
}

function option(label: string, value: string): HTMLOptionElement {
  return Object.assign(document.createElement('option'), { textContent: label, value })
}

function errorText(error: unknown, secret: string): string {
  const message = configurationReason(error) ?? (error instanceof Error ? error.message : '配置请求失败')
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
  const ui = readElements()
  const providerPicker = createAccountPickers(ui)
  let connected = true
  let configuration: ConfigSnapshot | undefined
  // The model pane is independently reconcilable. Resolve its list/button at the point of use;
  // keeping either reference here would make a reopened settings dialog target a detached pane.
  const accountList = () => optionalElement('config-accounts', 'div')
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
  const authMethods = (provider: ConfigProvider) => provider.authMethods ?? [provider.authType ?? 'api-key']
  const providerValue = (provider: ConfigProvider, auth: string) =>
    auth === 'oauth' && authMethods(provider).includes('api-key') ? `${provider.id}:oauth` : provider.id

  const oauth = oauthControls(ui.oauthMount, options.client.config, {
    input: () => {
      const provider = providers.find((row) => row.id === providerId())
      if (!configuration || !editingId || !accountName || !provider) throw new Error('账户信息尚未加载完成')
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
        ? '授权完成；选择模型并保存，保存前会验证所选模型。'
        : testPending
          ? '正在等待订阅授权。'
          : '登录已取消。'
      renderModels()
      if (models.length) ui.models.focus()
    },
    error: (error) => setError(error),
  })
  const isOAuth = () => ui.authMethod.value === 'oauth'

  const current = (token: number, inputRevision?: number): boolean =>
    token === lifecycle && ui.dialog.open && (inputRevision === undefined || inputRevision === revision)

  const setError = (error: unknown): void => {
    const secret = ui.apiKey.value
    const translated = configurationReason(error)
    const message = translated ?? errorText(error, secret)
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
    if (phase === 'loading') ui.state.textContent = '正在读取配置…'
    if (phase === 'error') ui.state.textContent = '配置读取失败，请重试。'
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
    for (const control of accountList()?.querySelectorAll('button') ?? [])
      control.disabled = !connected || busy
    ui.baseUrl.disabled = !connected || busy || oauthSelected
    ui.apiKey.disabled = !connected || busy || oauthSelected
    ui.test.disabled =
      !connected ||
      busy ||
      (oauthSelected && (oauth.operation() ? !tested?.models.length || !ui.models.value : !selectedAccount()))
    ui.models.disabled = !connected || busy || !tested?.models.length || (!oauthSelected && !tested.verified)
    ui.save.disabled =
      !connected || busy || !tested?.verified || tested.models.length === 0 || ui.models.value === ''
    providerPicker.sync()
  }

  const renderModels = (models: readonly ConfigModel[] = tested?.models ?? []): void => {
    const previousModel = ui.models.value
    ui.models.replaceChildren(
      option(models.length ? '选择要保存的默认模型' : '先测试 Provider，再选择默认模型', ''),
    )
    for (const model of models) ui.models.append(option(`${model.name} · ${model.id}`, model.id))
    const savedModel = models.some((model) => model.id === previousModel)
      ? previousModel
      : (savedProvider()?.model ?? (models.length === 1 ? models[0]?.id : undefined))
    if (savedModel && models.some((model) => model.id === savedModel)) ui.models.value = savedModel
    updateButtons()
  }

  const renderKeyHint = (): void => {
    if (!ui.keyHint) return
    const reusesSavedKey =
      connected && savedProvider()?.id === providerId() && savedProvider()?.credentialConfigured
    if (isOAuth()) {
      ui.keyHint.textContent = '使用当前 Provider 的订阅授权，无需 API key。'
      return
    }
    ui.keyHint.textContent = reusesSavedKey
      ? '已保存 API key。留空会继续使用它；输入新值可替换。页面不会显示已保存的密钥。'
      : connected
        ? '请输入 API key 进行测试和保存。关闭设置会清除本次输入。'
        : '后台未连接，页面已清除本次输入。'
  }

  const renderProviders = (): void => {
    const savedProviderId = savedProvider()?.id
    ui.provider.replaceChildren(option(providers.length ? '选择 Provider' : '无可用 Provider', ''))
    for (const method of ['api-key', 'oauth']) {
      const group = document.createElement('optgroup')
      group.label = method === 'oauth' ? '订阅登录' : 'API Key'
      for (const provider of providers) {
        if (authMethods(provider).includes(method as 'api-key' | 'oauth'))
          group.append(
            option(
              method === 'oauth' ? `${provider.label.replace(/\s*订阅$/, '')} · 订阅登录` : provider.label,
              providerValue(provider, method),
            ),
          )
      }
      if (group.children.length) ui.provider.append(group)
    }
    if (savedProviderId && providers.some((provider) => provider.id === savedProviderId))
      ui.provider.value = savedProviderId
    else if (providers[0]) ui.provider.value = providers[0].id
    const selected = providers.find((provider) => provider.id === providerId())
    const methods = selected?.authMethods ?? [selected?.authType ?? 'api-key']
    ui.authMethod.replaceChildren(
      ...methods.map((method) => option(method === 'oauth' ? '订阅登录' : 'API Key', method)),
    )
    const saved = savedProvider()
    const savedAuth = saved && 'authType' in saved ? saved.authType : undefined
    if (savedAuth && methods.includes(savedAuth)) ui.authMethod.value = savedAuth
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
    tested = isOAuth() && saved?.authType === 'oauth' ? { models: saved.models, verified: false } : undefined
    ui.models.value = ''
    renderModels()
    if (clearError) ui.error.textContent = ''
    ui.state.textContent = '连接信息已变更。请重新测试 Provider；此前的模型列表已失效。'
  }

  const input = (): { providerId: string; accountId?: string; baseUrl?: string; apiKey?: string } => {
    const selectedId = providerId()
    const selected = providers.find((provider) => provider.id === selectedId)
    if (!selectedId || !selected) throw new Error('请选择 Provider')
    const baseUrl = ui.baseUrl.value.trim()
    const apiKey = ui.apiKey.value
    if (!isOAuth() && selectedAccount()?.authType === 'oauth' && !apiKey)
      throw new Error('从订阅登录切换为 API Key 时，请输入新的 API key')
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
      ui.state.textContent = snapshot.configured
        ? '已加载保存的 Provider 与默认模型。测试连接后可更新默认模型；当前会话模型不会在此更改。'
        : '第 1 步：选择 Provider 并测试连接；验证后才能选择默认模型。'
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
      ui.state.textContent = '正在测试所选订阅模型…'
      updateButtons()
      try {
        await options.client.config.oauth({ action: 'test', operationId: oauthId, model })
        if (ownsTest()) ui.state.textContent = '所选模型测试通过，可以保存账户。'
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
    ui.state.textContent = '第 2 步：正在测试 Provider…'
    updateButtons()
    try {
      const result = await options.client.config.test({
        ...request,
        ...(isOAuth() && ui.models.value ? { model: ui.models.value } : {}),
      })
      if (!ownsTest()) return
      if (isOAuth()) tested = result
      if (!result.verified || result.models.length === 0) throw new Error('Provider 未返回可验证的模型目录')
      tested = result
      ui.state.textContent = `第 3 步：连接成功，发现 ${result.models.length} 个模型。确认或选择默认模型后保存；当前会话模型不会改变。`
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
    if (!connected || testPending || savePending || !tested?.verified || !ui.models.value) return
    const token = lifecycle
    const inputRevision = revision
    const modelId = ui.models.value
    let request: ReturnType<typeof input>
    try {
      request = input()
      if (accountName && editingId && !accountName.value.trim()) throw new Error('请填写账户名称')
    } catch (error) {
      setError(error)
      return
    }
    savePending = true
    ui.error.textContent = ''
    ui.state.textContent = '正在保存默认配置…'
    updateButtons()
    try {
      const oauthId = oauth.operation()
      const oauthResult = oauthId
        ? await options.client.config.oauth({ action: 'commit', operationId: oauthId, model: modelId })
        : undefined
      if (oauthId && !oauthResult?.snapshot) throw new Error('登录保存未完成')
      const saved =
        oauthResult?.snapshot ??
        (await options.client.config.save({
          ...request,
          ...(accountName && editingId ? { label: accountName.value.trim() } : {}),
          model: modelId,
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
          ? '默认配置已保存；当前后台需要重启后生效。当前会话模型不会改变。'
          : '默认配置已保存；仅新建任务会使用新的默认模型，当前会话模型不会改变。'
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
    editingId = id ?? `acct-${crypto.randomUUID()}`
    suggestedAccountLabel = undefined
    removingId = undefined
    if (accountName) accountName.value = selectedAccount()?.label ?? ''
    renderProviders()
    resetTest()
    renderAccounts()
    ui.state.textContent = id
      ? '正在编辑账户。测试后保存；修改只对新会话生效。'
      : '添加模型账户；每个账户单独保存地址与密钥。'
    if (accountDialogTitle) accountDialogTitle.textContent = id ? '账户详情' : '添加账户'
    if (accountDialogContext)
      accountDialogContext.textContent = id ? '编辑连接与默认模型' : '填写连接信息后测试并保存'
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
          ? '已保存；需要重启后台后生效。'
          : '已保存；对新会话生效，已有会话保持原配置。'
    } catch (error) {
      if (current(token)) setError(error)
    } finally {
      savePending = false
      if (current(token)) updateButtons()
    }
  }
  const renderAccounts = (): void => {
    const currentAccountList = accountList()
    if (!currentAccountList) return
    currentAccountList.replaceChildren()
    for (const row of configuration?.accounts ?? []) {
      const item = document.createElement('div')
      item.className = 'config-account'
      item.dataset.selected = String(row.accountId === editingId)
      item.dataset.credential = row.credentialConfigured ? 'configured' : 'missing'
      const title = document.createElement('button')
      title.type = 'button'
      title.className = 'config-account-select'
      title.setAttribute('aria-pressed', String(row.accountId === editingId))
      title.textContent = row.label
      title.addEventListener('click', () => editAccount(row.accountId))
      const info = document.createElement('span')
      info.className = 'config-account-meta'
      const route = document.createElement('span')
      route.textContent = `${row.providerId} · ${row.model}`
      const state = document.createElement('span')
      state.className = 'config-account-status'
      state.dataset.tone = row.enabled ? 'success' : 'neutral'
      state.textContent = row.enabled ? '已启用' : '已停用'
      info.append(route, state)
      if (configuration?.defaultAccountId === row.accountId) {
        const defaultStatus = document.createElement('span')
        defaultStatus.className = 'config-account-status'
        defaultStatus.dataset.tone = 'brand'
        defaultStatus.textContent = '默认'
        info.append(defaultStatus)
      }
      const actions = document.createElement('div')
      actions.className = 'config-account-actions'
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.textContent = '编辑'
      edit.setAttribute('aria-label', `编辑 ${row.label}`)
      edit.addEventListener('click', () => editAccount(row.accountId))
      actions.append(edit)
      for (const [action, label] of [
        [row.enabled ? 'disable' : 'enable', row.enabled ? '停用' : '启用'],
        ['default', '设为默认'],
        ['remove', removingId === row.accountId ? '确认删除' : '删除'],
      ] as const) {
        if (action === 'default' && (!row.enabled || configuration?.defaultAccountId === row.accountId))
          continue
        // Make the default transfer explicit before disabling/removing its account.
        if (
          ['disable', 'remove'].includes(action) &&
          configuration?.defaultAccountId === row.accountId &&
          configuration.accounts?.some((other) => other.enabled && other.accountId !== row.accountId)
        )
          continue
        const control = document.createElement('button')
        control.type = 'button'
        control.textContent = label
        control.setAttribute('aria-label', `${label} ${row.label}`)
        control.addEventListener('click', () => void accountAction(row, action))
        actions.append(control)
      }
      if (removingId === row.accountId) {
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.textContent = '取消删除'
        cancel.addEventListener('click', () => {
          removingId = undefined
          renderAccounts()
        })
        actions.append(cancel)
      }
      item.append(title, info, actions)
      currentAccountList.append(item)
    }
    updateButtons()
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
    ui.authMethod.replaceChildren(
      ...methods.map((method) => option(method === 'oauth' ? '订阅登录' : 'API Key', method)),
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
  ui.models.addEventListener('change', () => {
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
            setError(new Error('后台未连接'))
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
      ui.state.textContent = '后台连接已断开。'
      setLoadPhase('error')
    }
    renderKeyHint()
    updateButtons()
    if (connected && ui.dialog.open && !opening) void open()
  }

  return { open, close, setConnected }
}
