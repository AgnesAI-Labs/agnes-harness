import { type ReactNode, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { fallbackT, type Translate } from './locales/index.js'
import { SettingsPage, SettingsTechnicalDetails } from './settings-layout.js'
import { SettingsBlock } from './ui/settings-controls.js'
import { SettingsDrill, SettingsInfo } from './ui/settings-subpages.js'

/** What shows the account form inside a settings page: the account controller registers it. */
export type SettingsAccountPage = {
  /** Put the form into `host`; the returned function takes it back when the page closes. */
  attach(host: HTMLElement, mode: 'add' | 'edit', accountId?: string | null): () => void
}
let accountPage: SettingsAccountPage | undefined
const accountPageListeners = new Set<() => void>()
/**
 * The account controller owns the form and its fields; adding or editing an account opens a page
 * of the settings dialog that borrows the form, instead of a centred dialog.
 */
export function setSettingsAccountPage(page: SettingsAccountPage | undefined): void {
  accountPage = page
  for (const listener of accountPageListeners) listener()
}
/** The settings drill ids of the two account pages, for opening them by their row. */
export const ACCOUNT_PAGE_IDS = { add: 'add-account', edit: 'account' } as const

function AccountPageHost({ mode }: { mode: 'add' | 'edit' }) {
  const host = useRef<HTMLDivElement>(null)
  const page = useSyncExternalStore(
    (listener) => {
      accountPageListeners.add(listener)
      return () => {
        accountPageListeners.delete(listener)
      }
    },
    () => accountPage,
  )
  const accountId = useSyncExternalStore(
    (listener) => {
      window.addEventListener('popstate', listener)
      return () => window.removeEventListener('popstate', listener)
    },
    () => new URL(location.href).searchParams.get('account'),
  )
  useLayoutEffect(() => {
    const node = host.current
    if (!node || !page) return
    return page.attach(node, mode, accountId)
  }, [mode, page, accountId])
  return <div ref={host} className="account-page-host" data-testid={`account-page-${mode}`} />
}

/** What shows the side-model editor inside a settings page: the side-models panel registers it. */
export type SettingsSideModelPage = {
  /** Put the editor into `host`; the returned function is called when the page closes. */
  attach(host: HTMLElement, mode: 'add' | 'edit'): () => void
}
let sideModelPage: SettingsSideModelPage | undefined
const sideModelPageListeners = new Set<() => void>()
export function setSettingsSideModelPage(page: SettingsSideModelPage | undefined): void {
  sideModelPage = page
  for (const listener of sideModelPageListeners) listener()
}
/** The settings drill ids of the two side-model pages, for opening them from the list. */
export const SIDE_MODEL_PAGE_IDS = { add: 'add-side-model', edit: 'side-model' } as const
const subscribeSideModelPage = (listener: () => void) => {
  sideModelPageListeners.add(listener)
  return () => {
    sideModelPageListeners.delete(listener)
  }
}

function SideModelPageHost({ mode }: { mode: 'add' | 'edit' }) {
  const host = useRef<HTMLDivElement>(null)
  const page = useSyncExternalStore(subscribeSideModelPage, () => sideModelPage)
  useLayoutEffect(() => {
    const node = host.current
    if (!node || !page) return
    return page.attach(node, mode)
  }, [mode, page])
  return <div ref={host} className="side-model-page-host" data-testid={`side-model-page-${mode}`} />
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
      routeId="model"
      id="model-settings-pane"
      className="settings-content"
      data-agnes-region="settings-pane"
      title={t('settings-shell.modelTitle')}
      headingId="config-title"
      bodyClassName="config-workspace"
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
      <SettingsTechnicalDetails
        title={
          t('settings-shell.advancedModels') === 'settings-shell.advancedModels'
            ? fallbackT('ui.advancedModels')
            : t('settings-shell.advancedModels')
        }
        data-testid="advanced-models"
      >
        <div id="config-side-models" />
        <div id="config-auxiliary-models" />
      </SettingsTechnicalDetails>
      {afterAccounts}
      {/* The two account pages open from the add row and from an account row; their rows stay hidden. */}
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
      {/* The side-model editor pages open from the side-model list; their rows stay hidden too. */}
      <SettingsDrill id={SIDE_MODEL_PAGE_IDS.add} hidden label={t('settings-shell.addSideModel')}>
        <SideModelPageHost mode="add" />
      </SettingsDrill>
      <SettingsDrill id={SIDE_MODEL_PAGE_IDS.edit} hidden label={t('settings-shell.editSideModel')}>
        <SideModelPageHost mode="edit" />
      </SettingsDrill>
    </SettingsPage>
  )
}
