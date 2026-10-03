import type { ModelSettings, ThinkingLevel } from '@agnes/protocol'
import * as webUi from '@agnes/web-ui'
import { createElement, type ReactNode } from 'react'
import { tr } from './locale-bridge.js'
import { thinkingLevelLabel } from './presentation.js'

export type ModelPickerOption = {
  id: string
  route: string
  label?: string
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string>
  contextWindow?: number
  defaultSettings?: ModelSettings
  thinking?: ThinkingLevel
}

export type ModelPickerState = {
  accessibleName: string
  disabled: boolean
  label: string
  options: readonly ModelPickerOption[]
  pending: boolean
  selected?: ModelPickerOption
}

export type ModelPicker = {
  close(options?: { returnFocus?: boolean }): void
  destroy(): void
  render(state: ModelPickerState): void
}

type ModelPickerOptions = {
  onError(error: unknown): void
  onSelect(option: ModelPickerOption): Promise<boolean>
  trigger: HTMLButtonElement
}

/** 首层入口菜单里的两行。 */
type Entry = 'model' | 'thinking'

const viewportPadding = 12
const preferredWidth = 320
const listWidth = 280
const preferredHeight = 416

/** 悬停展开前的停顿：横扫过菜单时不该把沿途每一项都展开一遍。 */
const HOVER_OPEN_MS = 90
/** 离开根面板到进入子菜单之间有一个 4px 的缝，收起要留出这段时间。 */
const HOVER_CLOSE_MS = 220

/** 模型没报映射时的通用档位，与 CLI 侧 THINKING_FALLBACK 同口径。 */
const THINKING_FALLBACK: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high']

const CHEVRON_PATH = 'm9 6 6 6-6 6'

function thinkingLevels(option: ModelPickerOption): readonly ThinkingLevel[] {
  const map = option.thinkingLevelMap
  return map && Object.keys(map).length > 0 ? (Object.keys(map) as ThinkingLevel[]) : THINKING_FALLBACK
}

/** 同一个模型：route + id。选中态还额外比档位，所以两者分开。 */
function sameModel(left: ModelPickerOption | undefined, right: ModelPickerOption | undefined): boolean {
  return left?.route === right?.route && left?.id === right?.id
}

function sameSelection(left: ModelPickerOption | undefined, right: ModelPickerOption | undefined): boolean {
  return sameModel(left, right) && left?.thinking === right?.thinking
}

function sameLevelMap(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const a = Object.keys(left ?? {})
  const b = Object.keys(right ?? {})
  return a.length === b.length && a.every((key) => left?.[key] === right?.[key])
}

function sameOptions(left: readonly ModelPickerOption[], right: readonly ModelPickerOption[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (option, index) =>
        sameModel(option, right[index]) &&
        option.label === right[index]?.label &&
        option.reasoning === right[index]?.reasoning &&
        sameLevelMap(option.thinkingLevelMap, right[index]?.thinkingLevelMap),
    )
  )
}

function sameState(left: ModelPickerState, right: ModelPickerState): boolean {
  return (
    left.accessibleName === right.accessibleName &&
    left.disabled === right.disabled &&
    left.label === right.label &&
    left.pending === right.pending &&
    sameSelection(left.selected, right.selected) &&
    sameOptions(left.options, right.options)
  )
}

type RowProps = {
  active: boolean
  index: number
  onSelect: (index: number) => void
  selected: boolean
  selecting: boolean
  state: ModelPickerState
}

/** 子菜单里的行。首层入口行长得不一样，走 entryRow。 */
function row(props: RowProps, key: string, primary: string, secondary: ReactNode): ReactNode {
  const { active, index, onSelect, selected, selecting, state } = props
  return createElement(
    'div',
    {
      id: `model-submenu-option-${index}`,
      key,
      className: 'model-picker-option',
      role: 'option',
      'aria-selected': selected,
      'aria-disabled': state.pending || selecting,
      'data-active': active,
      onClick: () => onSelect(index),
    },
    createElement('span', { className: 'model-picker-model' }, primary),
    secondary,
  )
}

function modelRows(
  state: ModelPickerState,
  activeIndex: number,
  selecting: boolean,
  onSelect: (index: number) => void,
): ReactNode[] {
  return state.options.map((option, index) =>
    row(
      {
        active: index === activeIndex,
        index,
        onSelect,
        selected: sameModel(option, state.selected),
        selecting,
        state,
      },
      `${option.route}:${option.id}`,
      option.id,
      createElement(
        'span',
        { className: 'model-picker-route' },
        option.label ?? tr('settings.modelPicker.configuredAccount'),
      ),
    ),
  )
}

