import { ACCOUNT_PAGE_IDS, SUBPAGE_CLOSE_EVENT, setSettingsAccountPage } from '@agnes/web-ui'

/**
 * The account form as a page of the settings dialog. Adding opens 「添加账户」 and editing opens the
 * account's page, each borrowing the one form the controller owns; leaving the page gives the form
 * back to its fallback dialog. Leaving by 返回 or the browser drops the draft (`onLeave`); a close
 * the controller asked for (a save, 取消) has already done that and is not repeated.
 */
export function bindAccountPage(
  settings: HTMLElement,
  form: HTMLElement | null | undefined,
  fallback: HTMLDialogElement | null | undefined,
  onLeave: () => void,
  /** The add page was opened from outside the controller (a link): start a new account there. */
  onEnter: () => void,
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
    attach(next, mode) {
      if (!form || !fallback) return () => {}
      host = next
      hostMode = mode
      next.append(form)
      form.dataset.page = mode
      const fromLink = !requested
      requested = false
      if (fromLink && mode === 'add') queueMicrotask(onEnter)
      return () => {
        if (host !== next) return
        host = undefined
        hostMode = undefined
        fallback.append(form)
        delete form.dataset.page
        const ours = closing
        closing = false
        if (!ours) onLeave()
      }
    },
  })
  return {
    /** Open the account page; false when this dialog has none and the fallback dialog is used. */
    open(adding: boolean): boolean {
      const mode = adding ? 'add' : 'edit'
      const target = row(adding ? ACCOUNT_PAGE_IDS.add : ACCOUNT_PAGE_IDS.edit)
      if (!target) return false
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
