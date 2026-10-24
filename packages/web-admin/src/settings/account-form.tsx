import type {
  ConfigModel,
  ConfigProvider,
  ConfigTestResult,
  ModelSettings,
  ThinkingLevel,
} from '@agnes/protocol'
import { minimumContextBudget } from '@agnes/protocol'
import { tr } from '@agnes/web-foundation/locale-bridge'
import {
  formatTokens,
  modelThinkingOptions,
  parseContextBudget,
  providerHue,
  renderRegion,
  Segmented,
  SettingsTag,
  setDisclosureOpen,
  setSettingsSelectOptions,
} from '@agnes/web-ui'
import { COMPATIBLE_PROVIDER, syncAccountHeading } from './account-tiles.js'
import { configurationField, optionalElement, type SettingsElements } from './dialog.js'

/** The account form's fields that can be wrong: each names its control and the line under it. */
const FIELDS = {
  apiKey: ['config-api-key', 'config-error'],
  baseUrl: ['config-base-url', 'config-base-url-error'],
  name: ['config-account-name', 'config-account-name-error'],
  contextWindow: ['config-context-window', 'config-context-window-error'],
  thinking: ['config-thinking', 'config-thinking-error'],
  network: ['account-network-connectMs', 'config-account-network-error'],
} as const
type AccountField = keyof typeof FIELDS
const LOCAL_FIELD = Symbol('account field')

/** An error this form raised about one of its own fields. */
export function fieldError(field: AccountField, message: string): Error {
  return Object.assign(new Error(message), { [LOCAL_FIELD]: field })
}

/** Where an error belongs: a field this form raised it for, or one the configuration boundary named. */
function fieldOf(error: unknown): AccountField | undefined {
  if (error instanceof Error && LOCAL_FIELD in error) return error[LOCAL_FIELD] as AccountField
  const named = configurationField(error)
  return named === 'baseUrl' ? 'baseUrl' : named ? 'apiKey' : undefined
}

const byId = (id: string) => document.getElementById(id) ?? undefined
const endpoint = (url: string) =>
  url
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/+$/, '')
const describedBy = (control: HTMLElement, id: string, add: boolean) => {
  const ids = (control.getAttribute('aria-describedby') ?? '').split(' ').filter((one) => one && one !== id)
  if (add) ids.push(id)
  if (ids.length) control.setAttribute('aria-describedby', ids.join(' '))
  else control.removeAttribute('aria-describedby')
}

/** The host of an endpoint, for 「Connecting to api.example.com…」. */
export function endpointHost(url: string): string {
  return endpoint(url).split('/')[0] ?? ''
}

export type AccountFormState = {
  step: 'provider' | 'connection'
  editing: boolean
  inline: boolean
  provider: ConfigProvider | undefined
  oauth: boolean
  tested: ConfigTestResult | undefined
  /** The timeouts the advanced options hold, in milliseconds; an absent key is the default. */
  timeouts: Readonly<Record<string, number>>
}

/**
 * The presentation the account controller derives from its state: the provider card, the auth
 * segments, the key's wording, the locked model group, the advanced summary and each field's
 * error. The controller keeps the values and the flow; this only shows them.
 */
