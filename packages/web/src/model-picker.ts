import { type ModelSettings, minimumContextBudget, type ThinkingLevel } from '@agnes/protocol'
import { tr } from '@agnes/web-foundation/locale-bridge'
import * as webUi from '@agnes/web-ui'
import { type ChangeEvent, createElement, type FocusEvent } from 'react'
import { detailRow, levelOption, modelOptions } from './model-picker/menu.js'
import { sameOption, sameSettings, sameState } from './model-picker/state.js'
import type { DetailValues, ModelPicker, ModelPickerOptions, ModelPickerState } from './model-picker/types.js'

export type {
  ModelPicker,
  ModelPickerOption,
  ModelPickerSettings,
  ModelPickerState,
} from './model-picker/types.js'

const viewportPadding = 12
const listWidth = 320
const listHeight = 416
const submenuWidth = 280
/** 鼠标离开列表与子菜单后延时收起子菜单，留出从行走到子菜单那段空隙的时间。 */
const hoverCloseDelay = 240

/**
 * Owns the transient model list while the app retains the confirmed session model.
 *
 * 三级级联：模型列表 → 该模型的详情（模型容量 / 思考强度 / 上下文窗口）→ 单个参数的选项。
 * 选模型即切换并展开它的详情；详情里的档位与预算改动经 `onSettingsChange` 立即提交，
 * 选完一个值就收起整条菜单，没有模态对话框和「应用」按钮。
 */
