import { fallbackT } from '../locales/index.js'

/** Add narrow-screen handles without replacing native hosts or their cancellation policy. */
export function bindDialogSheets(document: Document): () => void {
  const view = document.defaultView
  if (!view) return () => {}
  const handles = new Map<HTMLButtonElement, () => void>()
  const addHandles = () => {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) {
      if (dialog.matches('.agh-drawer, .lightbox') || dialog.querySelector(':scope > .agh-sheet-handle'))
        continue
      const handle = document.createElement('button')
      handle.type = 'button'
      handle.className = 'agh-sheet-handle agh-native-sheet-handle'
      handle.setAttribute('aria-label', fallbackT('ui.close'))
      const grip = document.createElement('span')
      grip.setAttribute('aria-hidden', 'true')
      handle.append(grip)
      let start: number | undefined
      let dragged = false
      const events = new view.AbortController()
      const remove = () => {
        events.abort()
        handle.remove()
        handles.delete(handle)
      }
      const dismiss = () => {
        // requestClose emits cancel before closing, including pending-state vetoes and focus return.
        if (typeof dialog.requestClose === 'function') dialog.requestClose()
        else if (dialog.dispatchEvent(new view.Event('cancel', { cancelable: true }))) dialog.close()
      }
      const options = { signal: events.signal }
      dialog.addEventListener(
        'close',
        () => {
          remove()
          if (dialog.open) addHandles()
        },
        { ...options, once: true },
      )
      handle.addEventListener(
        'pointerdown',
        (event) => {
          start = event.clientY
          dragged = false
          handle.setPointerCapture?.(event.pointerId)
        },
        options,
      )
      handle.addEventListener(
        'pointerup',
        (event) => {
          if (start !== undefined && event.clientY - start >= 80) {
            dragged = true
            dismiss()
          }
          start = undefined
        },
        options,
      )
      handle.addEventListener(
        'pointercancel',
        () => {
          start = undefined
        },
        options,
      )
      handle.addEventListener(
        'click',
        (event) => {
          if (!dragged || event.detail === 0) dismiss()
          dragged = false
        },
        options,
      )
      // Inserting after showModal leaves its original autofocus target intact.
      dialog.prepend(handle)
      handles.set(handle, remove)
    }
  }
  const observer = new view.MutationObserver(() => {
    for (const [handle, remove] of handles) if (!handle.isConnected) remove()
    addHandles()
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
  })
  const language = new view.MutationObserver(() => {
    for (const handle of handles.keys()) handle.setAttribute('aria-label', fallbackT('ui.close'))
  })
  language.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  addHandles()
  return () => {
    observer.disconnect()
    language.disconnect()
    for (const remove of handles.values()) remove()
  }
}