/** 推理档位列表。provider 取值与档位同名时不再重复显示。 */
function levelRows(
  option: ModelPickerOption,
  state: ModelPickerState,
  activeIndex: number,
  selecting: boolean,
  onSelect: (index: number) => void,
): ReactNode[] {
  const current = sameModel(option, state.selected) ? state.selected?.thinking : undefined
  return thinkingLevels(option).map((level, index) => {
    const mapped = option.thinkingLevelMap?.[level]
    return row(
      {
        active: index === activeIndex,
        index,
        onSelect,
        selected: level === current,
        selecting,
        state,
      },
      level,
      thinkingLevelLabel(level),
      mapped && mapped !== level ? createElement('span', { className: 'model-picker-route' }, mapped) : null,
    )
  })
}

/** 首层入口行：左边名称、右边当前值、末尾一个进入箭头。 */
function entryRow(props: {
  active: boolean
  entry: Entry
  index: number
  label: string
  onHover: (index: number) => void
  onSelect: (index: number) => void
  open: boolean
  state: ModelPickerState
  value: string
}): ReactNode {
  const { active, entry, index, label, onHover, onSelect, open, state, value } = props
  return createElement(
    'div',
    {
      id: `model-picker-option-${index}`,
      key: entry,
      className: 'model-picker-option model-picker-entry',
      role: 'option',
      'aria-selected': false,
      'aria-disabled': state.pending,
      'aria-expanded': open,
      'data-active': active,
      // 只在打开时落这个属性：React 会把布尔 false 写成 data-open="false" 留在 DOM 上。
      ...(open ? { 'data-open': true } : {}),
      onClick: () => onSelect(index),
      onMouseEnter: () => onHover(index),
    },
    createElement('span', { className: 'model-picker-entry-label' }, label),
    createElement('span', { className: 'model-picker-entry-value' }, value),
    createElement(
      'svg',
      { className: 'model-picker-chevron', viewBox: '0 0 24 24', 'aria-hidden': true },
      createElement('path', { d: CHEVRON_PATH }),
    ),
  )
}

