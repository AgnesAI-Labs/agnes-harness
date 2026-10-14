import type { ReactNode } from 'react'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsPage } from './settings-layout.js'
import { Button } from './ui/button.js'
import { Icon } from './ui/icon.js'
import { SettingsBlock } from './ui/settings-controls.js'
import { SettingsInfo } from './ui/settings-subpages.js'

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
      headingId="config-title"
      bodyClassName="config-workspace"
      actions={
        // The page's primary action sits in its header, inside the column and clear of the close button.
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
      {beforeAccounts}
      <SettingsBlock
        bare
        className="config-accounts-section"
        aria-label={t('settings-shell.accountsAria')}
        label={
          <>
            {t('settings-shell.accountsTitle')}
            <SettingsInfo text={t('settings-shell.accountsNote')} />
          </>
        }
      >
        <div
          id="config-accounts"
          data-empty-text={t('accounts.empty')}
          data-loading-text={t('accounts.loading')}
        />
      </SettingsBlock>
      <div id="config-auxiliary-models" />
      {afterAccounts}
    </SettingsPage>
  )
}
