/** The attribute on the document element that says how the user last acted. */
export const INPUT_MODALITY_ATTRIBUTE = 'data-agnes-input'

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'])

/**
 * Record whether the last action came from the keyboard or a pointer, so the focus ring is drawn
 * for keyboard navigation only. `:focus-visible` alone is not enough: a control focused from
 * script after a click (a tab moved by its controller, a dialog shown again) can still match it.
 * Until the first action the attribute is absent and the ring follows `:focus-visible`.
 */
export function trackInputModality(target: Document): () => void {
  const root = target.documentElement
  const keyboard = (event: KeyboardEvent) => {
    // A modifier on its own accompanies a click as often as it starts a shortcut.
    if (!MODIFIER_KEYS.has(event.key)) root.setAttribute(INPUT_MODALITY_ATTRIBUTE, 'keyboard')
  }
  const pointer = () => root.setAttribute(INPUT_MODALITY_ATTRIBUTE, 'pointer')
  target.addEventListener('keydown', keyboard, true)
  target.addEventListener('pointerdown', pointer, true)
  return () => {
    target.removeEventListener('keydown', keyboard, true)
    target.removeEventListener('pointerdown', pointer, true)
  }
}
