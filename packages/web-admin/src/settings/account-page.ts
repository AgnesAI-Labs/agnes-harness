import type { ConfigAccount } from '@agnes/protocol'
import {
  ACCOUNT_PAGE_IDS,
  preserveRouteParams,
  SUBPAGE_CLOSE_EVENT,
  setSettingsAccountPage,
} from '@agnes/web-ui'
import { optionalElement } from './dialog.js'

/**
 * The account form as a page of the settings dialog. Adding opens 「Add account」 and editing opens the
 * account's page, each borrowing the one form the controller owns; leaving the page gives the form
 * back to its fallback dialog. Leaving by Back or the browser drops the draft (`onLeave`); a close
 * the controller asked for (a save, Cancel) has already done that and is not repeated.
 */
export function bindAccountPage(
  settings: HTMLElement,
  form: HTMLElement | null | undefined,
  fallback: HTMLDialogElement | null | undefined,
  onLeave: () => void,
  /** The add page was opened from outside the controller (a link): start a new account there. */
  onEnter: (mode: 'add' | 'edit', accountId?: string | null) => void,
) {
  let host: HTMLElement | undefined
  let hostMode: 'add' | 'edit' | undefined
  // The controller closed the page itself; its unmount is not a user leaving.
  let closing = false
  // The controller asked for the page; otherwise it was opened by a link.
  let requested = false
  const row = (id: string) =>
    settings.ownerDocument.querySelector<HTMLButtonElement>(`[data-settings-drill="${id}"]`)
  setSettingsAccountPage({
    attach(next, mode, accountId) {
      if (!form || !fallback) return () => {}
      host = next
      hostMode = mode
      next.append(form)
      form.dataset.page = mode
      const fromLink = !requested
      requested = false
      if (fromLink)
        queueMicrotask(() => {
          if (host === next) onEnter(mode, accountId)
        })
      return () => {
        if (host !== next) return
        host = undefined
        hostMode = undefined
        fallback.append(form)
        delete form.dataset.page
        const ours = closing
        closing = false
        if (!ours)
          queueMicrotask(() => {
            // React is still committing the departing page here. Only its living parent may
            // discard the draft, and a newly attached page owns its own interaction by then.
            if (!host && settings.isConnected && fallback.isConnected) onLeave()
          })
      }
    },
  })
  return {
    /** Open the account page; false when this dialog has none and the fallback dialog is used. */
    open(adding: boolean, accountId?: string): boolean {
      const mode = adding ? 'add' : 'edit'
      const target = row(adding ? ACCOUNT_PAGE_IDS.add : ACCOUNT_PAGE_IDS.edit)
      if (!target) return false
      const url = new URL(location.href)
      if (!adding && accountId) url.searchParams.set('account', accountId)
      else url.searchParams.delete('account')
      history.replaceState(history.state, '', preserveRouteParams(url))
      // Closed a moment ago and opened again before it went away: it simply stays open.
      const reopening = closing && hostMode === mode
      if (reopening) closing = false
      if (reopening || closing || target.getAttribute('aria-expanded') !== 'true') {
        requested = true
        target.click()
      }
      return true
    },
    /** Leave the account page if it is open; false when the form is in the fallback dialog. */
    leave(): boolean {
      if (!host || closing) return !!host
      closing = true
      host.dispatchEvent(new CustomEvent(SUBPAGE_CLOSE_EVENT, { bubbles: true }))
      return true
    },
  }
}

/** Restore a linked account only while the same address still owns the surface. */
export function linkedAccountRestorer(
  dialog: HTMLDialogElement,
  open: () => Promise<void>,
  accounts: () => readonly ConfigAccount[] | undefined,
  edit: (id?: string) => void,
) {
  const restore = (mode: 'add' | 'edit', accountId?: string | null) => {
    if (!dialog.isConnected) return
    const address = location.href
    void open().then(() => {
      if (!dialog.isConnected || !dialog.open || location.href !== address) return
      const id = mode === 'edit' ? accountId : undefined
      if (id && !accounts()?.some((account) => account.accountId === id)) return
      edit(id ?? undefined)
    })
  }
  return Object.assign(restore, {
    async openRoute(route?: string) {
      await open()
      if (!dialog.isConnected || !dialog.open) return
      const account = accounts()?.find((row) => row.route === route)
      if (account) edit(account.accountId)
    },
  })
}

export function showAccountDiscard(show: boolean): void {
  const prompt = optionalElement('config-account-discard', 'div')
  const actions = optionalElement('config-account-footer-actions', 'div')
  if (prompt) prompt.hidden = !show
  if (actions) actions.hidden = show
  if (show) optionalElement('config-account-keep', 'button')?.focus()
}
