/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelPicker, type ModelPickerOption, type ModelPickerState } from '../src/model-picker.js'

const models: readonly ModelPickerOption[] = [
  { route: 'openai', id: 'gpt-5.6' },
  { route: 'local', id: 'a-model-with-a-long-name-that-may-wrap-in-a-narrow-viewport' },
  { route: 'deepseek', id: 'deepseek-v4-pro' },
]
const [firstModel, secondModel] = models as readonly [ModelPickerOption, ModelPickerOption, ModelPickerOption]

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

function installTrigger(): HTMLButtonElement {
  const trigger = document.createElement('button')
  trigger.id = 'model'
  trigger.type = 'button'
  trigger.innerHTML = '<span data-model-label>选择模型</span><span aria-hidden="true">⌄</span>'
  document.body.append(trigger)
  return trigger
}

function listbox(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="listbox"]')
  if (!found) throw new Error('model picker did not open')
  return found
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('model picker', () => {
  it('brings a confirmed item at the end of a long list into view and closes when unavailable', () => {
    const trigger = installTrigger()
    const directory = Array.from({ length: 50 }, (_, index) => ({ route: 'local', id: `model-${index}` }))
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const onSelect = vi.fn(async () => true)
    const picker = createModelPicker({ trigger, onSelect, onError: vi.fn() })
    const last = directory[49]
    if (!last) throw new Error('missing final fixture model')
    picker.render(state({ options: directory, selected: last }))
    trigger.click()
    const selected = listbox().querySelector('[aria-selected="true"]')
    expect(listbox().getAttribute('aria-activedescendant')).toBe(selected?.id)
    expect(scroll.mock.contexts).toContain(selected)
    picker.render(state({ options: directory, disabled: true }))
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(trigger.disabled).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
    picker.destroy()
    scroll.mockRestore()
  })

  it('uses the trigger and listbox roles without a placeholder option, and keeps the picker keyboard reachable', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const trigger = installTrigger()
    const onSelect = vi.fn(async () => true)
    const picker = createModelPicker({ trigger, onSelect, onError: vi.fn() })
    picker.render(state())

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

    const options = Array.from(listbox().querySelectorAll<HTMLElement>('[role="option"]'))
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(options).toHaveLength(models.length)
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false'])
    expect(options.map((option) => option.textContent)).not.toContain('选择模型')
    expect(listbox().textContent).toContain('已配置账户')
    expect(listbox().textContent).not.toContain('openai')
    expect(listbox().textContent).not.toContain('local')
    expect(document.activeElement).toBe(listbox())

    listbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(listbox().getAttribute('aria-activedescendant')).toBe('model-picker-option-2')
    listbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(listbox().getAttribute('aria-activedescendant')).toBe('model-picker-option-0')
    listbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(onSelect).not.toHaveBeenCalled()
    picker.destroy()
  })

  it('closes on outside click and restores the trigger before Tab leaves the listbox', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const trigger = installTrigger()
    const outside = document.createElement('button')
    document.body.append(outside)
    const onSelect = vi.fn(async () => true)
    const picker = createModelPicker({ trigger, onSelect, onError: vi.fn() })
    picker.render(state())

    trigger.click()
    outside.click()
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()

    trigger.click()
    listbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    picker.destroy()
  })

  it('keeps the last confirmed model on failure and does not let a pending render invalidate selection', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const failure = new Error('model switch failed')
    const onError = vi.fn()
    const failedSelect = vi.fn(async () => {
      throw failure
    })
    const retryTrigger = installTrigger()
    const retryPicker = createModelPicker({ trigger: retryTrigger, onSelect: failedSelect, onError })
    retryPicker.render(state({ selected: firstModel, label: firstModel.id }))
    retryTrigger.click()
    listbox().querySelectorAll<HTMLElement>('[role="option"]')[1]?.click()
    await vi.waitFor(() => expect(failedSelect).toHaveBeenCalledWith(secondModel))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(retryTrigger.textContent).toContain(firstModel.id)
    expect(listbox().querySelector('[aria-selected="true"]')?.textContent).toContain(firstModel.id)
    retryPicker.destroy()

    const pendingTrigger = installTrigger()
    let resolve!: (accepted: boolean) => void
    const pending = new Promise<boolean>((complete) => {
      resolve = complete
    })
    const pendingPicker = createModelPicker({
      trigger: pendingTrigger,
      onSelect: vi.fn(() => pending),
      onError: vi.fn(),
    })
    pendingPicker.render(state())
    pendingTrigger.click()
    listbox().querySelectorAll<HTMLElement>('[role="option"]')[1]?.click()
    pendingPicker.render(state({ pending: true }))
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    expect(pendingTrigger.disabled).toBe(true)
    pendingPicker.render(state({ selected: secondModel, label: secondModel.id, pending: false }))
    resolve(true)

    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull())
    expect(pendingTrigger.textContent).toContain(secondModel.id)
    pendingPicker.destroy()
  })

  it('clamps a 320px viewport before positioning the popover', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('innerWidth', 320)
    vi.stubGlobal('innerHeight', 568)
    const trigger = installTrigger()
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 260,
      y: 500,
      width: 48,
      height: 32,
      top: 500,
      right: 308,
      bottom: 532,
      left: 260,
      toJSON: () => ({}),
    })
    const picker = createModelPicker({ trigger, onSelect: vi.fn(async () => true), onError: vi.fn() })
    picker.render(state())
    trigger.click()

    const popover = document.getElementById('model-picker-popover') as HTMLElement
    expect(popover.style.width).toBe('296px')
    expect(popover.style.left).toBe('12px')
    expect(popover.dataset.placement).toBe('above')
    picker.destroy()
  })
})
