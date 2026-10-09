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
    for (const other of document.querySelectorAll('dialog[open]')) {
      if (other === dialog) continue
      // The settings dialog is the page these dialogs belong to: closing it left the user with
      // nothing on screen after every source check, confirmation or detail view.
      if (other.id === 'config') continue
      try {
        if (other instanceof HTMLDialogElement && other.open) other.close()
        else other.removeAttribute('open')
      } catch {
        other.removeAttribute('open')
      }
    }
  }
  if (open && !dialog.open) {
    try {
      dialog.showModal()
    } catch {
      dialog.setAttribute('open', '')
    }
  }
  if (!open && dialog.open) {
    try {
      dialog.close()
    } catch {
      dialog.removeAttribute('open')
    }
  }
  if (open) focus?.focus()
}
