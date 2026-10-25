/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ModelSettings } from '@agnes/protocol'
import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { createRegionRenderer, installFeedbackSink, type RegionRenderer } from '@agnes/web-ui'
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
const currentModel: ModelPickerOption = {
  route: 'openai',
  id: 'gpt-5.6',
  label: 'OpenAI',
  contextWindow: 128000,
}

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
  const found = rows().find((option) => option.querySelector('.model-picker-model')?.textContent === id)
  if (!found) throw new Error(`missing model row: ${id}`)
  return found
}

function option(group: string, label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>(`#${group} [role="radio"]`)].find(
    (option) => option.querySelector('span')?.childNodes[0]?.textContent === label,
  )
  if (!found) throw new Error(`missing choice: ${label}`)
  return found
}
function choose(group: string, label: string): void {
  option(group, label).click()
}
async function enter(panel: 'thinking' | 'context' | 'auxiliary') {
  document.querySelector<HTMLButtonElement>(`#model-picker-${panel}`)?.click()
  await vi.waitFor(() =>
    expect(document.querySelector('.model-picker-back')?.textContent).toBe(
      panel === 'thinking' ? '思考强度' : panel === 'context' ? '上下文窗口' : '后台模型',
    ),
  )
}
async function custom() {
  await enter('context')
  choose('session-model-budget', '自定义')
  await vi.waitFor(() => expect(document.querySelector('#session-model-window')).not.toBeNull())
}

