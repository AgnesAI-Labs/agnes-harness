import { createSettingsControl } from './settings-control-templates.js'

/**
 * Copy through a hidden textarea, for surfaces that must also work where the async Clipboard
 * API is unavailable or refused. The reader's selection and focus are restored afterwards.
 */
export function legacyCopy(text: string, doc: Document): boolean {
  const active = doc.activeElement as HTMLElement | null
  const selection = doc.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const textarea = createSettingsControl(doc, 'textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  doc.body.append(textarea)
  textarea.select()
  let copied = false
  try {
    copied = doc.execCommand('copy')
  } catch {
    copied = false
  } finally {
    textarea.remove()
    selection?.removeAllRanges()
    for (const range of ranges) selection?.addRange(range)
    active?.focus?.({ preventScroll: true })
  }
  return copied
}

/** Prefer the async Clipboard API, falling back to {@link legacyCopy} when it cannot be used. */
export function copyText(text: string, doc: Document): Promise<boolean> {
  const clipboard = doc.defaultView?.navigator.clipboard
  if (!clipboard?.writeText) return Promise.resolve(legacyCopy(text, doc))
  try {
    return Promise.resolve(clipboard.writeText(text)).then(
      () => true,
      () => legacyCopy(text, doc),
    )
  } catch {
    return Promise.resolve(legacyCopy(text, doc))
  }
}
