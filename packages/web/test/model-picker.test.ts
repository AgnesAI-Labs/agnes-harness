/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelPicker, type ModelPickerOption, type ModelPickerState } from '../src/model-picker.js'
import { setLocaleTranslator } from '../src/locale-bridge.js'
import { zhT } from './helpers/locale.js'

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)


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

/** 首层入口菜单。 */
function listbox(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-listbox')
  if (!found) throw new Error('model picker did not open')
  return found
}

/** 二级子菜单：模型列表或推理等级列表，另开一个浮层。 */
function sublistbox(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-submenu-listbox')
  if (!found) throw new Error('model picker submenu did not open')
  return found
}

const subRows = (): HTMLElement[] => Array.from(sublistbox().querySelectorAll<HTMLElement>('[role="option"]'))

/** 首层入口菜单的某一行（模型 / 推理等级）。 */
function entry(label: string): HTMLElement | undefined {
  return Array.from(listbox().querySelectorAll<HTMLElement>('.model-picker-entry')).find(
    (row) => row.querySelector('.model-picker-entry-label')?.textContent === label,
  )
}

/** 首层入口行右侧的当前值。 */
function entryValue(label: string): string | undefined {
  return entry(label)?.querySelector('.model-picker-entry-value')?.textContent ?? undefined
}

function openModels(): void {
  entry('模型')?.click()
}

function openLevels(): void {
  entry('推理等级')?.click()
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
    openModels()
    const selected = sublistbox().querySelector('[aria-selected="true"]')
    expect(sublistbox().getAttribute('aria-activedescendant')).toBe(selected?.id)
    expect(scroll.mock.contexts).toContain(selected)
    picker.render(state({ options: directory, disabled: true }))
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(trigger.disabled).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
    picker.destroy()
    scroll.mockRestore()
  })

  it('opens an entry menu, then a submenu that keeps the entry list on screen', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const trigger = installTrigger()
    const onSelect = vi.fn(async () => true)
    const picker = createModelPicker({ trigger, onSelect, onError: vi.fn() })
    picker.render(state())

    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(listbox().getAttribute('aria-label')).toBe('模型与推理等级')
    // 目录里没有推理模型时，首层只有「模型」一行。
    expect(entry('模型')).toBeInstanceOf(HTMLElement)
    expect(entry('推理等级')).toBeUndefined()
    expect(document.querySelector('#model-submenu-listbox')).toBeNull()

    openModels()
    // 子菜单是另开的浮层，首层入口行必须留着——它是「当前在改哪一项」的落点。
    expect(listbox()).toBeInstanceOf(HTMLElement)
    expect(entry('模型')?.getAttribute('data-open')).toBe('true')
    expect(document.activeElement).toBe(sublistbox())

    const options = subRows()
    expect(options).toHaveLength(models.length)
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false'])
    expect(options.map((option) => option.textContent)).not.toContain('选择模型')
    expect(sublistbox().textContent).toContain('已配置账户')
    expect(sublistbox().textContent).not.toContain('openai')
    expect(sublistbox().textContent).not.toContain('local')

    sublistbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(sublistbox().getAttribute('aria-activedescendant')).toBe('model-submenu-option-2')
    sublistbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(sublistbox().getAttribute('aria-activedescendant')).toBe('model-submenu-option-0')

    // 子菜单的 Esc 只收起子菜单，首层还在，也没有产生任何选择。
    sublistbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('#model-submenu-listbox')).toBeNull()
    expect(listbox()).toBeInstanceOf(HTMLElement)
    expect(document.activeElement).toBe(listbox())

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

    // 点开子菜单之后，点在两个浮层之外同样要全部收起。
    trigger.click()
    openModels()
    outside.click()
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.querySelector('#model-submenu-listbox')).toBeNull()

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
    expect(entryValue('模型')).toBe(firstModel.id)
    openModels()
    subRows()[1]?.click()
    await vi.waitFor(() => expect(failedSelect).toHaveBeenCalledWith(secondModel))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(retryTrigger.textContent).toContain(firstModel.id)
    expect(sublistbox().querySelector('[aria-selected="true"]')?.textContent).toContain(firstModel.id)
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
    openModels()
    subRows()[1]?.click()
    expect(subRows().every((row) => row.getAttribute('aria-disabled') === 'true')).toBe(true)
    pendingPicker.render(state({ pending: true }))
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    expect(pendingTrigger.disabled).toBe(true)
    pendingPicker.render(state({ selected: secondModel, label: secondModel.id, pending: false }))
    resolve(true)

    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull())
    expect(pendingTrigger.textContent).toContain(secondModel.id)
    pendingPicker.destroy()
  })

  it('opens the submenu on hover and closes it once the pointer leaves the panel', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const trigger = installTrigger()
    const picker = createModelPicker({ trigger, onSelect: vi.fn(async () => true), onError: vi.fn() })
    picker.render(state())
    trigger.click()
    expect(document.querySelector('#model-submenu-listbox')).toBeNull()

    // React 的 onMouseEnter 是从 mouseover 派生的，relatedTarget 落在行外才算「进入」。
    entry('模型')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    await vi.waitFor(() => expect(document.querySelector('#model-submenu-listbox')).not.toBeNull())
    expect(entry('模型')?.getAttribute('data-open')).toBe('true')

    // 指针离开整个面板才收起；面板之间的缝由延迟兜住。
    document.getElementById('model-picker-popover')?.dispatchEvent(new MouseEvent('mouseleave'))
    await vi.waitFor(() => expect(document.querySelector('#model-submenu-listbox')).toBeNull())
    expect(listbox()).toBeInstanceOf(HTMLElement)
    // 收起子菜单后焦点要留在首层，否则 Esc 没人接。
    expect(document.activeElement).toBe(listbox())
    picker.destroy()
  })

  it('lets the entry menu size to its content instead of pinning a fixed width', () => {
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
    // 宽度交给 CSS 的 max-content，钳制只剩左右各 12px 的边距。
    expect(popover.style.width).toBe('')
    expect(popover.style.left).toBe('12px')
    expect(popover.dataset.placement).toBe('above')
    picker.destroy()
  })
})

