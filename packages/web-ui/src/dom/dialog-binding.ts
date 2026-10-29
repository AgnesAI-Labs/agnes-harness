/** Keep modal cancellation keyboard-accessible while its caller owns pending-state policy. */
export function bindDismissibleDialog(options: {
  dialog: HTMLDialogElement
  cancel: HTMLButtonElement
  additional: NodeListOf<HTMLButtonElement>
  canClose(): boolean
  close(): void
  restoreFocus(): void
}): void {
  const dismiss = (): void => {
    if (!options.canClose()) return
    options.close()
    options.restoreFocus()
  }
  options.cancel.addEventListener('click', dismiss)
  for (const control of options.additional) control.addEventListener('click', dismiss)
  options.dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    dismiss()
  })
  // Clicking the backdrop closes: a click on dialog itself, rather than its contents, is a backdrop click.
  options.dialog.addEventListener('click', (event) => {
    if (event.target === options.dialog) dismiss()
  })
}

/**
 * Close expanded details on outside clicks.
 *
 * Inline details (session and per-call usage) previously closed only on another title click, unlike dialogs.
 * The panel is a descendant of details, so checking whether the path includes details is sufficient.
 *
 * Turn process blocks are **excluded**: the projector opens them every frame while running, so an outside
 * click would be undone on the next frame, causing flicker and affecting too much. Web only toggles them
 * on summary clicks and does not register this mechanism (packages/web-conversation/src/turns.ts).
 *
 * Use **one document-level delegated listener**, not per-element listeners: details are repeatedly created
 * (two per turn), and removing an open element (switching sessions, starting one, replacing an entry) does
 * not fire `toggle`. Per-element listeners would remain on document forever and retain the detached subtree.
 * Delegation handles removal naturally: removed elements are absent from `document.querySelectorAll`.
 *
 * Registration is idempotent; callers need not and cannot dispose it.
 */
const autoDismiss = new WeakSet<HTMLDetailsElement>()
let listening = false

export function bindAutoDismissDisclosure(details: HTMLDetailsElement): void {
  autoDismiss.add(details)
  if (listening) return
  listening = true
  document.addEventListener('click', (event) => {
    for (const open of document.querySelectorAll<HTMLDetailsElement>('details[open]')) {
      if (!autoDismiss.has(open)) continue
      if (event.composedPath().includes(open)) continue
      open.open = false
    }
  })
}