async function chooseAuxiliary(slot: 'fast' | 'verifier', label: string) {
  document
    .querySelector<HTMLElement>(`#session-model-slot-${slot}`)
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('.ant-select-dropdown')).not.toBeNull())
  const row = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((el) =>
    el.textContent?.includes(label),
  )
  if (!row) throw new Error(`missing auxiliary model: ${label}`)
  row.click()
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
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
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
    expect(trigger.getAttribute('aria-controls')).toBe('model-picker-popover')
    expect(document.querySelector('#model-picker-popover')?.getAttribute('role')).toBe('dialog')
    expect(
      [...list.querySelectorAll('[role="group"]')].map((group) => group.getAttribute('aria-label')),
    ).toEqual(['OpenAI', '本机', '已配置账户'])
    expect(rows().map((option) => option.querySelector('.model-picker-model')?.textContent)).toEqual(
      models.map((model) => model.id),
    )
    expect(row('gpt-5.6').getAttribute('aria-selected')).toBe('true')
    expect(list.getAttribute('aria-activedescendant')).toBe(row('gpt-5.6').id)
    // 模型少时不出搜索框，焦点直接落在列表上。
    expect(document.querySelector('#model-picker-popover [role="combobox"]')).toBeNull()
    expect(document.activeElement).toBe(list)
  })

  it('keeps the search row outside the scrolling list inside one shrinkable body', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      route: 'bulk',
      id: `model-${index}`,
      label: 'Bulk',
    }))
    const { trigger } = mountPicker({ options: many, selected: many[0], settings: undefined })
    await open(trigger)
    // The body is the flex column that gives way to the list; the search row must stay out of it.
    const body = document.querySelector<HTMLElement>('#model-picker-popover > .model-picker-body')
    if (!body) throw new Error('model-picker-body is missing')
    expect(body.hidden).toBe(false)
    const search = body.querySelector('.model-picker-search')
    expect(search).not.toBeNull()
    expect(search?.closest('.model-picker-list')).toBeNull()
    const list = body.querySelector('.model-picker-list')
    expect(list).not.toBeNull()
    // A direct child of the body so it can take the leftover height.
    expect(list?.parentElement).toBe(body)
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
    await vi.waitFor(() =>
      expect(rows().map((option) => option.querySelector('.model-picker-model')?.textContent)).toEqual([
        'local-model',
      ]),
    )
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
      document
        .getElementById(list.getAttribute('aria-activedescendant') ?? '')
        ?.querySelector('.model-picker-model')?.textContent
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
    await enter('thinking')
    const levels = [...document.querySelectorAll('#session-model-thinking [role=radio]')]
    expect(levels.map((level) => level.textContent)).toEqual(['自动由模型自己决定想多久', '低', '高'])
    expect(document.querySelector('.model-picker-head-note')?.textContent).toBe('gpt-5.6')
    expect(option('session-model-thinking', '低').getAttribute('aria-checked')).toBe('true')
    choose('session-model-thinking', '高')
    // 档位与预算一起提交，免得只改一项把另一项重置。
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'high', contextWindow: 64000 }),
    )
    await closed()
  })

  it('keeps all declared model levels and capacity-valid budgets in their sub-panels', async () => {
    const { trigger, onSettingsChange } = mountPicker({
      settings: {
        ...settings,
        capacity: 1000000,
        thinkingLevelMap: {
          off: 'off',
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      },
    })
    await open(trigger)
    await enter('thinking')
    expect(document.querySelectorAll('#session-model-thinking [role=radio]')).toHaveLength(8)
    expect(document.querySelectorAll('#session-model-budget [role=radio]')).toHaveLength(4)
    expect(document.querySelector('#model-settings-popover .agh-segmented')).toBeNull()
    choose('session-model-thinking', '高')
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'high', contextWindow: 64000 }),
    )
    await closed()
  })

  it('offers budget presets within the model capacity and applies one', async () => {
    const { trigger, onSettingsChange } = mountPicker()
    await open(trigger)
    await enter('context')
    const presets = [...document.querySelectorAll('#session-model-budget [role=radio]')]
    // 左边是名称，右边一列是数值；「自动」的数值就是模型容量。
    expect(presets.map((preset) => preset.textContent)).toEqual([
      '自动用满模型容量128K',
      '较小32K',
      '中等64K',
      '自定义',
    ])
    expect(document.querySelector('.model-picker-head-note')?.textContent).toBe('模型容量 128K')
    expect(option('session-model-budget', '中等').getAttribute('aria-checked')).toBe('true')
    choose('session-model-budget', '自动')
    await vi.waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'low' }))
    await closed()
  })

  it('commits the custom budget on Enter rather than on every keystroke', async () => {
    const { trigger, onSettingsChange } = mountPicker()
    await open(trigger)
    await custom()
    type(budget(), '100')
    await vi.waitFor(() => expect(budget().value).toBe('100'))
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
    await custom()
    type(budget(), '999000')
    await vi.waitFor(() => expect(budget().getAttribute('aria-invalid')).toBe('true'))
    expect(document.querySelector('#session-model-settings-error')?.textContent).toContain('128 K')
    expect(option('session-model-budget', '自定义').getAttribute('aria-checked')).toBe('true')
    press(budget(), 'Enter')
    press(budget(), 'Enter')
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
    await custom()
    type(budget(), '100')
    await vi.waitFor(() => expect(budget().value).toBe('100'))
    press(budget(), 'Enter')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    await vi.waitFor(() =>
      expect(document.querySelector('#model-picker-popover > [role="alert"]')?.textContent).toBe(
        '保存设置失败，请重试。',
      ),
    )
    expect(budget().value).toBe('100')
  })

  it('announces a saved level the model no longer declares and resets it with the next change', async () => {
    const { trigger, onSettingsChange } = mountPicker({ settings: { ...settings, thinking: 'max' } })
    expect(trigger.querySelector('[data-model-level]')).toBeNull()
    await open(trigger)
    await enter('context')
    expect(document.querySelector('.model-picker-notice')?.textContent).toContain('max')
    expect(document.querySelector('#session-model-thinking [aria-checked=true]')).toBeNull()
    choose('session-model-budget', '较小')
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

  it('hides the account heading when every model comes from one account', async () => {
    const { trigger } = mountPicker({ options: models.slice(0, 2) })
    const list = await open(trigger)
    expect(list.querySelectorAll('[role="group"]')).toHaveLength(1)
    expect(list.querySelector('.model-picker-group-title')).toBeNull()
    // 「本会话」标题右侧说明改动范围。
    expect(document.querySelector('.model-picker-session')?.textContent).toContain('只改当前会话')
  })

  it('disables reasoning for a model that declares no levels instead of opening an empty panel', async () => {
    const { thinkingLevelMap: _levels, thinking: _thinking, ...plain } = settings
    const { trigger } = mountPicker({ settings: plain })
    await open(trigger)
    const row = document.querySelector<HTMLButtonElement>('#model-picker-thinking')
    expect(row?.disabled).toBe(true)
    expect(row?.querySelector('.model-picker-value')?.textContent).toBe('此模型不支持')
    expect(document.querySelector<HTMLButtonElement>('#model-picker-context')?.disabled).toBe(false)
  })

  it('shows a saved custom budget in the value column and applies a new one with the Apply button', async () => {
    const { trigger, onSettingsChange } = mountPicker({ settings: { ...settings, contextWindow: 100000 } })
    await open(trigger)
    expect(document.querySelector('#model-picker-context .model-picker-value')?.textContent).toBe('100K')
    await enter('context')
    expect(option('session-model-budget', '自定义').textContent).toBe('自定义100K')
    expect(budget().value).toBe('100')
    expect(document.querySelector('#session-model-window-hint')?.textContent).toMatch(
      /^\S+ 到 128K 之间。越小越省钱，但更早触发上下文压缩。$/,
    )
    type(budget(), '120')
    await vi.waitFor(() => expect(budget().value).toBe('120'))
    const apply = [...document.querySelectorAll<HTMLButtonElement>('.model-picker-custom button')].find(
      (button) => button.textContent === '应用',
    )
    apply?.click()
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({ thinking: 'low', contextWindow: 120000 }),
    )
    await closed()
  })

  it('explains why the trigger is locked while a reply is running', () => {
    const { trigger } = mountPicker({ disabled: true, disabledReason: '回复结束后可以切换模型' })
    expect(trigger.disabled).toBe(true)
    expect(trigger.title).toBe('回复结束后可以切换模型')
    expect(trigger.closest('.agh-tooltip-anchor')?.getAttribute('aria-label')).toBe('回复结束后可以切换模型')
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

  it.each(['fast', 'verifier'] as const)(
    'applies %s immediately, reports success, and keeps defaults and primary independent',
    async (slot) => {
      const onAuxiliarySelect = vi.fn(async () => true)
      const publish = vi.fn()
      const restore = installFeedbackSink({ publish, resolve: vi.fn() })
      try {
        const { trigger, onSelect } = mountPicker(
          { auxiliaryAvailable: true },
          {
            onAuxiliaryRead: async () => ({
              fast: { route: 'openai', model: 'gpt-5.6' },
              verifier: null,
              defaults: { fast: { route: 'openai', model: 'gpt-5.6' }, verifier: null },
            }),
            onAuxiliarySelect,
          },
        )
        await open(trigger)
        await vi.waitFor(() =>
          expect(document.querySelector('#model-picker-auxiliary')?.textContent).toContain('跟随默认'),
        )
        await enter('auxiliary')
        expect(document.querySelector('[data-testid=session-auxiliary-models]')?.textContent).toContain(
          '跟随默认 · gpt-5.6',
        )
        expect(document.querySelector('[data-testid=session-auxiliary-models]')?.textContent).toContain(
          '跟随默认 · 未设置',
        )
        // 两项各写清用途，底部说明只改当前会话。
        const panelText = document.querySelector('#model-picker-popover')?.textContent ?? ''
        for (const text of [
          '这个会话在后台用到的模型',
          '快速任务',
          '摘要、回复建议',
          '自动审阅',
          '只改当前会话',
        ])
          expect(panelText).toContain(text)
        expect(document.querySelector('[data-testid$="-save"]')).toBeNull()
        expect(document.querySelector('.model-picker-defaults-link')?.getAttribute('href')).toBe(
          '?settings=auxiliary-models',
        )
        await chooseAuxiliary(slot, 'local-model · 本机')
        await vi.waitFor(() =>
          expect(onAuxiliarySelect).toHaveBeenCalledWith(
            slot,
            expect.objectContaining({ route: 'local', id: 'local-model' }),
          ),
        )
        await vi.waitFor(() =>
          expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'success', message: '后台模型已更新。仅用于当前会话。' }),
          ),
        )
        expect(onSelect).not.toHaveBeenCalled()
        press(document.querySelector('.model-picker-back')!, 'Escape')
        // 默认未设置的一项按预设路由走，客户端看不到，不计入「已改」。
        await vi.waitFor(() =>
          expect(document.querySelector('#model-picker-auxiliary .model-picker-value')?.textContent).toBe(
            slot === 'fast' ? '已改 1 项' : '跟随默认',
          ),
        )
        if (slot === 'fast') {
          await enter('auxiliary')
          await chooseAuxiliary('fast', '跟随默认 · gpt-5.6')
          await vi.waitFor(() =>
            expect(onAuxiliarySelect).toHaveBeenCalledWith('fast', { route: 'openai', id: 'gpt-5.6' }),
          )
          press(document.querySelector('.model-picker-back')!, 'Escape')
          await vi.waitFor(() =>
            expect(document.querySelector('#model-picker-auxiliary')?.textContent).toContain('跟随默认'),
          )
        }
      } finally {
        restore()
      }
    },
  )

  it.each(['declined', 'failed'] as const)(
    'keeps confirmed auxiliary choices and publishes no success when a save is %s',
    async (outcome) => {
      const publish = vi.fn()
      const restore = installFeedbackSink({ publish, resolve: vi.fn() })
      const onAuxiliarySelect = vi.fn(async () => {
        if (outcome === 'failed') throw new Error('unavailable')
        return false
      })
      try {
        const { trigger } = mountPicker(
          { auxiliaryAvailable: true },
          { onAuxiliaryRead: async () => ({ fast: null, verifier: null }), onAuxiliarySelect },
        )
        await open(trigger)
        await enter('auxiliary')
        await vi.waitFor(() => expect(document.querySelector('#session-model-slot-fast')).not.toBeNull())
        await chooseAuxiliary('fast', 'local-model · 本机')
        await vi.waitFor(() =>
          expect(document.querySelector('[data-testid=session-model-slot-status]')?.textContent).toBe(
            '未能为当前会话保存',
          ),
        )
        expect(publish).not.toHaveBeenCalled()
        expect(document.querySelector('[data-testid=session-auxiliary-models]')?.textContent).toContain(
          '跟随默认 · 未设置',
        )
      } finally {
        restore()
      }
    },
  )

  it('reloads reasoning choices from the selected model and preserves no obsolete levels', async () => {
    const { trigger, render } = mountPicker()
    await open(trigger)
    await enter('thinking')
    render({
      selected: models[2],
      settings: { capacity: 256000, thinkingLevelMap: { off: 'none', medium: 'medium' } },
    })
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('#session-model-thinking [role=radio]')].map((el) => el.textContent),
      ).toEqual(['自动由模型自己决定想多久', '关闭', '中']),
    )
  })

  it.each(['100', ''] as const)('commits a custom K value on leaving the field (%s)', async (raw) => {
    const { trigger, onSettingsChange } = mountPicker()
    await open(trigger)
    await custom()
    budget().focus()
    type(budget(), raw)
    await vi.waitFor(() => expect(budget().value).toBe(raw))
    expect(onSettingsChange).not.toHaveBeenCalled()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    await vi.waitFor(() =>
      expect(onSettingsChange).toHaveBeenCalledWith({
        thinking: 'low',
        ...(raw ? { contextWindow: 100000 } : {}),
      }),
    )
  })

  it.each([undefined, settings.capacity])(
    'shows current values and navigates with Enter, arrows and two Escapes (budget %s)',
    async (window) => {
      const { contextWindow: _budget, ...automatic } = settings
      const { trigger } = mountPicker({
        settings: { ...automatic, ...(window === undefined ? {} : { contextWindow: window }) },
      })
      await open(trigger)
      expect(document.querySelectorAll('.model-picker-nav')).toHaveLength(3)
      expect(document.querySelector('#model-picker-thinking')?.textContent).toContain('低')
      // 容量已在模型行右侧，主菜单的「自动」不再重复它。
      expect(document.querySelector('#model-picker-context .model-picker-value')?.textContent).toBe('自动')
      expect(document.querySelectorAll('.model-picker-group-title')[0]?.textContent).toBe('OpenAI')
      expect(document.querySelector('.model-picker-capacity')?.textContent).toBe('128K')
      expect(document.querySelector('.model-picker-settings-title')).toBeNull()
      for (const key of ['Enter', 'ArrowRight']) {
        const row = document.querySelector<HTMLElement>('#model-picker-thinking')!
        row.focus()
        press(row, key)
        await vi.waitFor(() =>
          expect(document.activeElement).toBe(document.querySelector('.model-picker-back')),
        )
        press(document.activeElement as HTMLElement, 'ArrowLeft')
        await vi.waitFor(() => expect(document.activeElement).toBe(row))
      }
      await enter('context')
      expect(option('session-model-budget', '自动').getAttribute('aria-checked')).toBe('true')
      press(document.activeElement as HTMLElement, 'Escape')
      await vi.waitFor(() => expect(document.activeElement?.id).toBe('model-picker-context'))
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      press(document.activeElement as HTMLElement, 'Escape')
      await closed()
      expect(document.activeElement).toBe(trigger)
    },
  )
})