describe('model picker entries and thinking levels', () => {
  const OPUS = {
    route: 'anthropic',
    id: 'claude-opus-5-5',
    reasoning: true,
    thinkingLevelMap: { low: 'low', high: 'high' },
  } as const
  // 第一项声明了映射，第三项只声明支持、没给映射（应退回通用四档），第二项完全不支持。
  const reasoning: readonly ModelPickerOption[] = [
    OPUS,
    { route: 'openai', id: 'gpt-5.6' },
    { route: 'deepseek', id: 'deepseek-v4-pro', reasoning: true },
  ]
  const levels = () => subRows().map((row) => row.textContent?.trim())

  function openPicker(
    onSelect: (option: ModelPickerOption) => Promise<boolean>,
    selected?: ModelPickerOption,
  ) {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const trigger = installTrigger()
    const picker = createModelPicker({ trigger, onSelect, onError: vi.fn() })
    picker.render(state({ options: reasoning, ...(selected ? { selected } : {}) }))
    trigger.click()
    return { trigger, picker }
  }

  it('keeps the level entry away until the current model reports reasoning', () => {
    const { picker } = openPicker(vi.fn(async () => true))

    // 目录里没有推理模型时，首层只有「模型」一行；没有选中模型则回落到触发器的标签。
    expect(entryValue('模型')).toBe('选择模型')
    expect(entry('推理等级')).toBeUndefined()
    picker.destroy()
  })

  it('shows the current level on the entry and changes it without touching the model', async () => {
    const onSelect = vi.fn(async () => true)
    const { picker } = openPicker(onSelect, { ...OPUS, thinking: 'low' })

    expect(entryValue('模型')).toBe('claude-opus-5-5')
    expect(entryValue('推理等级')).toBe('Low')

    openLevels()
    expect(levels()).toEqual(['Low', 'High'])
    // 档位子菜单列的是当前模型，所以入口行仍然指着模型那一项。
    expect(entry('模型')?.getAttribute('data-open')).toBeNull()

    subRows()[1]?.click()
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith({ ...OPUS, thinking: 'high' }))
    picker.destroy()
  })

  it('carries the current level onto a model that still supports it', async () => {
    const onSelect = vi.fn(async () => true)
    const { picker } = openPicker(onSelect, { ...OPUS, thinking: 'high' })

    openModels()
    subRows()[2]?.click()
    // deepseek 只声明支持、没给映射，通用档位里包含 high，所以档位跟过去。
    await vi.waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith({
        route: 'deepseek',
        id: 'deepseek-v4-pro',
        reasoning: true,
        thinking: 'high',
      }),
    )
    picker.destroy()
  })

  it('drops the level when the next model cannot reason', async () => {
    const onSelect = vi.fn(async () => true)
    const { picker } = openPicker(onSelect, { ...OPUS, thinking: 'high' })

    openModels()
    subRows()[1]?.click()
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith({ route: 'openai', id: 'gpt-5.6' }))
    picker.destroy()
  })

  it('falls back to the shared four levels when the model reports support without a map', () => {
    const { picker } = openPicker(
      vi.fn(async () => true),
      {
        route: 'deepseek',
        id: 'deepseek-v4-pro',
        reasoning: true,
      },
    )

    openLevels()

    expect(levels()).toEqual(['Off', 'Low', 'Medium', 'High'])
    picker.destroy()
  })

  it('never opens a level submenu for a model that cannot reason', () => {
    const { picker } = openPicker(vi.fn(async () => true))

    // 目录里有推理模型但一个都没选中：档位入口不存在，也就不可能打开档位子菜单。
    expect(entry('推理等级')).toBeUndefined()
    expect(document.querySelector('#model-submenu-listbox')).toBeNull()
    picker.destroy()
  })
})
