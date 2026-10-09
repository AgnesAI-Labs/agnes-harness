import { tr } from '@agnes/web-foundation/locale-bridge'
import { appServerErrorMessage } from '@agnes/web-ui'

export const CONFIGURATION_REASON_KEYS: Readonly<Record<string, string>> = {
  CONFIG_AUTH_FAILED: 'settings.config.authFailed',
  CONFIG_AUTH_EXPIRED: 'settings.config.authExpired',
  CONFIG_AUTH_BUSY: 'settings.config.authBusy',
  CONFIG_INVALID_INPUT: 'settings.config.invalidInput',
  CONFIG_UNKNOWN_PROVIDER: 'settings.config.unknownProvider',
  CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED: 'settings.config.endpointUnsupported',
  CONFIG_CREDENTIAL_REQUIRED: 'settings.config.credentialRequired',
  CONFIG_CREDENTIAL_REJECTED: 'settings.config.credentialRejected',
  CONFIG_CREDENTIAL_PERMISSIONS: 'settings.config.credentialPermissions',
  CONFIG_CREDENTIAL_NO_SPACE: 'settings.config.credentialNoSpace',
  CONFIG_CREDENTIAL_READ_ONLY: 'settings.config.credentialReadOnly',
  CONFIG_CREDENTIAL_INVALID: 'settings.config.credentialInvalid',
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

export function configurationReason(error: unknown, t: (key: string) => string = tr): string | undefined {
  const localized = appServerErrorMessage(error, document.documentElement.lang)
  if (localized) return localized
  if (error === null || typeof error !== 'object') return undefined
  const data =
    'data' in error && error.data !== null && typeof error.data === 'object' ? error.data : undefined
  const reason = data && 'reason' in data && typeof data.reason === 'string' ? data.reason : undefined
  const key = reason === undefined ? undefined : CONFIGURATION_REASON_KEYS[reason]
  return key === undefined ? undefined : t(key)
}

export type SettingsElements = {
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

export function element<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const found = document.getElementById(id)
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return found as HTMLElementTagNameMap[K]
}

export function optionalElement<K extends keyof HTMLElementTagNameMap>(
  id: string,
  tag: K,
): HTMLElementTagNameMap[K] | undefined {
  const found = document.getElementById(id)
  return found?.tagName.toLowerCase() === tag ? (found as HTMLElementTagNameMap[K]) : undefined
}

export function readElements(): SettingsElements {
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

export const option = (label: string, value: string) => ({ label, value })

export function errorText(error: unknown, secret: string, t: (key: string) => string): string {
  const message =
    configurationReason(error, t) ??
    (error instanceof Error ? error.message : t('settings.config.requestFailed'))
  return secret ? message.split(secret).join('[redacted]') : message
}

export function focusable(value: Element | null): value is HTMLElement {
  return value !== null && typeof (value as HTMLElement).focus === 'function'
}
