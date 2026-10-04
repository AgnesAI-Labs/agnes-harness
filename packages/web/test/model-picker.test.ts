/** @vitest-environment happy-dom */
import type { ModelSettings } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocaleTranslator } from '../src/locale-bridge.js'
import {
  createModelPicker,
  type ModelPickerOption,
  type ModelPickerSettings,
  type ModelPickerState,
} from '../src/model-picker.js'
import { zhT } from './helpers/locale.js'

setLocaleTranslator(zhT)

/** 第一行是会话当前使用的模型，它的设置就是 fixture 里的 `settings`。 */
const currentModel: ModelPickerOption = {
  route: 'openai',
  id: 'gpt-5.6',
  contextWindow: 128000,
  thinkingLevelMap: { low: 'low', high: 'high' },
}

const models: readonly ModelPickerOption[] = [
  currentModel,
  {
    route: 'local',
    id: 'local-model',
    contextWindow: 64000,
    thinkingLevelMap: { low: 'low', high: 'high' },
    defaultSettings: { thinking: 'high', contextWindow: 32000 },
  },
  { route: 'deepseek', id: 'deepseek-v4-pro', contextWindow: 64000 },
]

const settings: ModelPickerSettings = {
  thinking: 'low',
  contextWindow: 64000,
  capacity: 128000,
  thinkingLevelMap: { low: 'low', high: 'high' },
}

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

function mountPicker(
  onSelect: (option: ModelPickerOption) => Promise<boolean> = vi.fn(async () => true),
  onSettingsChange?: (next: ModelSettings) => Promise<boolean>,
  overrides: Partial<ModelPickerState> = {},
) {
  const trigger = document.createElement('button')
  trigger.innerHTML = '<span data-model-label></span>'
  document.body.append(trigger)
  const onError = vi.fn()
  const picker = createModelPicker({
    trigger,
    onSelect,
    onError,
    ...(onSettingsChange ? { onSettingsChange } : {}),
  })
  picker.render(state({ settings, selected: currentModel, ...overrides }))
  return { picker, trigger, onSelect, onError }
}

function modelList(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-listbox')
  if (!found) throw new Error('model picker did not open')
  return found
}

function modelRow(index: number): HTMLElement {
  const found = modelList().querySelectorAll<HTMLElement>('[role="option"]')[index]
  if (!found) throw new Error(`missing model row: ${index}`)
  return found
}

