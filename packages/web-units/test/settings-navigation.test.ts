/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { revealSettingsAnchor } from '../src/settings-navigation.js'

afterEach(() => document.body.replaceChildren())

it('opens an in-place row and focuses its toggle when a deep link points at it', () => {
  const row = document.createElement('section')
  row.id = 'settings-subsection-closing-instructions'
  row.dataset.settingsExpand = ''
  const toggle = document.createElement('button')
  toggle.setAttribute('aria-expanded', 'false')
  toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', 'true'))
  row.append(toggle)
  const scrollIntoView = vi.fn()
  row.scrollIntoView = scrollIntoView
  document.body.append(row)
  revealSettingsAnchor(row.id)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  expect(document.activeElement).toBe(toggle)
  // A second reveal keeps the open row quiet instead of collapsing it again.
  revealSettingsAnchor(row.id)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
})