it('lets the popover hug its content and aligns model and session rows in fixed columns', () => {
  const css = readFileSync(resolve(__dirname, '../public/styles/09-model-picker.css'), 'utf8')
  const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('}')[0] ?? ''
  expect(rule('  .model-picker')).not.toContain('min-height')
  // Clip keeps the search row on screen: a scroll container here would scroll the panel itself.
  expect(rule('  .model-picker')).toMatch(/overflow: clip;/)
  // The body shrinks; the list is the only scrolling child, and the text rows keep their height.
  expect(rule('  .model-picker-body')).toMatch(
    /display: flex;[\s\S]*flex-direction: column;[\s\S]*min-height: 0;/,
  )
  expect(css).toMatch(/\.model-picker-search,\s*\.model-picker-help \{\s*flex: none;/)
  expect(rule('  .model-picker-list')).toMatch(
    /flex: 1 1 auto;[\s\S]*min-height: 0;[\s\S]*max-height: min\(17rem, calc\(100dvh - 21rem\)\)/,
  )
  expect(rule('  .model-picker-option')).toMatch(
    /display: grid;[\s\S]*grid-template-columns: minmax\(0, 1fr\) 2.75rem 1.25rem/,
  )
  expect(rule('  .model-picker-nav')).toMatch(
    /display: grid;[\s\S]*grid-template-columns: 5.25rem minmax\(0, 1fr\) 1rem/,
  )
  expect(rule('  .model-picker-value')).toMatch(
    /text-align: start;[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap/,
  )
})
