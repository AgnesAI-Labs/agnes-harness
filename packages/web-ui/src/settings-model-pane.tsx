import type { ReactNode } from 'react'
import { fallbackT, type Translate } from './locales/index.js'
import { Button } from './ui/button.js'

export function SettingsModelPane({
  beforeAccounts,
  afterAccounts,
  t = fallbackT,
}: {
  beforeAccounts: ReactNode
  afterAccounts: ReactNode
  t?: Translate
}) {
  return (
    <section id="model-settings-pane" className="settings-content" data-agnes-region="settings-pane">
      <header className="config-heading">
        <div>
          <p className="eyebrow">{t('settings-shell.modelKicker')}</p>
          <h2 id="config-title">{t('settings-shell.modelTitle')}</h2>
          <p>{t('settings-shell.modelIntro')}</p>
        </div>
      </header>
      <div className="config-workspace">
        {beforeAccounts}
        <section
          className="config-accounts-section config-card"
          aria-label={t('settings-shell.accountsAria')}
        >
          <div className="config-accounts-heading">
            <div>
              <h3>{t('settings-shell.accountsTitle')}</h3>
              <p>{t('settings-shell.accountsIntro')}</p>
            </div>
            <Button id="config-add-account" className="secondary-button compact" htmlType="button">
              <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>{t('settings-shell.addAccount')}</span>
            </Button>
          </div>
          <div id="config-accounts" />
          <p className="config-list-note">{t('settings-shell.accountsNote')}</p>
        </section>
        {afterAccounts}
      </div>
    </section>
  )
}
