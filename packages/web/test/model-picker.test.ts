/** @vitest-environment happy-dom */
import type { ModelSettings } from '@agnes/protocol'
import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { createRegionRenderer, type RegionRenderer } from '@agnes/web-ui'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { groupModels } from '../src/model-picker/state.js'
import {
  ModelPickerControl,
  type ModelPickerOption,
  type ModelPickerProps,
  type ModelPickerSettings,
  type ModelPickerState,
} from '../src/model-picker.js'
import { zhT } from './helpers/locale.js'

setLocaleTranslator(zhT)

/** 第一行是会话当前使用的模型，它的设置就是 fixture 里的 `settings`。 */
const currentModel: ModelPickerOption = { route: 'openai', id: 'gpt-5.6', label: 'OpenAI' }

const models: readonly ModelPickerOption[] = [
  currentModel,
  { route: 'openai', id: 'gpt-5.6-mini', label: 'OpenAI' },
  { route: 'local', id: 'local-model', label: '本机' },
  { route: 'deepseek', id: 'deepseek-v4-pro' },
]

const settings: ModelPickerSettings = {
  thinking: 'low',
  contextWindow: 64000,
  capacity: 128000,
  thinkingLevelMap: { low: 'low', high: 'high' },
}

/** `undefined` 表示把这一项从 fixture 里拿掉（没有已选模型、没有会话设置、宿主不提供设置入口）。 */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined }

function without<T extends object>(value: Overrides<T>): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function state(overrides: Overrides<ModelPickerState> = {}): ModelPickerState {
  const base: ModelPickerState = {
    accessibleName: '选择当前会话模型',
    disabled: false,
    label: 'gpt-5.6',
    options: models,
    pending: false,
    selected: currentModel,
    settings,
  }
  return without<ModelPickerState>({ ...base, ...overrides }) as ModelPickerState
}

const regions: RegionRenderer[] = []

function mountPicker(
  overrides: Overrides<ModelPickerState> = {},
  handlers: Overrides<Omit<ModelPickerProps, 'state'>> = {},
) {
  const host = document.createElement('div')
  document.body.append(host)
  const region = createRegionRenderer(host)
  regions.push(region)
  const props = {
    onSelect: vi.fn(async (_option: ModelPickerOption) => true),
    onSettingsChange: vi.fn(async (_next: ModelSettings) => true),
    onError: vi.fn(),
    ...handlers,
  }
  const render = (next: Overrides<ModelPickerState> = {}) => {
    const picker = {
      ...without<Omit<ModelPickerProps, 'state'>>(props),
      state: state({ ...overrides, ...next }),
    }
    region.render(createElement(ModelPickerControl, picker as ModelPickerProps))
    region.flush()
  }
  render()
  const trigger = host.querySelector<HTMLButtonElement>('#model')
  if (!trigger) throw new Error('model trigger is missing')
  return { ...props, render, trigger }
}

async function open(trigger: HTMLButtonElement): Promise<HTMLElement> {
  trigger.focus()
  trigger.click()
  await vi.waitFor(() => expect(document.querySelector('#model-listbox')).not.toBeNull())
  return listbox()
}

function listbox(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-listbox')
  if (!found) throw new Error('model picker did not open')
  return found
}

function rows(): HTMLElement[] {
  return [...listbox().querySelectorAll<HTMLElement>('[role="option"]')]
}

function row(id: string): HTMLElement {
  const found = rows().find((option) => option.textContent === id)
  if (!found) throw new Error(`missing model row: ${id}`)
  return found
}

function radio(group: string, label: string): HTMLInputElement {
  const found = [...document.querySelectorAll<HTMLInputElement>(`#${group} input[type="radio"]`)].find(
    (option) => option.closest('label')?.textContent === label,
  )
  if (!found) throw new Error(`missing choice: ${label}`)
  return found
}

function budget(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('#session-model-window')
  if (!found) throw new Error('custom budget field is missing')
  return found
}

