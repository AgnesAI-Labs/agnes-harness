import { fallbackT, type Translate } from './locales/index.js'
import { SettingsInput } from './settings-layout.js'
import { SettingsOptionSelect } from './settings-option-select.js'
import { Button } from './ui/button.js'
import { Disclosure } from './ui/disclosure.js'
import { Field } from './ui/field.js'
import { Icon } from './ui/icon.js'

export function SettingsAccountDialog({ t = fallbackT }: { t?: Translate }) {
  return (
    <dialog data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title">
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
      <section className="account-dialog-body" aria-labelledby="config-detail-title">
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
            <fieldset className="config-section">
              <Field className="form-field form-field-wide" label={t('accounts.apiKeyLabel')}>
                <SettingsInput
                  id="config-api-key"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('accounts.keyPlaceholder')}
                  aria-describedby="config-key-hint"
                />
              </Field>
              <Disclosure variant="plain" className="account-key-help" summary={t('accounts.keyHelp')}>
                <p>{t('accounts.keyHelpText')}</p>
              </Disclosure>
              <p id="config-key-hint" className="field-hint form-field-wide" />
              <div id="config-oauth-controls" className="form-field-wide" />
            </fieldset>
            {/* The key is tested as soon as it is entered; the result reads here, where it happened. */}
            <div className="account-status" id="config-account-status">
              <p id="config-state" aria-live="polite" />
              <p id="config-error" role="alert" />
              <Button id="config-test" appearance="ghost" size="small" htmlType="button">
                <Icon name="refresh-cw" />
                <span>{t('accounts.testConnection')}</span>
              </Button>
              <Button id="config-retry" size="small" htmlType="button" hidden>
                {t('accounts.retryRead')}
              </Button>
            </div>
            {/* What a new session starts with: shown once the connection has models to offer. */}
            <fieldset className="config-section config-validation-section" id="config-model-fields">
              <legend>{t('accounts.validationLegend')}</legend>
              <Field className="form-field" label={t('accounts.defaultModelLabel')}>
                <SettingsOptionSelect id="config-model" />
              </Field>
              <Field className="form-field" label={t('accounts.defaultThinkingLabel')}>
                <SettingsOptionSelect id="config-thinking" />
              </Field>
            </fieldset>
            <Disclosure
              variant="plain"
              id="config-account-advanced"
              summary={t('accounts.advanced')}
              meta={t('accounts.advancedSummary')}
            >
              <fieldset className="config-section">
                <Field className="form-field" label={t('accounts.nameLabel')}>
                  <SettingsInput
                    id="config-account-name"
                    maxLength={128}
                    autoComplete="off"
                    placeholder={t('accounts.namePlaceholder')}
                  />
                </Field>
                <Field
                  className="form-field form-field-wide"
                  id="config-auth-method-field"
                  label={t('settings.oauth.methodLabel')}
                >
                  <SettingsOptionSelect id="config-auth-method" />
                </Field>
                <Field className="form-field form-field-wide" label={t('accounts.baseUrlLabel')}>
                  <SettingsInput id="config-base-url" autoComplete="url" />
                </Field>
                <Field className="form-field" label={t('accounts.contextBudgetLabel')}>
                  <SettingsInput
                    id="config-context-window"
                    type="text"
                    maxLength={32}
                    placeholder={t('accounts.contextBudgetPlaceholder')}
                    aria-describedby="config-model-settings-hint config-error"
                  />
                </Field>
                <p id="config-model-settings-hint" className="field-hint">
                  {t('accounts.modelSettingsHint')}
                </p>
              </fieldset>
              <div id="config-account-network" />
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
      </section>
    </dialog>
  )
}
