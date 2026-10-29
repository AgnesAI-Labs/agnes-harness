import { useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { SheetHandle } from './sheet-handle.js'

const HOSTS = 'dialog[open]'
// A host shown as a page is not a sheet: it sits in its page and leaves through the page's Back.
const SKIPPED = '.agh-drawer, .lightbox, [role=presentation], [data-presentation="page"]'

type Sheet = { dialog: HTMLDialogElement; key: number }

/**
 * Gives every open native dialog the same narrow-screen close handle the Dialog primitive draws for
 * itself. The dialogs keep their ids and controllers; the handle is portalled into each one after it
 * opens (so its autofocus target is untouched) and dismisses through the dialog's own cancel path,
 * which is where a busy dialog refuses to close.
 */
export function NativeSheetHandles({ owner }: { owner: Document }) {
  const [sheets, setSheets] = useState<readonly Sheet[]>([])
  // The close label is read at render time, so a language change only needs another render.
  const [, setLanguage] = useState(0)
  const nodes = useRef(new Map<HTMLDialogElement, HTMLButtonElement>())
  const next = useRef(0)
  useEffect(() => {
    const view = owner.defaultView
    if (!view) return
    const collect = () => {
      // Another renderer may have replaced a dialog's children; the handle is put back, not rebuilt.
      for (const [dialog, node] of nodes.current) if (dialog.open && !node.isConnected) dialog.append(node)
      const open = [...owner.querySelectorAll<HTMLDialogElement>(HOSTS)].filter(
        (dialog) => !dialog.matches(SKIPPED),
      )
      setSheets((current) => {
        const kept = current.filter((sheet) => open.includes(sheet.dialog))
        const added = open
          .filter((dialog) => !kept.some((sheet) => sheet.dialog === dialog))
          .map((dialog) => ({ dialog, key: next.current++ }))
        return added.length || kept.length !== current.length ? [...kept, ...added] : current
      })
    }
    // A dialog that closes and reopens gets a fresh handle, with no gesture left half-finished.
    const closed = (event: Event) => {
      const dialog = event.target
      // Synchronously, so the old handle is gone before anything else reacts to the close.
      flushSync(() =>
        setSheets((current) =>
          current.map((sheet) =>
            sheet.dialog === dialog ? { dialog: sheet.dialog, key: next.current++ } : sheet,
          ),
        ),
      )
    }
    const observer = new view.MutationObserver(collect)
    observer.observe(owner.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    })
    const language = new view.MutationObserver(() => setLanguage((value) => value + 1))
    language.observe(owner.documentElement, { attributes: true, attributeFilter: ['lang'] })
    owner.addEventListener('close', closed, true)
    collect()
    return () => {
      observer.disconnect()
      language.disconnect()
      owner.removeEventListener('close', closed, true)
    }
  }, [owner])
  return (
    <>
      {sheets.map(({ dialog, key }) =>
        createPortal(
          <SheetHandle
            native
            ref={(node) => {
              if (node) nodes.current.set(dialog, node)
              else nodes.current.delete(dialog)
            }}
            onDismiss={() => {
              // requestClose emits cancel before closing, including pending-state vetoes and focus return.
              if (typeof dialog.requestClose === 'function') dialog.requestClose()
              else if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close()
            }}
          />,
          dialog,
          String(key),
        ),
      )}
    </>
  )
}
