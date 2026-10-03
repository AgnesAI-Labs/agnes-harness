/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocaleTranslator } from '../src/locale-bridge.js'
import { createModelPicker, type ModelPickerOption, type ModelPickerState } from '../src/model-picker.js'
import { zhT } from './helpers/locale.js'

setLocaleTranslator(zhT)

const models: readonly ModelPickerOption[] = [
  { route: 'openai', id: 'gpt-5.6' },
  { route: 'local', id: 'local-model' },
  { route: 'deepseek', id: 'deepseek-v4-pro' },
]

function state(overrides: Partial<ModelPickerState> = {}): ModelPickerState {
  return {
    accessibleName: '选择当前会话模型',
    disabled: false,
    label: '选择模型',
    options: models,
    pending: false,
    ...overrides,
  }
}

function mountPicker(onSelect: (option: ModelPickerOption) => Promise<boolean> = vi.fn(async () => true)) {
  const trigger = document.createElement('button')
  trigger.innerHTML = '<span data-model-label></span>'
  document.body.append(trigger)
  const picker = createModelPicker({ trigger, onSelect, onError: vi.fn() })
  picker.render(state())
  return { picker, trigger, onSelect }
}

function listbox(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-listbox')
  if (!found) throw new Error('model picker did not open')
  return found
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('model picker', () => {
  it('opens one flat model list and selects an option', async () => {
    const { picker, trigger, onSelect } = mountPicker()
    trigger.click()

    expect(listbox().getAttribute('aria-label')).toBe('可用模型')
    expect(listbox().querySelectorAll('[role="option"]')).toHaveLength(3)
    expect(document.querySelector('.model-picker-entry, #model-submenu-listbox')).toBeNull()

    listbox().querySelectorAll<HTMLElement>('[role="option"]')[1]?.click()
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(models[1]))
    await vi.waitFor(() => expect(document.querySelector('#model-listbox')).toBeNull())
    picker.destroy()
  })

  it('supports keyboard navigation and restores focus when closed', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const { picker, trigger } = mountPicker()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))

    expect(listbox().getAttribute('aria-activedescendant')).toBe('model-picker-option-2')
    listbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('#model-listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    picker.destroy()
  })

  it('keeps the current selection when a model change fails', async () => {
    const failure = new Error('model switch failed')
    const onError = vi.fn()
    const trigger = document.createElement('button')
    trigger.innerHTML = '<span data-model-label></span>'
    document.body.append(trigger)
    const picker = createModelPicker({
      trigger,
      onSelect: vi.fn(async () => {
        throw failure
      }),
      onError,
    })
    const selectedModel = models[0]
    if (!selectedModel) throw new Error('missing selected model fixture')
    picker.render(state({ selected: selectedModel, label: selectedModel.id }))
    trigger.click()
    listbox().querySelectorAll<HTMLElement>('[role="option"]')[1]?.click()

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(trigger.textContent).toContain(models[0]?.id)
    expect(listbox()).toBeInstanceOf(HTMLElement)
    picker.destroy()
  })

  it('closes when the picker becomes unavailable', () => {
    const { picker, trigger } = mountPicker()
    trigger.click()
    picker.render(state({ disabled: true }))
    expect(document.querySelector('#model-listbox')).toBeNull()
    expect(trigger.disabled).toBe(true)
    picker.destroy()
  })
})
