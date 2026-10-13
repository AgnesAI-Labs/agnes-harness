import type { ReactNode } from 'react'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsPage, SettingsSection } from './settings-layout.js'
import { Button } from './ui/button.js'
import { Icon } from './ui/icon.js'

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
    <SettingsPage
      id="model-settings-pane"
      className="settings-content"
      data-agnes-region="settings-pane"
      title={t('settings-shell.modelTitle')}
      description={t('settings-shell.modelIntro')}
      headingId="config-title"
      bodyClassName="config-workspace"
    >
      {beforeAccounts}
      <SettingsSection
        className="config-accounts-section"
        aria-label={t('settings-shell.accountsAria')}
        title={t('settings-shell.accountsTitle')}
        description={t('settings-shell.accountsIntro')}
        actions={
          // The action belongs to the list it adds to, clear of the dialog's close button.
          <Button
            id="config-add-account"
            appearance="primary"
            htmlType="button"
            aria-label={t('settings-shell.addAccount')}
          >
            <Icon name="plus" />
            <span>{t('settings-shell.addAccount')}</span>
          </Button>
        }
      >
        <div
          id="config-accounts"
          data-empty-text={t('accounts.empty')}
          data-loading-text={t('accounts.loading')}
        />
        <p className="config-list-note">{t('settings-shell.accountsNote')}</p>
      </SettingsSection>
      <div id="config-auxiliary-models" />
      {afterAccounts}
    </SettingsPage>
  )
}