export function createModelPicker(options: ModelPickerOptions): ModelPicker {
  const { trigger } = options
  let state: ModelPickerState = {
    accessibleName: '',
    disabled: true,
    label: tr('settings.modelPicker.select'),
    options: [],
    pending: false,
  }
  let activeIndex = 0
  let detailActive = 0
  let leafActive = 0
  let openedIndex: number | undefined
  let leafKind: 'thinking' | 'budget' | undefined
  let budgetDraft = ''
  /** 已提交成功的预算草稿：回车提交过之后失焦还会再触发一次，用它挡掉重复提交。 */
  let committedBudget = ''
  let interaction = 0
  let selecting = false
  let selectingFromPointer = false
  let popover: HTMLElement | undefined
  let help: HTMLElement | undefined
  let listbox: HTMLElement | undefined
  let detailPanel: HTMLElement | undefined
  let leafPanel: HTMLElement | undefined
  /** 输入框节点由 React 区域产出，每次渲染后重新取回，用于聚焦与按键归属判断。 */
  let budgetInput: HTMLInputElement | undefined
  let hoverCloseTimer: number | undefined

  function isUnavailable(): boolean {
    return state.disabled || state.pending || selecting || state.options.length === 0
  }

  function busy(): boolean {
    return state.pending || selecting
  }

  /**
   * 详情面板显示哪一套值：当前会话模型读会话设置，其他模型预览它自己的默认值
   * （正是切过去会得到的值，取自同一个 `modelDefaults` 来源）。
   */
  function detailValues(): DetailValues | undefined {
    const option = openedIndex === undefined ? undefined : state.options[openedIndex]
    if (!option) return undefined
    if (sameOption(option, state.selected) && state.settings) {
      const settings = state.settings
      return {
        option,
        current: true,
        capacity: settings.capacity,
        ...(settings.contextWindow === undefined ? {} : { contextWindow: settings.contextWindow }),
        ...(settings.thinking ? { thinking: settings.thinking } : {}),
        ...(settings.thinkingLevelMap ? { thinkingLevelMap: settings.thinkingLevelMap } : {}),
      }
    }
    if (option.contextWindow === undefined) return undefined
    const defaults = option.defaultSettings
    return {
      option,
      current: false,
      capacity: option.contextWindow,
      contextWindow: defaults?.contextWindow ?? option.contextWindow,
      ...(defaults?.thinking ? { thinking: defaults.thinking } : {}),
      ...(option.thinkingLevelMap ? { thinkingLevelMap: option.thinkingLevelMap } : {}),
    }
  }

  /** 悬停与键盘都能展开的前提：宿主有设置提交口，且这个模型报得出容量。 */
  function canShowDetail(index: number): boolean {
    if (options.onSettingsChange === undefined) return false
    const option = state.options[index]
    if (!option) return false
    if (sameOption(option, state.selected) && state.settings) return true
    return option.contextWindow !== undefined
  }

  function settingsAvailable(): boolean {
    return detailValues() !== undefined
  }

  function setTrigger(): void {
    trigger.disabled = isUnavailable()
    trigger.setAttribute('aria-expanded', String(popover !== undefined))
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-label', state.accessibleName)
    trigger.title = state.accessibleName
    trigger.setAttribute('aria-busy', String(busy()))
    const label = trigger.querySelector<HTMLElement>('[data-model-label]')
    if (label) label.textContent = state.label
    else trigger.textContent = state.label
  }

  function levels(): Array<{ label: string; value: string }> {
    const map = detailValues()?.thinkingLevelMap
    return map ? webUi.modelThinkingOptions(map, tr) : []
  }

  /** 详情里只有「思考强度」一行时，档位映射得真的声明了档位。 */
  function hasThinkingRow(): boolean {
    return settingsAvailable() && levels().length > 1
  }

  /** 已保存的档位若不在当前模型声明的范围内，返回它以便就地告知用户。 */
  function unavailableThinking(): string | undefined {
    const saved = detailValues()?.thinking
    if (!saved) return undefined
    return levels().some((option) => option.value === saved) ? undefined : saved
  }

  /** 这一档当前值；不可用时返回 undefined，让列表里谁都不选中。 */
  function selectedThinking(): string | undefined {
    return unavailableThinking() ? undefined : (detailValues()?.thinking ?? '')
  }

  /** 详情行右侧只写档位名；选项列表里带原始取值（「高 · high」）也带「（Provider 默认）」，这里都收短。 */
  function thinkingLabel(): string {
    const option = levels().find((entry) => entry.value === selectedThinking())
    return option?.value ? option.label.replace(/ · .*$/, '') : tr('modelSettings.presetAuto')
  }

  function budgetLabel(): string {
    const saved = detailValues()?.contextWindow
    return saved === undefined ? tr('modelSettings.presetAuto') : webUi.contextBudgetLabel(saved)
  }

  function selectedIndex(): number {
    const selected = state.options.findIndex((option) => sameOption(option, state.selected))
    return selected >= 0 ? selected : 0
  }

  function activeOptionId(): string {
    return `model-picker-option-${activeIndex}`
  }

  // ---------------------------------------------------------------- rendering

  function renderList(): void {
    if (!listbox) return
    activeIndex = Math.min(Math.max(activeIndex, 0), Math.max(state.options.length - 1, 0))
    listbox.setAttribute('aria-busy', String(busy()))
    if (state.options.length) listbox.setAttribute('aria-activedescendant', activeOptionId())
    else listbox.removeAttribute('aria-activedescendant')
    if (help) {
      help.hidden = state.selected !== undefined
      help.textContent = tr('settings.modelPicker.help')
    }
    webUi.renderRegion(
      listbox,
      modelOptions(
        state,
        activeIndex,
        openedIndex,
        selecting,
        (index) => {
          selectingFromPointer = true
          void select(index)
          queueMicrotask(() => {
            selectingFromPointer = false
          })
        },
        (index) => {
          if (isUnavailable() || openedIndex === index) return
          // 与键盘路径（setActive）对齐：这一行没有详情可展开时把上一个模型的详情收掉，
          // 否则旧面板会留在屏幕上、锚在别的行旁边。
          if (canShowDetail(index)) openDetail(index, { focus: false })
          else closeDetail()
        },
      ),
    )
  }

  function detailRows(): Array<{ id: string; kind: 'thinking' | 'budget' }> {
    const rows: Array<{ id: string; kind: 'thinking' | 'budget' }> = []
    if (hasThinkingRow()) rows.push({ id: 'model-detail-thinking', kind: 'thinking' })
    if (settingsAvailable()) rows.push({ id: 'model-detail-budget', kind: 'budget' })
    return rows
  }

  function renderDetail(): void {
    const values = detailValues()
    if (!detailPanel || !values) return
    const rows = detailRows()
    detailActive = Math.min(Math.max(detailActive, 0), Math.max(rows.length - 1, 0))
    const saved = unavailableThinking()
    webUi.renderRegion(detailPanel, [
      createElement('p', { key: 'title', className: 'model-picker-detail-title' }, values.option.id),
      // 模型容量只读，对应参考里「消耗速度 0.89x倍率」那一行的位置。
      detailRow({
        id: 'model-detail-capacity',
        label: tr('modelSettings.capacityLabel'),
        value: webUi.contextBudgetLabel(values.capacity),
        active: false,
        nested: false,
        // 移到只读行上说明不在挑参数了，收起第三级。
        onHover: () => closeLeaf(),
      }),
      ...rows.map((row, index) =>
        detailRow({
          id: row.id,
          label:
            row.kind === 'thinking' ? tr('modelSettings.thinkingLabel') : tr('modelSettings.windowLabel'),
          value: row.kind === 'thinking' ? thinkingLabel() : budgetLabel(),
          active: index === detailActive,
          nested: true,
          onOpen: () => openLeaf(row.kind),
          // 悬停同样展开这一项的候选项，鼠标在两行之间移动时直接换第三级。
          onHover: () => openLeaf(row.kind, { focus: false }),
        }),
      ),
      createElement(
        'p',
        {
          key: 'notice',
          className: 'model-picker-notice',
          hidden: saved === undefined,
        },
        saved === undefined ? '' : tr('modelSettings.savedThinkingUnavailable', { value: saved }),
      ),
    ])
  }

  function budgetCheck(): { tokens?: number; valid: boolean; message: string } {
    const values = detailValues()
    if (!values) return { valid: true, message: '' }
    const raw = budgetDraft.trim()
    if (raw === '') return { valid: true, message: '' }
    const tokens = webUi.parseContextBudget(raw)
    const minimum = minimumContextBudget(values.capacity)
    if (tokens === undefined || tokens < minimum || tokens > values.capacity)
      return {
        valid: false,
        message: tr('modelSettings.windowRange', {
          min: minimum.toLocaleString('en-US'),
          max: values.capacity.toLocaleString('en-US'),
        }),
      }
    return { tokens, valid: true, message: '' }
  }

  function renderLeaf(): void {
    const values = detailValues()
    if (!leafPanel || !values || !leafKind) return
    const busyNow = busy()
    const capacity = values.capacity.toLocaleString('en-US')
    budgetInput = undefined
    if (leafKind === 'thinking') {
      const list = levels()
      const selected = selectedThinking()
      leafActive = Math.min(Math.max(leafActive, 0), Math.max(list.length - 1, 0))
      webUi.renderRegion(leafPanel, [
        createElement(
          'div',
          {
            key: 'levels',
            id: 'session-model-thinking',
            className: 'model-picker-list',
            role: 'listbox',
            tabIndex: -1,
            'aria-label': tr('modelSettings.thinkingLabel'),
            'aria-activedescendant': `model-level-option-${leafActive}`,
          },
          list.map((option, index) =>
            levelOption(
              option,
              index,
              index === leafActive,
              selected !== undefined && option.value === selected,
              busyNow,
              () => void applyThinking(option.value),
            ),
          ),
        ),
      ])
      return
    }
    const presets: Array<{ label: string; value: string }> = [
      { label: tr('modelSettings.presetAuto'), value: '' },
      ...webUi.contextBudgetPresets(values.capacity).map((preset) => ({
        label: webUi.contextBudgetLabel(preset),
        value: String(preset),
      })),
    ]
    const check = budgetCheck()
    const selected = budgetDraft.trim() === '' ? '' : check.valid ? String(check.tokens) : undefined
    leafActive = Math.min(Math.max(leafActive, 0), Math.max(presets.length - 1, 0))
    webUi.renderRegion(leafPanel, [
      createElement(
        'div',
        {
          key: 'presets',
          id: 'session-model-budget',
          className: 'model-picker-list',
          role: 'listbox',
          tabIndex: -1,
          'aria-label': tr('modelSettings.windowLabel'),
          'aria-activedescendant': `model-level-option-${leafActive}`,
        },
        presets.map((option, index) =>
          levelOption(
            option,
            index,
            index === leafActive,
            selected !== undefined && option.value === selected,
            busyNow,
            () => void applyBudget(option.value),
          ),
        ),
      ),
      createElement(webUi.SettingsInput, {
        key: 'custom',
        id: 'session-model-window',
        className: 'model-picker-budget',
        type: 'text',
        maxLength: 32,
        autoComplete: 'off',
        value: budgetDraft,
        disabled: state.disabled || busyNow,
        placeholder: tr('modelSettings.windowPlaceholder', { tokens: capacity }),
        'aria-label': tr('modelSettings.customAria'),
        'aria-invalid': String(!check.valid),
        'aria-describedby': 'session-model-window-hint session-model-settings-error',
        // 逐字符提交会让每次按键都发一次 setModel；回车或离开输入框才算一次确定输入。
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          budgetDraft = event.currentTarget.value
          renderLeaf()
        },
        onBlur: (event: FocusEvent<HTMLInputElement>) => {
          // 焦点在菜单内的控件之间移动时交给那个控件处理，别在这里抢先发一次。详情面板的行
          // 也算菜单内（比如输完预算再点「思考强度」），漏判会把那次点击连人带面板一起吃掉。
          const focusTarget = event.relatedTarget as Node | null
          if (leafPanel?.contains(focusTarget) || detailPanel?.contains(focusTarget)) return
          void applyBudget(budgetDraft)
        },
      }),
      createElement(
        'p',
        { key: 'hint', id: 'session-model-window-hint', className: 'model-picker-hint' },
        tr('modelSettings.windowHint', { tokens: capacity }),
      ),
      createElement(
        'p',
        {
          key: 'error',
          id: 'session-model-settings-error',
          className: 'model-picker-error',
          role: 'alert',
        },
        check.valid ? '' : check.message,
      ),
    ])
    budgetInput = leafPanel.querySelector<HTMLInputElement>('#session-model-window') ?? undefined
  }

  function renderPanels(): void {
    renderList()
    renderDetail()
    renderLeaf()
  }

  function resetBudgetDraft(): void {
    const saved = detailValues()?.contextWindow
    budgetDraft = saved === undefined ? '' : String(saved)
    committedBudget = budgetDraft.trim()
  }

  // ---------------------------------------------------------------- chain

  function position(): void {
    if (!popover) return
    // 模型名长度差得远，宽度交给内容定（CSS 里的 min/max 兜住两端），钉死会在右侧留一片空白。
    webUi.positionPopover(trigger, popover, {
      preferredWidth: listWidth,
      preferredHeight: listHeight,
      viewportPadding,
      width: 'content',
    })
    const anchor =
      openedIndex === undefined
        ? undefined
        : listbox?.querySelector<HTMLElement>(`#model-picker-option-${openedIndex}`)
    // 子菜单的高度上限就是视口本身：内容该多高就多高，放不下时由 positionSubmenu 整体上移。
    // 这里若给一个比内容小的数，面板会被截断，底下几行看着像没有了。
    if (detailPanel && anchor)
      webUi.positionSubmenu(anchor, popover, detailPanel, {
        preferredWidth: submenuWidth,
        preferredHeight: window.innerHeight,
        viewportPadding,
      })
    const rowId = leafKind === 'thinking' ? 'model-detail-thinking' : 'model-detail-budget'
    const rowAnchor = detailPanel?.querySelector<HTMLElement>(`#${rowId}`)
    if (leafPanel && detailPanel && rowAnchor)
      webUi.positionSubmenu(rowAnchor, detailPanel, leafPanel, {
        preferredWidth: submenuWidth,
        preferredHeight: window.innerHeight,
        viewportPadding,
      })
  }

  /** 悬停或键盘展开某个模型的详情；鼠标从列表移到详情的那段空隙靠延时关闭兜住。 */
  function openDetail(index: number, options2: { focus?: boolean } = {}): void {
    cancelDetailClose()
    if (!popover || !canShowDetail(index)) return
    if (detailPanel && openedIndex === index) return
    closeLeaf()
    openedIndex = index
    detailActive = 0
    resetBudgetDraft()
    // 换模型时复用同一个宿主，只换内容，免得旧面板留在屏幕上。
    if (!detailPanel) {
      detailPanel = webUi.createRegionHost(document.body, 'section', 'model-picker')
      detailPanel.id = 'model-settings-popover'
      detailPanel.setAttribute('aria-label', tr('modelSettings.detailAria'))
      detailPanel.addEventListener('keydown', detailKeydown)
      detailPanel.addEventListener('mouseenter', cancelDetailClose)
      detailPanel.addEventListener('mouseleave', scheduleDetailClose)
    }
    renderList()
    renderDetail()
    position()
    if (options2.focus !== false) focusDetail()
  }

  /** 鼠标离开列表与详情后收起二级（给移进详情留出时间），一级保持打开。 */
  function scheduleDetailClose(): void {
    if (hoverCloseTimer !== undefined || !detailPanel) return
    hoverCloseTimer = window.setTimeout(() => {
      hoverCloseTimer = undefined
      closeLeaf(false)
      closeDetail()
    }, hoverCloseDelay)
  }

  function cancelDetailClose(): void {
    if (hoverCloseTimer === undefined) return
    window.clearTimeout(hoverCloseTimer)
    hoverCloseTimer = undefined
  }

  function openLeaf(kind: 'thinking' | 'budget', options2: { focus?: boolean } = {}): void {
    if (!detailPanel) return
    cancelDetailClose()
    // 悬停会连续触发同一行，已经开着就不再重画一遍。
    if (leafPanel && leafKind === kind) return
    leafKind = kind
    leafActive =
      kind === 'thinking'
        ? Math.max(
            0,
            levels().findIndex((o) => o.value === selectedThinking()),
          )
        : 0
    if (kind === 'budget') {
      resetBudgetDraft()
      leafActive = Math.max(
        0,
        ['']
          .concat(webUi.contextBudgetPresets(detailValues()?.capacity ?? 0).map(String))
          .indexOf(budgetDraft.trim()),
      )
    }
    if (!leafPanel) {
      // 第三级第一个元素就是列表，顶部要和行圆角相称，所以借 submenu 类多留一点间距。
      leafPanel = webUi.createRegionHost(document.body, 'section', 'model-picker model-picker-submenu')
      leafPanel.id = 'model-settings-options-popover'
      leafPanel.addEventListener('keydown', leafKeydown)
      leafPanel.addEventListener('mouseenter', cancelDetailClose)
      leafPanel.addEventListener('mouseleave', scheduleDetailClose)
    }
    leafPanel.setAttribute(
      'aria-label',
      kind === 'thinking' ? tr('modelSettings.thinkingLabel') : tr('modelSettings.windowLabel'),
    )
    renderLeaf()
    position()
    // 内容刚挂上时量到的高度偶尔偏小（首帧还没排完版），下一帧按真实高度再摆一次。
    requestAnimationFrame(position)
    // 鼠标悬停展开时不抢焦点，键盘那一路才需要把焦点移进来。
    if (options2.focus !== false) focusLeaf()
  }

  function closeLeaf(reposition = true): void {
    if (!leafPanel) return
    leafPanel.remove()
    leafPanel = undefined
    leafKind = undefined
    budgetInput = undefined
    if (reposition) position()
  }

  function closeDetail(): void {
    closeLeaf(false)
    if (!detailPanel) return
    detailPanel.remove()
    detailPanel = undefined
    openedIndex = undefined
    renderList()
  }

  function backToDetail(): void {
    if (leafPanel) {
      closeLeaf()
      focusDetail()
      return
    }
    closeDetail()
    listbox?.focus({ preventScroll: true })
  }

  function close(closeOptions: { returnFocus?: boolean } = {}): void {
    interaction += 1
    selecting = false
    cancelDetailClose()
    const wasOpen = popover !== undefined
    closeLeaf(false)
    closeDetail()
    if (help) webUi.unmountRegion(help)
    if (listbox) webUi.unmountRegion(listbox)
    popover?.remove()
    popover = undefined
    help = undefined
    listbox = undefined
    budgetDraft = ''
    committedBudget = ''
    trigger.removeAttribute('aria-controls')
    setTrigger()
    if (wasOpen && closeOptions.returnFocus) trigger.focus({ preventScroll: true })
  }

  function focusDetail(): void {
    renderDetail()
    const row = detailRows()[detailActive]
    if (row) detailPanel?.querySelector<HTMLElement>(`#${row.id}`)?.focus({ preventScroll: true })
  }

  function focusLeaf(): void {
    renderLeaf()
    leafPanel?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true })
  }

  // ---------------------------------------------------------------- actions

  function setActive(index: number): void {
    if (!listbox || !state.options.length) return
    activeIndex = (index + state.options.length) % state.options.length
    listbox.setAttribute('aria-activedescendant', activeOptionId())
    renderList()
    listbox.querySelector<HTMLElement>(`#${activeOptionId()}`)?.scrollIntoView({ block: 'nearest' })
    // 详情开着时跟着高亮走，键盘和鼠标看到的是同一行。
    if (!detailPanel) return
    if (canShowDetail(activeIndex)) openDetail(activeIndex, { focus: false })
    else closeDetail()
  }

  function setDetailActive(index: number): void {
    const rows = detailRows()
    if (!rows.length) return
    detailActive = (index + rows.length) % rows.length
    focusDetail()
  }

  function setLeafActive(index: number): void {
    // 渲染列表取的是详情里那个模型的容量（renderLeaf 的 values.capacity），键盘的循环边界
    // 必须来自同一个地方，否则悬停别的模型时末尾几档永远轮不到。
    const count =
      leafKind === 'thinking'
        ? levels().length
        : 1 + webUi.contextBudgetPresets(detailValues()?.capacity ?? 0).length
    if (!count) return
    leafActive = (index + count) % count
    const list = leafPanel?.querySelector<HTMLElement>('[role="listbox"]')
    list?.setAttribute('aria-activedescendant', `model-level-option-${leafActive}`)
    renderLeaf()
    list
      ?.querySelector<HTMLElement>(`#model-level-option-${leafActive}`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  /** 面板内的完整草稿：档位与预算一起给，避免只改一项把另一项重置。 */
  function draftSettings(thinking: string): ModelSettings | undefined {
    if (!detailValues() || !budgetCheck().valid) return undefined
    const tokens = budgetDraft.trim() === '' ? undefined : webUi.parseContextBudget(budgetDraft)
    return {
      ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
      ...(tokens === undefined ? {} : { contextWindow: tokens }),
    }
  }

  /**
   * 提交面板里的改动。悬停看的是别的模型时，先切过去再提交——
   * `session.setModel` 的落点是当前会话模型，不先切就改到旧模型上了。
   */
  async function commitSettings(next: ModelSettings): Promise<boolean> {
    const values = detailValues()
    if (!values) return false
    if (!values.current && !(await select(state.options.indexOf(values.option)))) return false
    return applySettings(next)
  }

  async function applySettings(next: ModelSettings): Promise<boolean> {
    const change = options.onSettingsChange
    if (!change || state.disabled || busy()) return false
    const request = ++interaction
    selecting = true
    setTrigger()
    renderPanels()
    try {
      return await change(next)
    } catch (error) {
      if (request === interaction) options.onError(error)
      return false
    } finally {
      if (request === interaction && popover) {
        selecting = false
        setTrigger()
        renderPanels()
      }
    }
  }

  // 预算非法时先让面板把错误显示出来，而不是悄悄按旧值提交。
  async function applyThinking(value: string): Promise<void> {
    if (
      value === selectedThinking() &&
      budgetDraft.trim() === committedBudget &&
      detailValues()?.current === true
    ) {
      close({ returnFocus: true })
      return
    }
    const next = draftSettings(value)
    if (!next) {
      renderLeaf()
      return
    }
    if (await commitSettings(next)) close({ returnFocus: true })
  }

  async function applyBudget(raw: string): Promise<void> {
    // committedBudget 记的是提交给当前模型的值；预览别的模型时它只是那个模型的默认值，
    // 相等并不表示用户没做改动——选中它就该先切过去，所以短路只对当前模型成立。
    if (raw.trim() === committedBudget && detailValues()?.current === true) {
      close({ returnFocus: true })
      return
    }
    budgetDraft = raw
    // 已保存的档位不可用时按空档提交，等于让用户借这次改动把它归位到「自动」。
    const next = draftSettings(selectedThinking() ?? '')
    if (!next) {
      renderLeaf()
      return
    }
    if (await commitSettings(next)) {
      committedBudget = raw.trim()
      close({ returnFocus: true })
    }
  }

  async function select(index: number): Promise<boolean> {
    if (isUnavailable()) return false
    const option = state.options[index]
    if (!option) return false
    // 点当前模型这一行只是要看它的设置，不必再发一次同样的 setModel。
    if (sameOption(option, state.selected) && settingsAvailable()) {
      openDetail(index)
      return true
    }
    const request = ++interaction
    selecting = true
    setTrigger()
    renderPanels()
    try {
      const accepted = await options.onSelect(option)
      if (request !== interaction) return false
      // 换模型后详情要按新模型的设置重画，所以先等 onSelect 落地再展开。
      if (accepted) {
        if (canShowDetail(index)) openDetail(index)
        else close({ returnFocus: true })
      }
      return accepted
    } catch (error) {
      if (request === interaction) options.onError(error)
      return false
    } finally {
      if (request === interaction && popover) {
        selecting = false
        setTrigger()
        renderPanels()
      }
    }
  }

  // ---------------------------------------------------------------- keyboard

  function dismissOrBack(event: KeyboardEvent, back: () => void): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      close({ returnFocus: true })
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      back()
      return
    }
    // Tab 收起整条菜单，把焦点交回触发按钮，浏览器从那里继续 Tab。
    if (event.key === 'Tab') {
      event.preventDefault()
      close({ returnFocus: true })
    }
  }

  function listKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : state.options.length - 1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight') {
      event.preventDefault()
      void select(activeIndex)
      return
    }
    dismissOrBack(event, () => {})
  }

  function detailKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return
    const rows = detailRows()
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setDetailActive(detailActive + (event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight') {
      const row = rows[detailActive]
      if (!row) return
      event.preventDefault()
      openLeaf(row.kind)
      return
    }
    dismissOrBack(event, backToDetail)
  }

  function leafKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return
    // 自定义预算的输入框里，方向键归光标，只接管回车 / Esc / Tab。
    if (event.target === budgetInput) {
      if (event.key === 'Enter') {
        event.preventDefault()
        void applyBudget(budgetInput?.value ?? '')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close({ returnFocus: true })
      } else if (event.key === 'Tab') {
        event.preventDefault()
        leafPanel?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true })
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setLeafActive(leafActive + (event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (leafKind === 'thinking') void applyThinking(levels()[leafActive]?.value ?? '')
      else
        void applyBudget(
          leafActive === 0
            ? ''
            : String(webUi.contextBudgetPresets(state.settings?.capacity ?? 0)[leafActive - 1] ?? ''),
        )
      return
    }
    if (event.key === 'Tab' && leafKind === 'budget') {
      // 预设列表和自定义输入框在同一级里来回走。
      event.preventDefault()
      budgetInput?.focus({ preventScroll: true })
      return
    }
    dismissOrBack(event, backToDetail)
  }

  // ---------------------------------------------------------------- lifecycle

  function open(initialIndex = selectedIndex()): void {
    if (popover || isUnavailable()) return
    interaction += 1
    activeIndex = Math.min(Math.max(initialIndex, 0), Math.max(state.options.length - 1, 0))
    openedIndex = undefined
    resetBudgetDraft()
    popover = webUi.createRegionHost(document.body, 'section', 'model-picker')
    popover.id = 'model-picker-popover'
    popover.setAttribute('aria-label', tr('settings.modelPicker.aria'))
    help = webUi.createRegionHost(popover, 'p', 'model-picker-help')
    help.dataset.modelPickerHelp = ''
    listbox = webUi.createRegionHost(popover, 'div', 'model-picker-list model-picker-models')
    listbox.id = 'model-listbox'
    listbox.setAttribute('role', 'listbox')
    listbox.setAttribute('aria-label', tr('settings.modelPicker.listAria'))
    listbox.tabIndex = -1
    listbox.addEventListener('keydown', listKeydown)
    popover.addEventListener('mouseenter', cancelDetailClose)
    popover.addEventListener('mouseleave', scheduleDetailClose)
    trigger.setAttribute('aria-controls', listbox.id)
    setTrigger()
    renderList()
    setActive(activeIndex)
    position()
    requestAnimationFrame(position)
    listbox.focus({ preventScroll: true })
  }

  function toggle(): void {
    if (popover) close()
    else open()
  }

  function triggerKeydown(event: KeyboardEvent): void {
    if (isUnavailable()) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      open(selectedIndex())
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      open(state.options.length - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      open(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      open(state.options.length - 1)
    }
  }

  function closeOutside(event: MouseEvent): void {
    if (!popover || selectingFromPointer) return
    const path = event.composedPath()
    if (path.includes(popover) || path.includes(trigger)) return
    if (detailPanel && path.includes(detailPanel)) return
    if (leafPanel && path.includes(leafPanel)) return
    const target = event.target
    if (!(target instanceof Node)) return
    if (popover.contains(target) || trigger.contains(target)) return
    if (detailPanel?.contains(target) || leafPanel?.contains(target)) return
    close()
  }

  trigger.addEventListener('click', toggle)
  trigger.addEventListener('keydown', triggerKeydown)
  document.addEventListener('click', closeOutside)
  window.addEventListener('resize', position)
  document.addEventListener('scroll', position, true)

  return {
    close,
    destroy: () => {
      close()
      trigger.removeEventListener('click', toggle)
      trigger.removeEventListener('keydown', triggerKeydown)
      document.removeEventListener('click', closeOutside)
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
    },
    render: (nextState) => {
      const normalized: ModelPickerState = { ...nextState, options: [...nextState.options] }
      const changed = !sameState(state, normalized)
      const settingsChanged = !sameSettings(state.settings, normalized.settings)
      state = normalized
      if (state.disabled && popover) close()
      else if (popover) {
        setTrigger()
        if (settingsChanged) resetBudgetDraft()
        // 详情依赖会话设置，模型换了或设置没了就收起下一级。
        if (openedIndex !== undefined && !settingsAvailable()) closeDetail()
        if ((changed || settingsChanged) && popover) {
          renderPanels()
          position()
        }
      } else setTrigger()
    },
  }
}
