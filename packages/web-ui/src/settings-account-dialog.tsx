import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fallbackT, type Translate } from './locales/index.js'
import { createRegionHost } from './region-host.js'
import { SettingsInput } from './settings-layout.js'
import { SettingsOptionSelect } from './settings-option-select.js'
import { Button } from './ui/button.js'
import { Disclosure } from './ui/disclosure.js'
import { Field } from './ui/field.js'
import { Icon } from './ui/icon.js'
import { IconButton } from './ui/icon-button.js'

/**
 * The key field. Its label row offers where to get a key, opened in place above the field, and the
 * key can be shown while it is typed; the controller owns its value, state and placeholder.
 */
function AccountKeyField({ t }: { t: Translate }) {
  const [help, setHelp] = useState(false)
  const [shown, setShown] = useState(false)
  return (
    <div className="account-field account-key-field">
      <div className="account-field-head">
        <Field className="form-field" label={t('accounts.apiKeyLabel')} htmlFor="config-api-key" />
        <Button
          appearance="link"
          size="small"
          htmlType="button"
          aria-expanded={help}
          aria-controls="config-key-help"
          onClick={() => setHelp(!help)}
        >
          {t('accounts.keyHelp')}
        </Button>
      </div>
      <p id="config-key-help" className="account-help" hidden={!help}>
        {t('accounts.keyHelpText')}
      </p>
      <span className="account-input">
        <SettingsInput
          id="config-api-key"
          className="account-mono"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder={t('accounts.keyPlaceholderNew')}
          aria-describedby="config-key-hint"
        />
        <IconButton
          name={shown ? 'eye-off' : 'eye'}
          label={t(shown ? 'accounts.hideKey' : 'accounts.showKey')}
          aria-pressed={shown}
          htmlType="button"
          onClick={() => setShown(!shown)}
        />
      </span>
    </div>
  )
}