export function accountForm(ui: SettingsElements) {
  const advanced = byId('config-account-advanced')
  const name = optionalElement('config-account-name', 'input')
  let provider: ConfigProvider | undefined
  byId('config-provider-change')?.addEventListener('click', () => byId('config-account-back')?.click())
  byId('config-model-lock-test')?.addEventListener('click', () => ui.test.click())
  byId('config-base-url-reset')?.addEventListener('click', () => {
    if (!provider) return
    ui.baseUrl.value = provider.baseUrl
    ui.baseUrl.dispatchEvent(new Event('input', { bubbles: true }))
    ui.baseUrl.focus()
  })

  const clearField = (field: AccountField): void => {
    const [controlId, slotId] = FIELDS[field]
    const slot = byId(slotId)
    if (slot) slot.textContent = ''
    const control = byId(controlId)
    if (!control) return
    control.removeAttribute('aria-invalid')
    describedBy(control, slotId, false)
  }
  const clearErrors = (): void => {
    for (const field of Object.keys(FIELDS) as AccountField[]) clearField(field)
  }

  /** The closed advanced options name what they hold; a changed value is marked. */
  const summary = (state: AccountFormState, custom: boolean) => {
    const label = name?.value.trim()
    const timeouts = Object.entries(state.timeouts).map(([key, ms]) => ({
      text: `${tr(`accounts.network.${key}`)} ${tr('accounts.network.seconds', { count: String(ms / 1000) })}`,
      set: true,
    }))
    const tags = [
      ...(label ? [{ text: tr('accounts.summaryName', { name: label }), set: false }] : []),
      { text: tr(custom ? 'accounts.summaryCustomUrl' : 'accounts.summaryDefaultUrl'), set: custom },
      ...(timeouts.length ? timeouts : [{ text: tr('accounts.summaryTimeouts'), set: false }]),
    ]
    return (
      <>
        {tags.map(({ text, set }) => (
          <SettingsTag key={text} tone={set ? 'brand' : 'muted'}>
            {text}
          </SettingsTag>
        ))}
      </>
    )
  }

  return {
    clearErrors,
    /** Whether any field, or the connection line, holds an error. */
    hasError: (): boolean => Object.values(FIELDS).some(([, slot]) => !!byId(slot)?.textContent),
    /**
     * Tell `message` under the field it is about, open the section it sits in and go there. True
     * when it is told on the connection line (the key, or no field at all), false for a field's own.
     */
    error(error: unknown, message: string): boolean {
      clearErrors()
      const field = fieldOf(error)
      const [controlId, slotId] = field ? FIELDS[field] : [undefined, 'config-error']
      const slot = byId(slotId)
      if (slot) slot.textContent = message
      const control = controlId ? byId(controlId) : undefined
      if (control) {
        control.setAttribute('aria-invalid', 'true')
        describedBy(control, slotId, true)
        // A select is operated through its picker; the picker's trigger is what can take focus.
        const target = byId(`${control.id}-trigger`) ?? control
        if (advanced?.contains(target)) setDisclosureOpen(advanced, true)
        target.focus()
      }
      return slotId === 'config-error'
    },
    sync(state: AccountFormState): void {
      provider = state.provider
      // A compatible endpoint has no default address to show, offer back or fall back to.
      const compatible = provider?.id === COMPATIBLE_PROVIDER
      const defaultUrl = compatible ? '' : (provider?.baseUrl ?? '')
      syncAccountHeading(
        optionalElement('config-detail-title', 'h3'),
        state.step,
        state.editing,
        state.inline,
        provider?.label ?? '',
        tr,
      )
      const logo = byId('config-provider-logo')
      if (logo) {
        logo.textContent = (provider?.label.trim()[0] ?? '').toUpperCase()
        logo.dataset.hue = String(providerHue(provider?.id ?? ''))
      }
      const title = byId('config-provider-name')
      if (title) title.textContent = provider?.label ?? ''
      const host = byId('config-provider-host')
      if (host) host.textContent = endpoint(ui.baseUrl.value || defaultUrl)
      const change = byId('config-provider-change')
      if (change) change.hidden = state.editing
      const auth = byId('config-auth-choice')
      if (auth)
        renderRegion(
          auth,
          <Segmented
            label={tr('settings.oauth.methodLabel')}
            value={ui.authMethod.value}
            disabled={ui.authMethod.disabled}
            block
            options={[
              { value: 'api-key', label: tr('accounts.authApiKey') },
              { value: 'oauth', label: tr('accounts.authOAuth') },
            ]}
            onChange={(next) => {
              ui.authMethod.value = next
              ui.authMethod.dispatchEvent(new Event('change', { bubbles: true }))
            }}
          />,
        )
      ui.apiKey.placeholder = tr(
        compatible
          ? 'accounts.keyOptional'
          : state.editing
            ? 'accounts.keyPlaceholder'
            : 'accounts.keyPlaceholderNew',
      )
      const locked = !state.tested?.models.length || (!state.oauth && !state.tested.verified)
      const group = byId('config-model-fields')
      if (group) group.dataset.locked = String(locked)
      const lock = byId('config-model-lock')
      if (lock) lock.hidden = !locked
      const lockText = byId('config-model-lock-text')
      if (lockText)
        lockText.textContent = tr(state.oauth ? 'accounts.modelLockedOAuth' : 'accounts.modelLocked')
      const lockTest = byId('config-model-lock-test')
      if (lockTest) lockTest.hidden = !state.editing || state.oauth
      if (advanced) advanced.hidden = state.step !== 'connection'
      const address = ui.baseUrl.value.trim().replace(/\/+$/, '')
      const custom = !state.oauth && !!provider && !!address && address !== defaultUrl.replace(/\/+$/, '')
      const reset = byId('config-base-url-reset')
      if (reset) reset.hidden = !custom || compatible
      const hint = byId('config-base-url-hint')
      if (hint)
        hint.textContent = compatible
          ? tr('accounts.compatible.urlHint')
          : provider
            ? tr('accounts.baseUrlHint', { url: provider.baseUrl })
            : ''
      const meta = byId('config-account-advanced-meta')
      if (meta) renderRegion(meta, summary(state, custom))
    },
    /** The default thinking effort and context budget as entered, checked against the model. */
    readModelSettings(model: ConfigModel | undefined): ModelSettings {
      const thinking = ui.thinking?.value ?? model?.defaultSettings?.thinking
      const window = ui.contextWindow?.value.trim() ?? String(model?.defaultSettings?.contextWindow ?? '')
      const tokens = parseContextBudget(window)
      if (
        thinking &&
        !modelThinkingOptions(model?.thinkingLevelMap, tr).some((option) => option.value === thinking)
      )
        throw fieldError('thinking', tr('settings.model.thinkingUnsupported'))
      const minimum = minimumContextBudget(model?.contextWindow)
      if (window && (tokens === undefined || tokens < minimum))
        throw fieldError(
          'contextWindow',
          tr('settings.model.contextRange', { min: minimum.toLocaleString() }),
        )
      if (tokens !== undefined && model?.contextWindow !== undefined && tokens > model.contextWindow)
        throw fieldError(
          'contextWindow',
          tr('accounts.overCapacity', { tokens: formatTokens(model.contextWindow) }),
        )
      return {
        ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
        ...(tokens === undefined ? {} : { contextWindow: tokens }),
      }
    },
    /** Show the chosen model's thinking choices, capacity and the defaults saved for it. */
    renderModelSettings(model: ConfigModel | undefined, defaults: ModelSettings): void {
      clearField('thinking')
      clearField('contextWindow')
      if (ui.thinking) {
        const options = modelThinkingOptions(model?.thinkingLevelMap, tr)
        if (defaults.thinking && !options.some((option) => option.value === defaults.thinking))
          options.push({
            value: defaults.thinking,
            label: tr('settings.model.savedThinkingUnavailable', { value: defaults.thinking }),
          })
        setSettingsSelectOptions(ui.thinking, options)
        ui.thinking.value = defaults.thinking ?? ''
      }
      if (ui.contextWindow) {
        ui.contextWindow.value = String(defaults.contextWindow ?? '')
        if (model?.contextWindow) ui.contextWindow.max = String(model.contextWindow)
        else ui.contextWindow.removeAttribute('max')
      }
      const capacity = byId('config-model-capacity')
      if (capacity)
        capacity.textContent = model?.contextWindow
          ? tr('accounts.capacity', { tokens: formatTokens(model.contextWindow) })
          : ''
    },
  }
}
