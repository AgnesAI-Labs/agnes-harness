import type { PackageAdminError, PackageOperation } from '@agnes/protocol'
import { settingsSections } from '@agnes/web-client'
import { isPageDialog, showDialogHost } from '@agnes/web-ui'

export function element<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const found = document.getElementById(id)
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return found as HTMLElementTagNameMap[K]
}

export function button(id: string): HTMLButtonElement {
  return element(id, 'button')
}

export function setDialog(dialog: HTMLDialogElement, open: boolean, focus?: HTMLElement): void {
  if (open) {
    // A confirmation sits over the page it asks about; a page replaces another page.
    const page = isPageDialog(dialog)
    for (const other of document.querySelectorAll('dialog[open]')) {
      if (other === dialog) continue
      // The settings dialog is the page these dialogs belong to: closing it left the user with
      // nothing on screen after every source check, confirmation or detail view.
      if (other.id === 'config') continue
      if (other instanceof HTMLDialogElement && isPageDialog(other) !== page) continue
      try {
        if (other instanceof HTMLDialogElement && other.open) other.close()
        else other.removeAttribute('open')
      } catch {
        other.removeAttribute('open')
      }
    }
  }
  if (open) showDialogHost(dialog)
  if (!open && dialog.open) {
    try {
      dialog.close()
    } catch {
      dialog.removeAttribute('open')
    }
  }
  if (open) focus?.focus()
}

const ERROR_KEYS: Readonly<Record<string, string>> = {
  ADMIN_UNAVAILABLE: 'error.connection',
  RECOVERY_READ_ONLY: 'error.read-only',
  ADMIN_FORBIDDEN: 'error.forbidden',
  FORBIDDEN: 'error.forbidden',
  PACKAGE_BUSY: 'error.busy',
  ADMIN_CONTEXT_INVALID: 'error.context-invalid',
  ADMIN_RESPONSE_INVALID: 'error.response-invalid',
  RUNTIME_NOT_CONFIRMED: 'notice.runtime-pending',
  RUNTIME_IDENTITY_UNKNOWN: 'error.runtime-unconfirmed',
  E_PACKAGE_TRUST: 'error.capability-unconfirmed',
  E_PACKAGE_STATE: 'error.state-changed',
  E_PACKAGE_BLOCKED: 'error.blocked',
  E_PACKAGE_SOURCE: 'error.source-rejected',
}
/** The locale key that explains an admin failure code. */
export const adminErrorKey = (
  code: string,
  operation?: PackageOperation['operation'],
  sourceFailure?: PackageAdminError['sourceFailure'],
): string =>
  code === 'E_PACKAGE_SOURCE' && sourceFailure
    ? `error.source.${sourceFailure}`
    : code === 'E_PACKAGE_STATE' && operation === 'remove'
      ? 'error.remove-state'
      : code === 'E_PACKAGE_BLOCKED' && operation === 'remove'
        ? 'error.remove-blocked'
        : (ERROR_KEYS[code] ?? 'error.operation-failed')

/** The embedded settings shell marks the runtime page its navigation is on. */
export function markSettingsPage(page: string, listHost: HTMLElement): void {
  const shell = document.getElementById('config-form')
  if (!shell) return
  shell.dataset.runtimePage = page
  shell.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: page, bubbles: true }))
  for (const item of shell.querySelectorAll<HTMLElement>('[data-runtime-page]')) {
    const active =
      item.dataset.runtimePage === page ||
      settingsSections.get(item.dataset.runtimePage ?? '')?.group === settingsSections.get(page)?.group
    item.classList.toggle('active', active)
    if (active) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  }
  listHost
    .closest('.settings-content')
    ?.querySelector<HTMLElement>('.config-heading')
    ?.setAttribute('hidden', '')
}
