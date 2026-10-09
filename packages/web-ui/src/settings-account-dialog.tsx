import { fallbackT, type Translate } from './locales/index.js'
import { SettingsInput } from './settings-layout.js'
import { SettingsOptionSelect } from './settings-option-select.js'
import { Button } from './ui/button.js'
import { Field } from './ui/field.js'

export function SettingsAccountDialog({ t = fallbackT }: { t?: Translate }) {
  return (
    <dialog data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title">
      <Button
        id="account-dialog-close"
        type="text"
        htmlType="button"
        className="icon-button account-dialog-close"
        aria-label={t('accounts.closeAria')}
      >
        <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </Button>
      <section className="account-dialog-body" aria-labelledby="config-detail-title">
        <div className="config-detail-heading">
          <div>
            <p className="eyebrow">{t('accounts.kicker')}</p>
            <h3 id="config-detail-title">{t('accounts.title')}</h3>
          </div>
          <p id="config-account-context">{t('accounts.context')}</p>
        </div>
        <div className="config-detail-grid">
          <fieldset className="config-section">
            <legend>{t('accounts.connectionLegend')}</legend>
            <Field className="form-field" label={t('accounts.nameLabel')}>
              <SettingsInput
                id="config-account-name"
                maxLength={128}
                autoComplete="off"
                placeholder={t('accounts.namePlaceholder')}
              />
            </Field>
            <Field className="form-field" label={t('accounts.providerLabel')}>
              <SettingsOptionSelect id="config-provider" />
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
            <Field className="form-field form-field-wide" label={t('accounts.apiKeyLabel')}>
              <SettingsInput
                id="config-api-key"
                type="password"
                autoComplete="new-password"
                placeholder={t('accounts.keyPlaceholder')}
                aria-describedby="config-key-hint"
              />
            </Field>
            <p id="config-key-hint" className="field-hint form-field-wide" />
            <div id="config-oauth-controls" className="form-field-wide" />
          </fieldset>
          <fieldset className="config-section config-validation-section">
            <legend>{t('accounts.validationLegend')}</legend>
            <div className="config-validation-controls">
              <Field className="form-field" label={t('accounts.defaultModelLabel')}>
                <SettingsOptionSelect id="config-model" />
              </Field>
              <Button id="config-test" className="secondary-button" htmlType="button">
                <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
                </svg>
                <span>{t('accounts.testConnection')}</span>
              </Button>
            </div>
            <Field className="form-field" label={t('accounts.defaultThinkingLabel')}>
              <SettingsOptionSelect id="config-thinking" />
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
            <p id="config-state" aria-live="polite" />
            <Button id="config-retry" className="secondary-button compact" htmlType="button" hidden>
              {t('accounts.retryRead')}
            </Button>
            <p id="config-error" role="alert" />
          </fieldset>
          <div id="config-account-network" />
        </div>
        <div className="config-detail-footer">
          <p id="config-account-guard">{t('accounts.guard')}</p>
          <Button id="config-save" className="primary-button" htmlType="submit" form="config-form" disabled>
            {t('accounts.save')}
          </Button>
        </div>
      </section>
    </dialog>
  )
}