/** React 的 onMouseEnter 走 mouseover 合成，直接派发 mouseenter 不会触发。 */
function hoverRow(index: number): void {
  modelRow(index).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

function leavePanel(id: string): void {
  document.getElementById(id)?.dispatchEvent(new Event('mouseleave'))
}

function enterPanel(id: string): void {
  document.getElementById(id)?.dispatchEvent(new Event('mouseenter'))
}

function detail(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-settings-popover')
  if (!found) throw new Error('model detail did not open')
  return found
}

function detailRow(id: string): HTMLElement {
  const found = detail().querySelector<HTMLElement>(`#${id}`)
  if (!found) throw new Error(`missing detail row: ${id}`)
  return found
}

function detailValue(id: string): string {
  return detailRow(id).querySelector('.model-picker-detail-value')?.textContent ?? ''
}

function leaf(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-settings-options-popover')
  if (!found) throw new Error('parameter list did not open')
  return found
}

function leafOptions(): HTMLElement {
  const found = leaf().querySelector<HTMLElement>('[role="listbox"]')
  if (!found) throw new Error('parameter list has no listbox')
  return found
}

function leafOption(label: string): HTMLElement {
  const found = [...leafOptions().querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent === label || option.textContent?.startsWith(`${label} ·`),
  )
  if (!found) throw new Error(`missing option: ${label}`)
  return found
}

function leafLabels(): string[] {
  return [...leafOptions().querySelectorAll('[role="option"]')].map((option) => option.textContent ?? '')
}

function budget(): HTMLInputElement {
  const found = leaf().querySelector<HTMLInputElement>('#session-model-window')
  if (!found) throw new Error('custom budget field is missing')
  return found
}

/** React 在节点上装了 value 追踪器，直接赋值绕不过它；走原型上的原生 setter。 */
function typeBudget(value: string): void {
  const field = budget()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function press(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

/** 打开模型面板并悬停第一行，等详情子菜单出现。 */
async function hoverFirstModel(trigger: HTMLButtonElement): Promise<void> {
  trigger.click()
  hoverRow(0)
  await vi.waitFor(() => expect(document.getElementById('model-settings-popover')).not.toBeNull())
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('model picker', () => {
  it('opens one flat model list whose rows do not carry an entry menu', () => {
    const { picker, trigger } = mountPicker()
    trigger.click()

    expect(modelList().getAttribute('aria-label')).toBe('可用模型')
    expect(modelList().querySelectorAll('[role="option"]')).toHaveLength(3)
    expect(document.querySelector('.model-picker-entry, #model-submenu-listbox')).toBeNull()
    picker.destroy()
  })

  it('shows the session settings of the current model on hover, without switching', async () => {
    const { picker, trigger, onSelect } = mountPicker(
      undefined,
      vi.fn(async () => true),
    )
    await hoverFirstModel(trigger)

    expect(detail().textContent).toContain('gpt-5.6')
    expect(detailValue('model-detail-capacity')).toBe('128K')
    expect(detailRow('model-detail-thinking').textContent).toContain('低')
    expect(detailValue('model-detail-budget')).toBe('64K')
    expect(onSelect).not.toHaveBeenCalled()
    expect(modelList().querySelectorAll<HTMLElement>('[data-open="true"]')).toHaveLength(1)
    picker.destroy()
  })

  it('previews another model defaults when its row is hovered', async () => {
    const { picker, trigger, onSelect } = mountPicker(
      undefined,
      vi.fn(async () => true),
    )
    trigger.click()
    hoverRow(1)

    await vi.waitFor(() => expect(detail().textContent).toContain('local-model'))
    // 悬停只是预览：显示那个模型切换后会得到的默认值，模型本身还没变。
    expect(detailValue('model-detail-capacity')).toBe('64K')
    expect(detailRow('model-detail-thinking').textContent).toContain('高')
    expect(detailValue('model-detail-budget')).toBe('32K')
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-open="true"]')).toHaveLength(1)
    picker.destroy()
  })

  it('selects a model on click and keeps its settings open', async () => {
    const { picker, trigger, onSelect } = mountPicker(
      undefined,
      vi.fn(async () => true),
    )
    trigger.click()
    modelRow(1).click()

    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(models[1]))
    await vi.waitFor(() => expect(detail().textContent).toContain('local-model'))
    picker.destroy()
  })

  it('moves the open submenu with the keyboard highlight', async () => {
    const { picker, trigger } = mountPicker(
      undefined,
      vi.fn(async () => true),
    )
    await hoverFirstModel(trigger)
    press(modelList(), 'ArrowDown')

    await vi.waitFor(() => expect(detail().textContent).toContain('local-model'))
    expect(document.querySelectorAll('[data-open="true"]')).toHaveLength(1)
    picker.destroy()
  })

  it('hides the submenu when the pointer leaves it and keeps the model list', async () => {
    const { picker, trigger } = mountPicker(
      undefined,
      vi.fn(async () => true),
    )
    await hoverFirstModel(trigger)
    leavePanel('model-picker-popover')

    await vi.waitFor(() => expect(document.getElementById('model-settings-popover')).toBeNull())
    expect(document.getElementById('model-picker-popover')).not.toBeNull()
    picker.destroy()
  })

  it('keeps the submenu open while the pointer travels into it', async () => {
    const { picker, trigger } = mountPicker(
      undefined,
      vi.fn(async () => true),
    )
    await hoverFirstModel(trigger)
    leavePanel('model-picker-popover')
    enterPanel('model-settings-popover')

    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(document.getElementById('model-settings-popover')).not.toBeNull()
    picker.destroy()
  })

  it('lists the reasoning levels and applies one, then collapses the whole menu', async () => {
    const onSettingsChange = vi.fn(async () => true)
    const { picker, trigger } = mountPicker(undefined, onSettingsChange)
    await hoverFirstModel(trigger)
    detailRow('model-detail-thinking').click()

    expect(leafLabels()).toEqual(['自动（Provider 默认）', '低 · low', '高 · high'])
    expect(leafOption('低').getAttribute('aria-selected')).toBe('true')
    leafOption('高').click()

    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'high', contextWindow: 64000 }),
    )
    await vi.waitFor(() => expect(document.querySelector('#model-picker-popover')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    picker.destroy()
  })

  it('lists budget presets plus a custom field and applies a preset', async () => {
    const onSettingsChange = vi.fn(async () => true)
    const { picker, trigger } = mountPicker(undefined, onSettingsChange)
    await hoverFirstModel(trigger)
    detailRow('model-detail-budget').click()

    expect(leafLabels()).toEqual(['自动', '32K', '64K', '128K'])
    expect(leafOption('64K').getAttribute('aria-selected')).toBe('true')
    expect(budget().value).toBe('64000')
    leafOption('32K').click()

    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'low', contextWindow: 32000 }),
    )
    await vi.waitFor(() => expect(document.querySelector('#model-picker-popover')).toBeNull())
    picker.destroy()
  })

  it('switches to the hovered model before applying a value to it', async () => {
    const onSettingsChange = vi.fn(async () => true)
    const { picker, trigger, onSelect } = mountPicker(undefined, onSettingsChange)
    trigger.click()
    hoverRow(1)
    await vi.waitFor(() => expect(detail().textContent).toContain('local-model'))
    detailRow('model-detail-thinking').click()
    leafOption('低').click()

    // setModel 的落点是当前会话模型，所以先切过去，再按这个模型的值提交。
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(models[1]))
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'low', contextWindow: 32000 }),
    )
    picker.destroy()
  })

  it('does not cascade for a model that reports no capacity', async () => {
    const { picker, trigger, onSelect } = mountPicker(
      undefined,
      vi.fn(async () => true),
    )
    // 这一档模型没有容量，详情就没有可显示的值，面板退回纯模型列表。
    picker.render({
      accessibleName: '选择当前会话模型',
      disabled: false,
      label: '选择模型',
      options: [{ route: 'openai', id: 'fresh-model' }],
      pending: false,
      settings,
    })
    trigger.click()
    hoverRow(0)
    expect(document.getElementById('model-settings-popover')).toBeNull()

    // 点选仍然可用，只是没有详情可展开，按老行为切换后收起面板。
    modelRow(0).click()
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith({ route: 'openai', id: 'fresh-model' }))
    await vi.waitFor(() => expect(document.getElementById('model-picker-popover')).toBeNull())
    picker.destroy()
  })

  it('commits the custom budget on Enter or blur rather than on every keystroke', async () => {
    const onSettingsChange = vi.fn(async () => true)
    const { picker, trigger } = mountPicker(undefined, onSettingsChange)
    await hoverFirstModel(trigger)
    detailRow('model-detail-budget').click()
    typeBudget('96K')
    expect(onSettingsChange).not.toHaveBeenCalled()
    press(budget(), 'Enter')

    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'low', contextWindow: 96000 }),
    )
    await vi.waitFor(() => expect(document.querySelector('#model-picker-popover')).toBeNull())

    await hoverFirstModel(trigger)
    detailRow('model-detail-budget').click()
    typeBudget('80K')
    budget().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenLastCalledWith({ thinking: 'low', contextWindow: 80000 }),
    )
    picker.destroy()
  })

  it('refuses an out-of-range budget and marks the field invalid', async () => {
    const onSettingsChange = vi.fn(async () => true)
    const { picker, trigger } = mountPicker(undefined, onSettingsChange)
    await hoverFirstModel(trigger)
    detailRow('model-detail-budget').click()

    for (const invalid of ['100', '128001', 'abc']) {
      typeBudget(invalid)
      press(budget(), 'Enter')
      expect(budget().getAttribute('aria-invalid'), invalid).toBe('true')
      expect(document.getElementById('session-model-settings-error')?.textContent).toContain('正整数')
    }
    expect(onSettingsChange).not.toHaveBeenCalled()
    expect(document.getElementById('model-settings-options-popover')).not.toBeNull()
    picker.destroy()
  })

  it('keeps the menu and the typed value when a settings change fails', async () => {
    const failure = new Error('settings rejected')
    const { picker, trigger, onError } = mountPicker(
      undefined,
      vi.fn(async () => {
        throw failure
      }),
    )
    await hoverFirstModel(trigger)
    detailRow('model-detail-budget').click()
    typeBudget('96K')
    press(budget(), 'Enter')

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(budget().value).toBe('96K')
    expect(document.getElementById('model-picker-popover')).not.toBeNull()
    picker.destroy()
  })

  it('announces a saved level the model no longer declares', async () => {
    const { picker, trigger } = mountPicker(
      undefined,
      vi.fn(async () => true),
      {
        settings: {
          thinking: 'low',
          contextWindow: 64000,
          capacity: 128000,
          thinkingLevelMap: { high: 'high' },
        },
      },
    )
    await hoverFirstModel(trigger)

    const notice = detail().querySelector<HTMLElement>('.model-picker-notice')
    expect(notice?.hidden).toBe(false)
    expect(notice?.textContent).toContain('low')
    // 详情行右侧用短写法「自动」，完整说法只出现在第三级列表里。
    expect(detailValue('model-detail-thinking')).toBe('自动')
    picker.destroy()
  })

  it('walks the cascade with the arrow keys and backs out one level at a time', async () => {
    const onSettingsChange = vi.fn(async () => true)
    const { picker, trigger } = mountPicker(undefined, onSettingsChange)
    trigger.click()
    press(modelList(), 'ArrowRight')
    await vi.waitFor(() => expect(document.getElementById('model-settings-popover')).not.toBeNull())

    press(detailRow('model-detail-thinking'), 'ArrowRight')
    expect(document.getElementById('model-settings-options-popover')).not.toBeNull()
    press(leafOptions(), 'ArrowDown')
    press(leafOptions(), 'Enter')
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'high', contextWindow: 64000 }),
    )
    picker.destroy()
  })

  it('supports keyboard navigation in the model list and restores focus when closed', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const { picker, trigger } = mountPicker()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))

    expect(modelList().getAttribute('aria-activedescendant')).toBe('model-picker-option-2')
    modelList().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
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
    picker.render(state({ label: 'gpt-5.6', settings }))
    trigger.click()
    modelRow(1).click()

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(trigger.textContent).toContain('gpt-5.6')
    expect(modelList()).toBeInstanceOf(HTMLElement)
    picker.destroy()
  })

  it('closes when the picker becomes unavailable', () => {
    const { picker, trigger } = mountPicker()
    trigger.click()
    picker.render(state({ disabled: true, settings }))
    expect(document.querySelector('#model-listbox')).toBeNull()
    expect(trigger.disabled).toBe(true)
    picker.destroy()
  })

  it('selects and closes without cascading when the host offers no settings entry point', async () => {
    const { picker, trigger, onSelect } = mountPicker()
    trigger.click()
    modelRow(1).click()

    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(models[1]))
    await vi.waitFor(() => expect(document.querySelector('#model-picker-popover')).toBeNull())
    expect(document.querySelector('#model-settings-popover')).toBeNull()
    picker.destroy()
  })
})