/** React 在节点上装了 value 追踪器，直接赋值绕不过它；走原型上的原生 setter。 */
function type(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

const closed = () => vi.waitFor(() => expect(document.querySelector('#model-listbox')).toBeNull())

afterEach(() => {
  for (const region of regions.splice(0)) region.unmount()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('model catalog grouping', () => {
  it('groups by provider account in catalog order and numbers the visible rows', () => {
    const groups = groupModels(models, '', '已配置账户')
    expect(groups.map((group) => [group.label, group.entries.map((entry) => entry.option.id)])).toEqual([
      ['OpenAI', ['gpt-5.6', 'gpt-5.6-mini']],
      ['本机', ['local-model']],
      ['已配置账户', ['deepseek-v4-pro']],
    ])
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.index))).toEqual([0, 1, 2, 3])
  })

  it('matches the model id, route or account label and renumbers what is left', () => {
    expect(groupModels(models, 'MINI', 'x').flatMap((group) => group.entries)).toEqual([
      { option: models[1], index: 0 },
    ])
    expect(groupModels(models, '本机', 'x')[0]?.entries[0]?.option.id).toBe('local-model')
    expect(groupModels(models, 'deepseek', 'x')[0]?.entries[0]?.index).toBe(0)
    expect(groupModels(models, 'nothing', 'x')).toEqual([])
  })
})