export function SettingsAccountDialog({ t = fallbackT }: { t?: Translate }) {
  const bodyRef = useRef<HTMLElement>()
  const [body, setBody] = useState<HTMLElement>()
  // The inline first-run controller moves this host. Delegated events move with the portal host,
  // while its fields stay in the application's one React tree.
  const attach = useCallback((dialog: HTMLDialogElement | null) => {
    if (!dialog || bodyRef.current) return
    const node = createRegionHost(dialog, 'section', 'account-dialog-body')
    node.setAttribute('aria-labelledby', 'config-detail-title')
    bodyRef.current = node
    setBody(node)
  }, [])
  useLayoutEffect(() => () => bodyRef.current?.remove(), [])
  return (
    <dialog ref={attach} data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title">
      <Button
        id="account-dialog-close"
        type="text"
        htmlType="button"
        className="account-dialog-close"
        aria-label={t('accounts.closeAria')}
        title={t('accounts.closeAria')}
      >
        <Icon name="x" />
      </Button>
      {body &&
        createPortal(
          <>
            <div className="config-detail-heading">
              <div>
                <h3 id="config-detail-title">{t('accounts.title')}</h3>
              </div>
              <p id="config-account-context">{t('accounts.context')}</p>
            </div>
            <div className="config-detail-grid">
              {/* Two steps, named once; the line under the key says what is happening. */}
              <ol id="config-account-steps" className="account-steps" aria-label={t('accounts.stepsAria')}>
                <li data-step="provider">{t('accounts.stepProvider')}</li>
                <li data-step="connection">{t('accounts.stepConnect')}</li>
              </ol>
              <fieldset className="config-section account-provider-step">
                <legend>{t('accounts.connectionLegend')}</legend>
                <Field className="form-field" label={t('accounts.providerLabel')}>
                  <SettingsOptionSelect id="config-provider" />
                </Field>
              </fieldset>
              <div id="config-provider-choices" />
              <div className="account-connection-step">
                <p className="field-hint">{t('accounts.connectNext')}</p>
                {/* The provider being connected; Choose another provider goes back to the tiles. */}
                <div className="account-provider-card" id="config-provider-card">
                  <span className="agnes-settings-logo" id="config-provider-logo" aria-hidden="true" />
                  <span className="account-provider-card-copy">
                    <strong id="config-provider-name" />
                    <span id="config-provider-host" />
                  </span>
                  <Button id="config-provider-change" appearance="link" size="small" htmlType="button">
                    {t('accounts.changeProvider')}
                  </Button>
                </div>
                <fieldset className="config-section account-connection">
                  <legend>{t('accounts.connectionLegend')}</legend>
                  {/* The select holds the choice; the controller shows it as two segments. */}
                  <div id="config-auth-method-field" className="account-auth-method">
                    <span hidden>
                      <SettingsOptionSelect id="config-auth-method" />
                    </span>
                    <div id="config-auth-choice" />
                  </div>
                  <AccountKeyField t={t} />
                  <p id="config-key-hint" className="field-hint form-field-wide" />
                  <div id="config-oauth-controls" className="form-field-wide" />
                  {/* An OpenAI-compatible account's models: listed ones to pick, others typed by hand. */}
                  <div id="config-compatible-models" className="form-field-wide" hidden />
                  {/* The key is tested as soon as it is entered; the result reads here, where it happened. */}
                  <div className="account-status" id="config-account-status">
                    <p id="config-state" aria-live="polite" />
                    <p id="config-error" role="alert" />
                    <Button id="config-test" appearance="link" size="small" htmlType="button">
                      {t('accounts.testConnection')}
                    </Button>
                    <Button id="config-retry" size="small" htmlType="button" hidden>
                      {t('accounts.retryRead')}
                    </Button>
                  </div>
                </fieldset>
                {/* What a new session starts with; it opens once the connection has models to offer. */}
                <fieldset className="config-section config-validation-section" id="config-model-fields">
                  <legend>{t('accounts.validationLegend')}</legend>
                  <p id="config-model-lock" className="account-lock-note">
                    <Icon name="lock-keyhole" />
                    <span id="config-model-lock-text">{t('accounts.modelLocked')}</span>
                    <Button
                      id="config-model-lock-test"
                      appearance="link"
                      size="small"
                      htmlType="button"
                      hidden
                    >
                      {t('accounts.testNow')}
                    </Button>
                  </p>
                  <div className="account-field-pair">
                    <div className="account-field">
                      <Field className="form-field" label={t('accounts.defaultModelLabel')}>
                        <SettingsOptionSelect id="config-model" />
                      </Field>
                    </div>
                    <div className="account-field">
                      <Field className="form-field" label={t('accounts.defaultThinkingLabel')}>
                        <SettingsOptionSelect id="config-thinking" />
                      </Field>
                      <p id="config-thinking-error" className="account-field-error" />
                    </div>
                  </div>
                  <div className="account-field account-budget-field">
                    <Field
                      className="form-field"
                      htmlFor="config-context-window"
                      label={
                        <>
                          {t('accounts.contextBudgetLabel')}
                          <span id="config-model-capacity" className="account-field-aside" />
                        </>
                      }
                    >
                      <span className="account-input">
                        <SettingsInput
                          id="config-context-window"
                          type="text"
                          maxLength={32}
                          placeholder={t('accounts.contextBudgetPlaceholder')}
                          aria-describedby="config-model-settings-hint"
                        />
                        <span className="account-input-suffix">{t('accounts.tokensUnit')}</span>
                      </span>
                    </Field>
                    <p id="config-model-settings-hint" className="field-hint">
                      {t('accounts.modelSettingsHint')}
                    </p>
                    <p id="config-context-window-error" className="account-field-error" />
                  </div>
                </fieldset>
                {/* The summary names the values set inside, so a closed section still says what it holds. */}
                <Disclosure
                  variant="plain"
                  id="config-account-advanced"
                  summary={t('accounts.advanced')}
                  meta={<span id="config-account-advanced-meta" className="account-advanced-meta" />}
                >
                  <div className="account-advanced">
                    <div className="account-field">
                      <Field className="form-field" label={t('accounts.nameLabel')}>
                        <SettingsInput
                          id="config-account-name"
                          maxLength={128}
                          autoComplete="off"
                          placeholder={t('accounts.namePlaceholder')}
                          aria-describedby="config-account-name-hint"
                        />
                      </Field>
                      <p id="config-account-name-hint" className="field-hint">
                        {t('accounts.nameHint')}
                      </p>
                      <p id="config-account-name-error" className="account-field-error" />
                    </div>
                    <div className="account-field">
                      <div className="account-field-head">
                        <Field
                          className="form-field"
                          label={t('accounts.baseUrlLabel')}
                          htmlFor="config-base-url"
                        />
                        <Button
                          id="config-base-url-reset"
                          appearance="link"
                          size="small"
                          htmlType="button"
                          hidden
                        >
                          {t('accounts.resetBaseUrl')}
                        </Button>
                      </div>
                      <SettingsInput
                        id="config-base-url"
                        className="account-mono"
                        autoComplete="url"
                        aria-describedby="config-base-url-hint"
                      />
                      <p id="config-base-url-hint" className="field-hint" />
                      <p id="config-base-url-error" className="account-field-error" />
                    </div>
                    <div className="account-field">
                      <div id="config-account-network" />
                      <p id="config-account-network-error" className="account-field-error" />
                    </div>
                  </div>
                </Disclosure>
                <p id="config-account-guard">{t('accounts.guard')}</p>
              </div>
            </div>
            <div className="config-detail-footer">
              <div id="config-account-discard" hidden role="alert">
                <p>{t('accounts.discard')}</p>
                <Button id="config-account-keep" htmlType="button">
                  {t('accounts.keepEditing')}
                </Button>
                <Button id="config-account-discard-confirm" appearance="danger" htmlType="button">
                  {t('accounts.discardAction')}
                </Button>
              </div>
              <div id="config-account-footer-actions" className="agnes-settings-actions">
                <Button id="config-account-back" appearance="ghost" htmlType="button">
                  {t('accounts.back')}
                </Button>
                <Button id="config-account-cancel" htmlType="button">
                  {t('accounts.cancel')}
                </Button>
                <Button id="config-save" appearance="primary" htmlType="submit" form="config-form" disabled>
                  {t('accounts.save')}
                </Button>
              </div>
            </div>
          </>,
          body,
        )}
    </dialog>
  )
}
