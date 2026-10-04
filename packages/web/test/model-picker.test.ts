/** @vitest-environment happy-dom */
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelPicker, type ModelPickerOption, type ModelPickerState } from '../src/model-picker.js'
import { zhT } from './helpers/locale.js'

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
  const picker = createModelPicker({ trigger, onSelect, onError: vi.fn(), t: zhT })
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
      t: zhT,
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

  it('opens in the trigger document and removes its listeners there on destroy', () => {
    const other = new Window()
    const doc = other.document as unknown as Document
    const targets = [doc, other as unknown as Window]
    const added = targets.map((target) => vi.spyOn(target, 'addEventListener'))
    const removed = targets.map((target) => vi.spyOn(target, 'removeEventListener'))
    const globalAdded = [vi.spyOn(document, 'addEventListener'), vi.spyOn(window, 'addEventListener')]
    try {
      const trigger = doc.createElement('button')
      trigger.innerHTML = '<span data-model-label></span>'
      doc.body.append(trigger)
      const picker = createModelPicker({
        trigger,
        onSelect: vi.fn(async () => true),
        onError: vi.fn(),
        t: zhT,
      })
      // Only the listeners attached while binding belong to the picker; React adds its own on open.
      const bound = added.map((spy) => [...spy.mock.calls])
      expect(bound.flat().length).toBeGreaterThan(0)
      picker.render(state())

      trigger.click()
      expect(doc.querySelector('#model-picker-popover')?.parentElement).toBe(doc.body)
      expect(doc.querySelector('#model-listbox')?.getAttribute('aria-label')).toBe('可用模型')
      expect(document.querySelector('#model-picker-popover')).toBeNull()
      doc.body.dispatchEvent(new other.MouseEvent('click', { bubbles: true }) as unknown as Event)
      expect(doc.querySelector('#model-picker-popover')).toBeNull()

      trigger.click()
      picker.destroy()
      expect(doc.querySelector('#model-picker-popover')).toBeNull()
      bound.forEach((calls, index) => {
        expect(removed[index]?.mock.calls).toEqual(expect.arrayContaining(calls))
      })
      for (const spy of globalAdded) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of [...added, ...removed, ...globalAdded]) spy.mockRestore()
      void other.happyDOM.close()
    }
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
