import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsPage } from './settings-layout.js'
import { Button } from './ui/button.js'
import { Icon } from './ui/icon.js'
import { SettingsBlock } from './ui/settings-controls.js'
import { SettingsDrill, SettingsInfo } from './ui/settings-subpages.js'

/** What shows the account form inside a settings page: the account controller registers it. */
export type SettingsAccountPage = {
  /** Put the form into `host`; the returned function takes it back when the page closes. */
  attach(host: HTMLElement, mode: 'add' | 'edit'): () => void
}
let accountPage: SettingsAccountPage | undefined
/**
 * The account controller owns the form and its fields; adding or editing an account opens a page
 * of the settings dialog that borrows the form, instead of a centred dialog.
 */
export function setSettingsAccountPage(page: SettingsAccountPage | undefined): void {
  accountPage = page
}
/** The settings drill ids of the two account pages, for opening them by their row. */
export const ACCOUNT_PAGE_IDS = { add: 'add-account', edit: 'account' } as const

function AccountPageHost({ mode }: { mode: 'add' | 'edit' }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = host.current
    if (!node || !accountPage) return
    return accountPage.attach(node, mode)
  }, [mode])
  return <div ref={host} className="account-page-host" data-testid={`account-page-${mode}`} />
}

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
      {/* The two account pages open from the header button and from a row; their rows stay hidden. */}
      <SettingsDrill
        id={ACCOUNT_PAGE_IDS.add}
        hidden
        label={t('settings-shell.addAccount')}
        description={t('accounts.addContext')}
      >
        <AccountPageHost mode="add" />
      </SettingsDrill>
      <SettingsDrill
        id={ACCOUNT_PAGE_IDS.edit}
        hidden
        label={t('accounts.title')}
        description={t('accounts.context')}
      >
        <AccountPageHost mode="edit" />
      </SettingsDrill>
    </SettingsPage>
  )
}
