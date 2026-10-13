/** @vitest-environment happy-dom */
import { expect, it } from 'vitest'
import { INPUT_MODALITY_ATTRIBUTE, trackInputModality } from '../src/input-modality.js'

it('follows the last action: pointer hides the focus ring, a real key brings it back', () => {
  const root = document.documentElement
  const stop = trackInputModality(document)
  expect(root.hasAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe(false)
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('pointer')
  // Holding a modifier while clicking is not keyboard navigation.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
  expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('pointer')
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('keyboard')
  stop()
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(root.getAttribute(INPUT_MODALITY_ATTRIBUTE)).toBe('keyboard')
  root.removeAttribute(INPUT_MODALITY_ATTRIBUTE)
})
