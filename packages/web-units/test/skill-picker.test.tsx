/** @vitest-environment happy-dom */
import { SettingsTextArea } from '@agnes/web-ui'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerLocaleCatalog } from '../src/locales/composer.js'
import { SkillPicker, type ComposerSkills } from '../src/skill-picker.js'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

it('filters installed skills and inserts a selected explicit mention without submitting', async () => {
  const textarea = createRef<HTMLTextAreaElement>()
  const submit = vi.fn()
  const skills: ComposerSkills = {
    list: vi.fn(async () => [
      { name: 'review-notes', description: 'Review project notes' },
      { name: 'write-tests', description: 'Add focused tests' },
    ]),
  }
  const edit = vi.fn((start: number, end: number, text: string) =>
    textarea.current?.setRangeText(text, start, end, 'end'),
  )
  await act(async () =>
    root.render(
      createElement(
        'form',
        { onSubmit: submit },
        createElement(SkillPicker, {
          textarea,
          edit,
          skills,
          t: (key) => composerLocaleCatalog.en[key] ?? key,
          disabled: false,
        }),
        createElement(SettingsTextArea, { ref: textarea }),
      ),
    ),
  )
  const input = textarea.current
  if (!input) throw new Error('Missing textarea')
  await act(async () => {
    input.value = '$review'
    input.setSelectionRange(input.value.length, input.value.length)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="skill-option"]')).toHaveLength(1))
  expect(host.querySelector('[data-testid="skill-option"]')?.textContent).toContain('review-notes')
  expect(host.querySelector('[data-testid="skill-option"]')?.textContent).not.toContain('$review-notes')
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  await act(async () => input.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
  expect(edit).toHaveBeenLastCalledWith(0, '$review'.length, '$review-notes  ')
  expect(input.value).toBe('$review-notes  ')
  expect(submit).not.toHaveBeenCalled()
})

it('inserts a clicked skill into the current draft token', async () => {
  const textarea = createRef<HTMLTextAreaElement>()
  const edit = vi.fn((start: number, end: number, text: string) =>
    textarea.current?.setRangeText(text, start, end, 'end'),
  )
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement(SkillPicker, {
          textarea,
          edit,
          skills: { list: async () => [{ name: 'review-notes', description: 'Review project notes' }] },
          t: (key) => composerLocaleCatalog.en[key] ?? key,
          disabled: false,
        }),
        createElement(SettingsTextArea, { ref: textarea }),
      ),
    ),
  )
  const input = textarea.current
  if (!input) throw new Error('Missing textarea')
  await act(async () => {
    input.value = 'Please use $'
    input.setSelectionRange(input.value.length, input.value.length)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[data-testid="skill-option"]')).toBeTruthy())
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="skill-option"]')?.click())
  expect(edit).toHaveBeenLastCalledWith('Please use '.length, 'Please use $'.length, ' $review-notes  ')
  expect(input.value).toBe('Please use  $review-notes  ')
})
