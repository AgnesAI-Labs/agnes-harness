import { createElement } from 'react'
import { createRegionRenderer } from '../antd-root.js'
import { NativeSheetHandles } from '../ui/native-sheet-handles.js'

/** Add narrow-screen handles without replacing native hosts or their cancellation policy. */
export function bindDialogSheets(document: Document): () => void {
  if (!document.defaultView) return () => {}
  // The handles are portalled into the dialogs, so the renderer itself needs no place in the page.
  const renderer = createRegionRenderer(document.createDocumentFragment())
  renderer.render(createElement(NativeSheetHandles, { owner: document }))
  renderer.flush()
  let bound = true
  return () => {
    if (!bound) return
    bound = false
    renderer.unmount()
  }
}