describe('model picker', () => {
  it('shows the model and its reasoning level on the trigger', () => {
    const { trigger, render } = mountPicker()
    expect(trigger.querySelector('[data-model-label]')?.textContent).toBe('gpt-5.6')
    expect(trigger.querySelector('[data-model-level]')?.textContent).toBe('低')
    expect(trigger.getAttribute('aria-label')).toBe('选择当前会话模型')
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    // 自动档不占位。
    render({
      settings: {
        capacity: settings.capacity,
        contextWindow: 64000,
        thinkingLevelMap: { low: 'low', high: 'high' },
      },
    })
    expect(trigger.querySelector('[data-model-level]')).toBeNull()
  })

  it('opens one list grouped by provider with the session model selected and active', async () => {
    const { trigger } = mountPicker()
    const list = await open(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe('model-listbox')
    expect(
      [...list.querySelectorAll('[role="group"]')].map((group) => group.getAttribute('aria-label')),
    ).toEqual(['OpenAI', '本机', '已配置账户'])
    expect(rows().map((option) => option.textContent)).toEqual(models.map((model) => model.id))
    expect(row('gpt-5.6').getAttribute('aria-selected')).toBe('true')
    expect(list.getAttribute('aria-activedescendant')).toBe(row('gpt-5.6').id)
    // 模型少时不出搜索框，焦点直接落在列表上。
    expect(document.querySelector('#model-picker-popover [role="combobox"]')).toBeNull()
    expect(document.activeElement).toBe(list)
  })

  it('closes on a second click of the trigger', async () => {
    const { trigger } = mountPicker()
    await open(trigger)
    trigger.click()
    await closed()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('searches a long catalog, says when nothing matches and selects the highlighted row with Enter', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      route: 'bulk',
      id: `model-${index}`,
      label: 'Bulk',
    }))
    const { trigger, onSelect } = mountPicker({ options: [...many, ...models], selected: many[0] })
    await open(trigger)
    const search = document.querySelector<HTMLInputElement>('#model-picker-popover [role="combobox"]')
    if (!search) throw new Error('search field is missing')
    expect(document.activeElement).toBe(search)
    expect(search.getAttribute('aria-controls')).toBe('model-listbox')

    type(search, 'zzz')
    await vi.waitFor(() => expect(rows()).toHaveLength(0))
    expect(document.querySelector('.model-picker-empty')?.textContent).toBe('没有匹配“zzz”的模型。')
    press(search, 'Enter')
    expect(onSelect).not.toHaveBeenCalled()

    type(search, 'local')
    await vi.waitFor(() => expect(rows().map((option) => option.textContent)).toEqual(['local-model']))
    expect(search.getAttribute('aria-activedescendant')).toBe('model-picker-option-0')
    // 搜索框里空格是输入，不是选择。
    expect(press(search, ' ').defaultPrevented).toBe(false)
    press(search, 'Enter')
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(models[2]))
    await closed()
  })

  it('walks the list with the keyboard and returns focus to the trigger on Escape', async () => {
    const { trigger, onSelect } = mountPicker()
    trigger.focus()
    press(trigger, 'ArrowDown')
    await vi.waitFor(() => expect(document.querySelector('#model-listbox')).not.toBeNull())
    const list = listbox()
    const active = () =>
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '')?.textContent
    expect(active()).toBe('gpt-5.6')
    press(list, 'ArrowDown')
    await vi.waitFor(() => expect(active()).toBe('gpt-5.6-mini'))
    press(list, 'End')
    await vi.waitFor(() => expect(active()).toBe('deepseek-v4-pro'))
    press(list, 'ArrowDown')
    await vi.waitFor(() => expect(active()).toBe('gpt-5.6'))
    press(list, 'ArrowUp')
    await vi.waitFor(() => expect(active()).toBe('deepseek-v4-pro'))
    press(list, 'Home')
    await vi.waitFor(() => expect(active()).toBe('gpt-5.6'))

    press(list, 'Escape')
    await closed()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('switches the model on click, closes once the host accepts and hands focus back', async () => {
    const { trigger, onSelect } = mountPicker()
    await open(trigger)
    row('local-model').click()
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(models[2]))
    await closed()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('does not resend the selected model while its settings are on the panel', async () => {
    const { trigger, onSelect } = mountPicker()
    await open(trigger)
    row('gpt-5.6').click()
    await closed()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('re-applies the selected model when there are no settings to show for it', async () => {
    const { trigger, onSelect } = mountPicker({ settings: undefined })
    await open(trigger)
    row('gpt-5.6').click()
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(currentModel))
    await closed()
  })

  it('stays open with the current selection when the host declines or the change fails', async () => {
    const failure = new Error('model unavailable')
    const onSelect = vi
      .fn<(option: ModelPickerOption) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(failure)
    const { trigger, onError } = mountPicker({}, { onSelect })
    await open(trigger)
    row('local-model').click()
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(listbox().getAttribute('aria-busy')).toBe('false'))
    expect(row('gpt-5.6').getAttribute('aria-selected')).toBe('true')
    expect(onError).not.toHaveBeenCalled()

    row('local-model').click()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    // 失败在面板里原地说明，列表和原选择都还在。
    await vi.waitFor(() =>
      expect(document.querySelector('#model-picker-popover > [role="alert"]')?.textContent).toBe(
        '切换模型失败，请重试。',
      ),
    )
    expect(row('gpt-5.6').getAttribute('aria-selected')).toBe('true')
  })

  it('ignores further choices while one change is in flight', async () => {
    let settle: (accepted: boolean) => void = () => {}
    const onSelect = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        }),
    )
    const { trigger } = mountPicker({}, { onSelect })
    await open(trigger)
    row('local-model').click()
    await vi.waitFor(() => expect(listbox().getAttribute('aria-busy')).toBe('true'))
    expect(row('deepseek-v4-pro').getAttribute('aria-disabled')).toBe('true')
    row('deepseek-v4-pro').click()
    expect(onSelect).toHaveBeenCalledTimes(1)
    settle(true)
    await closed()
  })

  it('lists the declared reasoning levels and applies one together with the saved budget', async () => {
    const { trigger, onSettingsChange } = mountPicker()
    await open(trigger)
    const levels = [...document.querySelectorAll('#session-model-thinking input[type="radio"]')]
    expect(levels.map((level) => level.closest('label')?.textContent)).toEqual(['自动', '低', '高'])
    expect(String(radio('session-model-thinking', '低').checked)).toBe('true')
    radio('session-model-thinking', '高').click()
    // 档位与预算一起提交，免得只改一项把另一项重置。
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'high', contextWindow: 64000 }),
    )
    await closed()
  })

  it('selects a choice with radio-group arrow keys and sends the saved budget with it', async () => {
    const { trigger, onSettingsChange } = mountPicker()
    await open(trigger)
    const low = radio('session-model-thinking', '低')
    expect(low.tabIndex).toBe(0)
    low.focus()
    press(low, 'ArrowRight')
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'high', contextWindow: 64000 }),
    )
    await closed()
  })

  it('offers budget presets within the model capacity and applies one', async () => {
    const { trigger, onSettingsChange } = mountPicker()
    await open(trigger)
    const presets = [...document.querySelectorAll('#session-model-budget input[type="radio"]')]
    expect(presets.map((preset) => preset.closest('label')?.textContent)).toEqual([
      '自动',
      '32K',
      '64K',
      '128K',
    ])
    expect(String(radio('session-model-budget', '64K').checked)).toBe('true')
    radio('session-model-budget', '自动').click()
    await vi.waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'low' }))
    await closed()
  })

  it('commits the custom budget on Enter rather than on every keystroke', async () => {
    const { trigger, onSettingsChange } = mountPicker()
    await open(trigger)
    type(budget(), '100k')
    await vi.waitFor(() => expect(budget().value).toBe('100k'))
    expect(onSettingsChange).not.toHaveBeenCalled()
    press(budget(), 'Enter')
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'low', contextWindow: 100000 }),
    )
    await closed()
  })

  it('refuses an out-of-range budget, marks the field invalid and names the range', async () => {
    const { trigger, onSettingsChange } = mountPicker()
    await open(trigger)
    type(budget(), '999m')
    await vi.waitFor(() => expect(budget().getAttribute('aria-invalid')).toBe('true'))
    expect(document.querySelector('#session-model-settings-error')?.textContent).toContain('128,000')
    expect(document.querySelector('#session-model-budget input:checked')).toBeNull()
    press(budget(), 'Enter')
    radio('session-model-thinking', '高').click()
    expect(onSettingsChange).not.toHaveBeenCalled()
    expect(document.querySelector('#model-listbox')).not.toBeNull()
  })

  it('keeps the panel and the typed value when a settings change fails', async () => {
    const failure = new Error('rejected')
    const onSettingsChange = vi.fn(async () => {
      throw failure
    })
    const { trigger, onError } = mountPicker({}, { onSettingsChange })
    await open(trigger)
    type(budget(), '100k')
    await vi.waitFor(() => expect(budget().value).toBe('100k'))
    press(budget(), 'Enter')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    await vi.waitFor(() =>
      expect(document.querySelector('#model-picker-popover > [role="alert"]')?.textContent).toBe(
        '保存设置失败，请重试。',
      ),
    )
    expect(budget().value).toBe('100k')
  })

  it('announces a saved level the model no longer declares and resets it with the next change', async () => {
    const { trigger, onSettingsChange } = mountPicker({ settings: { ...settings, thinking: 'max' } })
    expect(trigger.querySelector('[data-model-level]')).toBeNull()
    await open(trigger)
    expect(document.querySelector('.model-picker-notice')?.textContent).toContain('max')
    expect(document.querySelector('#session-model-thinking input:checked')).toBeNull()
    radio('session-model-budget', '32K').click()
    await vi.waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith({ contextWindow: 32000 }))
  })

  it('lists models only when the host offers no settings entry point or the model reports none', async () => {
    const first = mountPicker({}, { onSettingsChange: undefined })
    await open(first.trigger)
    expect(document.querySelector('#model-settings-popover')).toBeNull()
    press(listbox(), 'Escape')
    await closed()

    const second = mountPicker({ settings: undefined })
    expect(second.trigger.querySelector('[data-model-level]')).toBeNull()
    await open(second.trigger)
    expect(document.querySelector('#model-settings-popover')).toBeNull()
  })

  it('cannot open without models and closes when the picker becomes unavailable', async () => {
    const empty = mountPicker({ options: [], selected: undefined, settings: undefined })
    expect(empty.trigger.disabled).toBe(true)

    const { trigger, render } = mountPicker()
    await open(trigger)
    render({ disabled: true })
    await closed()
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('explains the choice when the session has no model yet', async () => {
    const { trigger } = mountPicker({ selected: undefined, settings: undefined, label: '选择模型' })
    await open(trigger)
    expect(document.querySelector('[data-model-picker-help]')?.textContent).toBe('选择此任务使用的模型')
    expect(listbox().getAttribute('aria-activedescendant')).toBe('model-picker-option-0')
  })

  it('offers explicit auxiliary session overrides without selecting the primary model', async () => {
    const onAuxiliarySelect = vi.fn(async () => true)
    const { trigger, onSelect } = mountPicker(
      { auxiliaryAvailable: true },
      { onAuxiliaryRead: async () => ({ fast: null, verifier: null }), onAuxiliarySelect },
    )
    await open(trigger)
    await vi.waitFor(() => expect(document.querySelector('#session-model-slot-fast')).not.toBeNull())
    const select = document.querySelector<HTMLSelectElement>('#session-model-slot-fast')
    if (!select) throw new Error('auxiliary slot is missing')
    select.value = JSON.stringify(['local', 'local-model'])
    select.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-testid="session-model-slot-fast-save"]')?.click()
    await vi.waitFor(() =>
      expect(onAuxiliarySelect).toHaveBeenCalledWith(
        'fast',
        expect.objectContaining({ route: 'local', id: 'local-model' }),
      ),
    )
    expect(onSelect).not.toHaveBeenCalled()
  })
})
