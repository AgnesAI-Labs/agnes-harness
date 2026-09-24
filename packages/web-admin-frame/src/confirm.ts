/**
 * Shared confirmation dialog for the admin surfaces.
 *
 * The two panes used to ask differently: the plugin page opened a styled dialog while the Skill /
 * MCP page called the browser's `window.confirm`, which cannot show structured facts and cannot be
 * themed. This controller owns the dialog mechanics only; the caller owns the decision and whatever
 * runs after it.
 */
export type ConfirmRequest = Readonly<{
  title: string
  description: string
  confirmLabel?: string
  /** Optional structured preview rendered above the actions. */
  renderFacts?: (parent: HTMLElement) => void
  /** Return false to keep the dialog open while a caller-owned operation is in flight. */
  canClose?: () => boolean
}>

export type ConfirmController = Readonly<{
  /** Resolves true only when the user confirms; false on cancel, Escape or a backdrop click. */
  ask(request: ConfirmRequest): Promise<boolean>
  /** Disables both actions, e.g. while the confirmed operation is submitted. */
  busy(value: boolean): void
}>

function lookup<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const node = document.getElementById(id)
  if (!node || node.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return node as HTMLElementTagNameMap[K]
}

export function createConfirmController(): ConfirmController {
  const dialog = lookup('admin-confirm', 'dialog')
  const title = lookup('admin-confirm-title', 'h2')
  const description = lookup('admin-confirm-description', 'p')
  const facts = lookup('admin-confirm-preview', 'div')
  const cancel = lookup('admin-confirm-cancel', 'button')
  const action = lookup('admin-confirm-action', 'button')
  let settle: ((confirmed: boolean) => void) | undefined
  let canClose: (() => boolean) | undefined
  let trigger: HTMLElement | undefined

  const finish = (confirmed: boolean): void => {
    const resolve = settle
    settle = undefined
    canClose = undefined
    if (dialog.open) dialog.close()
    action.disabled = false
    cancel.disabled = false
    trigger?.focus({ preventScroll: true })
    trigger = undefined
    resolve?.(confirmed)
  }
  const dismiss = (): void => {
    if (!settle) return
    if (canClose?.() === false) return
    finish(false)
  }

  cancel.addEventListener('click', dismiss)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    dismiss()
  })
  // A click landing on the dialog element itself is the backdrop.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dismiss()
  })
  action.addEventListener('click', () => finish(true))

  return {
    ask(request) {
      if (settle) throw new Error('confirm dialog is already open')
      canClose = request.canClose
      trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      title.textContent = request.title
      description.textContent = request.description
      action.textContent = request.confirmLabel ?? '确认'
      facts.replaceChildren()
      facts.hidden = !request.renderFacts
      request.renderFacts?.(facts)
      dialog.showModal()
      action.focus()
      return new Promise<boolean>((resolve) => {
        settle = resolve
      })
    },
    busy(value) {
      action.disabled = value
      cancel.disabled = value
    },
  }
}