/** Owns the transient model list while the app retains the confirmed session model. */
export function createModelPicker(options: ModelPickerOptions): ModelPicker {
  const { trigger } = options
  let state: ModelPickerState = {
    accessibleName: '',
    disabled: true,
    label: tr('settings.modelPicker.select'),
    options: [],
    pending: false,
  }
  // 首层是常驻的入口菜单，二级列表在它右侧另开一个浮层（子菜单），而不是顶替首层内容。
  let openEntry: Entry | undefined
  let thinkingFor: ModelPickerOption | undefined
  let rootIndex = 0
  let subIndex = 0
  let interaction = 0
  let selecting = false
  let selectingFromPointer = false
  let popover: HTMLElement | undefined
  let listbox: HTMLElement | undefined
  let submenu: HTMLElement | undefined
  let subhelp: HTMLElement | undefined
  let sublist: HTMLElement | undefined
  let hoverOpen: ReturnType<typeof setTimeout> | undefined
  let hoverClose: ReturnType<typeof setTimeout> | undefined

  function clearTimers(): void {
    if (hoverOpen !== undefined) clearTimeout(hoverOpen)
    if (hoverClose !== undefined) clearTimeout(hoverClose)
    hoverOpen = undefined
    hoverClose = undefined
  }

  /**
   * 悬停展开：指针停在某项上才展开，扫过不算。键盘路径不走这里——方向键只移动活动行，
   * 每移一格就弹一个面板反而没法用，展开仍然交给 Enter。
   */
  function scheduleOpen(entry: Entry): void {
    if (selecting || openEntry === entry) return
    clearTimers()
    hoverOpen = setTimeout(() => {
      hoverOpen = undefined
      if (popover && !selecting) openSubmenu(entry)
    }, HOVER_OPEN_MS)
  }

  /** 指针离开两个面板才收起，且留一点时间跨过它们之间的缝。 */
  function scheduleClose(): void {
    if (!openEntry || selecting) return
    if (hoverClose !== undefined) clearTimeout(hoverClose)
    hoverClose = setTimeout(() => {
      hoverClose = undefined
      closeSubmenu()
    }, HOVER_CLOSE_MS)
  }

  function isUnavailable(): boolean {
    return state.disabled || state.pending || selecting || state.options.length === 0
  }

  /** 当前生效模型在目录里的那一条；只有它才知道这个模型支不支持思考。 */
  function currentModelOption(): ModelPickerOption | undefined {
    const selected = state.selected
    return selected ? state.options.find((option) => sameModel(option, selected)) : undefined
  }

  function hasLevelEntry(): boolean {
    return currentModelOption()?.reasoning === true
  }

  function rootCount(): number {
    return hasLevelEntry() ? 2 : 1
  }

  function subCount(): number {
    if (openEntry === 'thinking' && thinkingFor) return thinkingLevels(thinkingFor).length
    return state.options.length
  }

  function setTrigger(): void {
    trigger.disabled = isUnavailable()
    trigger.setAttribute('aria-expanded', String(popover !== undefined))
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-label', state.accessibleName)
    trigger.title = state.accessibleName
    trigger.setAttribute('aria-busy', String(state.pending || selecting))
    const label = trigger.querySelector<HTMLElement>('[data-model-label]')
    if (label) label.textContent = state.label
    else trigger.textContent = state.label
  }

  function selectedIndex(): number {
    const selected = state.options.findIndex((option) => sameModel(option, state.selected))
    return selected >= 0 ? selected : 0
  }

  function pointerSelect(onSelect: (index: number) => void): (index: number) => void {
    return (index) => {
      selectingFromPointer = true
      onSelect(index)
      queueMicrotask(() => {
        selectingFromPointer = false
      })
    }
  }

  function renderRoot(): void {
    if (!listbox) return
    rootIndex = Math.max(0, Math.min(rootIndex, rootCount() - 1))
    listbox.setAttribute('aria-activedescendant', `model-picker-option-${rootIndex}`)
    // 入口行只是开合子菜单，不发起选择，所以不走 pointerSelect 的抑制标记：
    // 否则紧接着的一次外部点击会被当成「选中那一项的那次点击」而忽略掉。
    const entryOf = (index: number): Entry => (index === 0 ? 'model' : 'thinking')
    // 点已展开的那一行不做事：鼠标用户是「悬停展开、顺手点一下」过来的，
    // 这时把它收起来正好和预期相反。收起交给移出面板或 Esc。
    const onSelect = (index: number) => {
      const entry = entryOf(index)
      if (openEntry !== entry) openSubmenu(entry)
    }
    const onHover = (index: number) => scheduleOpen(entryOf(index))
    const rows: ReactNode[] = [
      entryRow({
        active: rootIndex === 0,
        entry: 'model',
        index: 0,
        label: tr('settings.modelPicker.modelEntry'),
        onHover,
        onSelect,
        open: openEntry === 'model',
        state,
        value: state.selected?.id ?? state.label,
      }),
    ]
    if (hasLevelEntry())
      rows.push(
        entryRow({
          active: rootIndex === 1,
          entry: 'thinking',
          index: 1,
          label: tr('settings.picker.reasoningLevels'),
          onHover,
          onSelect,
          open: openEntry === 'thinking',
          state,
          value: state.selected?.thinking
            ? thinkingLevelLabel(state.selected.thinking)
            : tr('settings.picker.thinkingDefault'),
        }),
      )
    webUi.renderRegion(listbox, rows)
  }

  function renderSubmenu(): void {
    if (!submenu || !sublist || !openEntry) return
    const count = subCount()
    subIndex = Math.max(0, Math.min(subIndex, count - 1))
    sublist.setAttribute('aria-busy', String(state.pending || selecting))
    sublist.setAttribute(
      'aria-label',
      openEntry === 'thinking' ? tr('settings.picker.reasoningLevels') : tr('settings.modelPicker.listAria'),
    )
    sublist.setAttribute('aria-activedescendant', `model-submenu-option-${subIndex}`)
    if (subhelp) {
      subhelp.hidden = false
      subhelp.textContent =
        openEntry === 'thinking'
          ? tr('settings.picker.reasoningFor', { id: thinkingFor?.id ?? '' })
          : tr('settings.modelPicker.help')
    }
    const onSelect = pointerSelect((index) => void choose(index))
    webUi.renderRegion(
      sublist,
      openEntry === 'thinking' && thinkingFor
        ? levelRows(thinkingFor, state, subIndex, selecting, onSelect)
        : modelRows(state, subIndex, selecting, onSelect),
    )
  }

  function position(): void {
    if (popover)
      webUi.positionPopover(trigger, popover, {
        preferredWidth,
        preferredHeight,
        viewportPadding,
        width: 'content',
      })
    const anchor = popover?.querySelector<HTMLElement>(`#model-picker-option-${rootIndex}`)
    if (submenu && popover && anchor)
      webUi.positionSubmenu(anchor, popover, submenu, {
        preferredWidth: listWidth,
        preferredHeight,
        viewportPadding,
      })
  }

  function closeSubmenu(): void {
    if (hoverOpen !== undefined) clearTimeout(hoverOpen)
    if (hoverClose !== undefined) clearTimeout(hoverClose)
    hoverOpen = undefined
    hoverClose = undefined
    // 焦点在子菜单里的话要交还给首层，否则元素一删焦点就掉到 body，Esc 从此没人接。
    const hadFocus = sublist?.contains(document.activeElement) === true
    if (subhelp) webUi.unmountRegion(subhelp)
    if (sublist) webUi.unmountRegion(sublist)
    submenu?.remove()
    submenu = undefined
    subhelp = undefined
    sublist = undefined
    openEntry = undefined
    thinkingFor = undefined
    renderRoot()
    if (hadFocus) listbox?.focus({ preventScroll: true })
  }

  /** 推理等级只对当前模型有意义，所以档位子菜单列的是目录里那一条。 */
  function openSubmenu(entry: Entry): void {
    rootIndex = entry === 'model' ? 0 : 1
    const option = currentModelOption()
    if (entry === 'thinking' && !option?.reasoning) return
    closeSubmenu()
    openEntry = entry
    thinkingFor = entry === 'thinking' ? option : undefined
    subIndex =
      entry === 'thinking'
        ? Math.max(
            thinkingLevels(option as ModelPickerOption).indexOf(
              (sameModel(option, state.selected) ? state.selected?.thinking : undefined) ?? 'off',
            ),
            0,
          )
        : selectedIndex()
    submenu = webUi.createRegionHost(document.body, 'section', 'model-picker')
    submenu.id = 'model-submenu-popover'
    submenu.setAttribute(
      'aria-label',
      entry === 'thinking' ? tr('settings.picker.reasoningLevels') : tr('settings.modelPicker.listAria'),
    )
    subhelp = webUi.createRegionHost(submenu, 'p', 'model-picker-help')
    subhelp.dataset.modelPickerHelp = ''
    sublist = webUi.createRegionHost(submenu, 'div', 'model-picker-list')
    sublist.id = 'model-submenu-listbox'
    sublist.setAttribute('role', 'listbox')
    sublist.tabIndex = -1
    sublist.addEventListener('keydown', onSubmenuEscape, true)
    // 指针进到子菜单就取消收起——从入口行斜着移过来会先经过根面板的 mouseleave。
    submenu.addEventListener('mouseenter', clearTimers)
    submenu.addEventListener('mouseleave', scheduleClose)
    webUi.bindListboxKeys(sublist, (intent) => {
      if (intent.kind === 'move') setSubIndex(subIndex + intent.delta)
      else if (intent.kind === 'first') setSubIndex(0)
      else if (intent.kind === 'last') setSubIndex(subCount() - 1)
      else if (intent.kind === 'activate') void choose(subIndex)
      else close({ returnFocus: intent.returnFocus })
    })
    renderRoot()
    // setSubIndex 顺带把活动行滚进视野——长模型列表里默认选中的那一项可能在视口外。
    setSubIndex(subIndex)
    position()
    requestAnimationFrame(position)
    sublist.focus({ preventScroll: true })
  }

  function setSubIndex(index: number): void {
    const count = subCount()
    if (!count || !sublist) return
    subIndex = ((index % count) + count) % count
    renderSubmenu()
    sublist.querySelector<HTMLElement>(`#model-submenu-option-${subIndex}`)?.scrollIntoView({
      block: 'nearest',
    })
  }

  function close(closeOptions: { returnFocus?: boolean } = {}): void {
    interaction += 1
    selecting = false
    closeSubmenu()
    clearTimers()
    const wasOpen = popover !== undefined
    if (listbox) webUi.unmountRegion(listbox)
    popover?.remove()
    popover = undefined
    listbox = undefined
    trigger.removeAttribute('aria-controls')
    setTrigger()
    if (wasOpen && closeOptions.returnFocus) trigger.focus({ preventScroll: true })
  }

  async function commit(option: ModelPickerOption): Promise<void> {
    const request = ++interaction
    selecting = true
    setTrigger()
    renderSubmenu()
    try {
      const accepted = await options.onSelect(option)
      if (request !== interaction) return
      if (accepted) close({ returnFocus: document.activeElement === sublist })
    } catch (error) {
      if (request === interaction) options.onError(error)
    } finally {
      if (request === interaction && submenu) {
        selecting = false
        setTrigger()
        renderSubmenu()
      }
    }
  }

  /** 换模型时把当前档位带过去（只在新模型确实支持这一档时），否则每换一次模型都会把
   *  用户设好的推理等级清掉，而入口菜单那一行只是静静地变回「默认」。 */
  function modelChoice(option: ModelPickerOption): ModelPickerOption {
    const current = state.selected?.thinking
    if (!option.reasoning || !current) return option
    return thinkingLevels(option).includes(current) ? { ...option, thinking: current } : option
  }

  async function choose(index: number): Promise<void> {
    if (isUnavailable()) return
    if (openEntry === 'thinking') {
      const option = thinkingFor
      const level = option ? thinkingLevels(option)[index] : undefined
      if (!option || !level) return
      await commit({ ...option, thinking: level })
      return
    }
    const option = state.options[index]
    if (option) await commit(modelChoice(option))
  }

  function onRootEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !openEntry) return
    event.preventDefault()
    event.stopPropagation()
    closeSubmenu()
  }

  /** 子菜单的 Esc 是「收起子菜单」；捕获阶段拦下，别落到 listbox 的键表上。 */
  function onSubmenuEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeSubmenu()
    listbox?.focus({ preventScroll: true })
  }

  function open(): void {
    if (popover || isUnavailable()) return
    interaction += 1
    popover = webUi.createRegionHost(document.body, 'section', 'model-picker')
    popover.id = 'model-picker-popover'
    popover.setAttribute('aria-label', tr('settings.modelPicker.aria'))
    listbox = webUi.createRegionHost(popover, 'div', 'model-picker-list')
    listbox.id = 'model-listbox'
    listbox.setAttribute('role', 'listbox')
    listbox.setAttribute('aria-label', tr('settings.picker.modelAndReasoning'))
    listbox.setAttribute('aria-label', tr('settings.picker.modelAndReasoning'))
    listbox.tabIndex = -1
    // 指针回到根面板就取消收起：从子菜单移回来同样会先触发子菜单的 mouseleave。
    popover.addEventListener('mouseenter', clearTimers)
    popover.addEventListener('mouseleave', scheduleClose)
    // 焦点还在首层时按 Esc，先收子菜单——和焦点在子菜单里按 Esc 的结果保持一致。
    popover.addEventListener('keydown', onRootEscape, true)
    webUi.bindListboxKeys(listbox, (intent) => {
      if (intent.kind === 'move') setRootIndex(rootIndex + intent.delta)
      else if (intent.kind === 'first') setRootIndex(0)
      else if (intent.kind === 'last') setRootIndex(rootCount() - 1)
      else if (intent.kind === 'activate') openSubmenu(rootIndex === 0 ? 'model' : 'thinking')
      else close({ returnFocus: intent.returnFocus })
    })
    trigger.setAttribute('aria-controls', listbox.id)
    setTrigger()
    rootIndex = 0
    renderRoot()
    position()
    requestAnimationFrame(position)
    listbox.focus({ preventScroll: true })
  }

  function setRootIndex(index: number): void {
    const count = rootCount()
    if (!count || !listbox) return
    rootIndex = ((index % count) + count) % count
    renderRoot()
    listbox.querySelector<HTMLElement>(`#model-picker-option-${rootIndex}`)?.scrollIntoView({
      block: 'nearest',
    })
  }

  function toggle(): void {
    if (popover) close()
    else open()
  }

  function triggerKeydown(event: KeyboardEvent): void {
    if (isUnavailable()) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      open()
    }
  }

  function closeOutside(event: MouseEvent): void {
    if (!popover || selectingFromPointer) return
    const path = event.composedPath()
    if (path.includes(popover) || path.includes(trigger)) return
    if (submenu && path.includes(submenu)) return
    const target = event.target
    if (!(target instanceof Node) || popover.contains(target) || trigger.contains(target)) return
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
      state = normalized
      if (state.disabled && popover) close()
      else {
        setTrigger()
        if (changed && popover) {
          renderRoot()
          if (submenu) renderSubmenu()
          position()
        }
      }
    },
  }
}
