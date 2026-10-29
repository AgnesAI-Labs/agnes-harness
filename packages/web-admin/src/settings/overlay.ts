import { releaseDialogModal } from '@agnes/web-ui'
import { useLayoutEffect } from 'react'
/** The detail dialog owns modal focus; the settings list remains visible behind it. */
export function useSettingsOverlay(open: boolean) {
  useLayoutEffect(() => {
    if (!open) return
    return releaseDialogModal(document.querySelector<HTMLDialogElement>('dialog#config'))
  }, [open])
}
