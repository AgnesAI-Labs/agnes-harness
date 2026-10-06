import type { ModelSettings } from '@agnes/protocol'
import * as webUi from '@agnes/web-ui'
import { createElement, type ReactNode } from 'react'
import type { Translate } from './presentation.js'

export type ModelPickerOption = {
  id: string
  route: string
  label?: string
  /** 弹窗取用的档位映射；模型列表本身不展示或修改档位。 */
  thinkingLevelMap?: Record<string, string>
  contextWindow?: number
  defaultSettings?: ModelSettings
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
  t: Translate
  trigger: HTMLButtonElement
}

const viewportPadding = 12
const preferredWidth = 320
const preferredHeight = 416

function sameOption(left: ModelPickerOption | undefined, right: ModelPickerOption | undefined): boolean {
  return left?.route === right?.route && left?.id === right?.id
}

function sameOptions(left: readonly ModelPickerOption[], right: readonly ModelPickerOption[]): boolean {
  return (
    left.length === right.length &&
    left.every((option, index) => sameOption(option, right[index]) && option.label === right[index]?.label)
  )
}

function sameState(left: ModelPickerState, right: ModelPickerState): boolean {
  return (
    left.accessibleName === right.accessibleName &&
    left.disabled === right.disabled &&
    left.label === right.label &&
    left.pending === right.pending &&
    sameOption(left.selected, right.selected) &&
    sameOptions(left.options, right.options)
  )
}

function modelOption(
  idPrefix: string,
  option: ModelPickerOption,
  index: number,
  state: ModelPickerState,
  activeIndex: number,
  selecting: boolean,
  t: Translate,
  onSelect: (index: number) => void,
): ReactNode {
  return createElement(
    'div',
    {
      id: `${idPrefix}-option-${index}`,
      key: `${option.route}:${option.id}`,
      className: 'model-picker-option',
      role: 'option',
      'aria-selected': sameOption(option, state.selected),
      'aria-disabled': state.pending || selecting,
      'data-active': index === activeIndex,
      onClick: () => onSelect(index),
    },
    createElement('span', { className: 'model-picker-model' }, option.id),
    createElement(
      'span',
      { className: 'model-picker-route' },
      option.label ?? t('settings.modelPicker.configuredAccount'),
    ),
  )
}

function modelOptions(
  idPrefix: string,
  state: ModelPickerState,
  activeIndex: number,
  selecting: boolean,
  t: Translate,
  onSelect: (index: number) => void,
): ReactNode[] {
  return state.options.map((option, index) =>
    modelOption(idPrefix, option, index, state, activeIndex, selecting, t, onSelect),
  )
}

// Each picker numbers its own element ids, so two pickers in one document never share one.
let pickers = 0

/** Owns the transient model list while the app retains the confirmed session model. */
export function createModelPicker(options: ModelPickerOptions): ModelPicker {
  const { t, trigger } = options
  const idPrefix = `model-picker-${++pickers}`
  // Popover, outside-click and viewport listeners belong to the trigger's document, not the global one.
  const view = trigger.ownerDocument.defaultView
  let state: ModelPickerState = {
    accessibleName: '',
    disabled: true,
    label: t('settings.modelPicker.select'),
    options: [],
    pending: false,
  }
  let activeIndex = 0
  let interaction = 0
  let selecting = false
  let selectingFromPointer = false
  let popover: HTMLElement | undefined
  let help: HTMLElement | undefined
  let listbox: HTMLElement | undefined

  function isUnavailable(): boolean {
    return state.disabled || state.pending || selecting || state.options.length === 0
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
    const selected = state.options.findIndex((option) => sameOption(option, state.selected))
    return selected >= 0 ? selected : 0
  }

  function activeOptionId(): string {
    return `${idPrefix}-option-${activeIndex}`
  }

  function renderOptions(): void {
    if (!popover || !listbox) return
    activeIndex = Math.min(Math.max(activeIndex, 0), Math.max(state.options.length - 1, 0))
    listbox.setAttribute('aria-busy', String(state.pending || selecting))
    if (state.options.length) listbox.setAttribute('aria-activedescendant', activeOptionId())
    else listbox.removeAttribute('aria-activedescendant')
    if (help) {
      help.hidden = state.selected !== undefined
      help.textContent = t('settings.modelPicker.help')
    }
    webUi.renderRegion(
      listbox,
      modelOptions(idPrefix, state, activeIndex, selecting, t, (index) => {
        selectingFromPointer = true
        void select(index)
        queueMicrotask(() => {
          selectingFromPointer = false
        })
      }),
    )
  }

  function position(): void {
    if (!popover) return
    webUi.positionPopover(trigger, popover, { preferredWidth, preferredHeight, viewportPadding })
  }

  function close(closeOptions: { returnFocus?: boolean } = {}): void {
    interaction += 1
    selecting = false
    const wasOpen = popover !== undefined
    if (help) webUi.unmountRegion(help)
    if (listbox) webUi.unmountRegion(listbox)
    popover?.remove()
    popover = undefined
    help = undefined
    listbox = undefined
    trigger.removeAttribute('aria-controls')
    setTrigger()
    if (wasOpen && closeOptions.returnFocus) trigger.focus({ preventScroll: true })
  }

  function setActive(index: number): void {
    if (!listbox || !state.options.length) return
    activeIndex = (index + state.options.length) % state.options.length
    listbox.setAttribute('aria-activedescendant', activeOptionId())
    renderOptions()
    listbox.querySelector<HTMLElement>(`#${activeOptionId()}`)?.scrollIntoView({ block: 'nearest' })
  }

  async function select(index: number): Promise<void> {
    if (isUnavailable()) return
    const option = state.options[index]
    if (!option) return
    const request = ++interaction
    selecting = true
    setTrigger()
    renderOptions()
    try {
      const accepted = await options.onSelect(option)
      if (request !== interaction) return
      if (accepted) close({ returnFocus: trigger.ownerDocument.activeElement === listbox })
    } catch (error) {
      if (request === interaction) options.onError(error)
    } finally {
      if (request === interaction && popover) {
        selecting = false
        setTrigger()
        renderOptions()
      }
    }
  }

  function open(initialIndex = selectedIndex()): void {
    if (popover || isUnavailable()) return
    interaction += 1
    activeIndex = Math.min(Math.max(initialIndex, 0), Math.max(state.options.length - 1, 0))
    popover = webUi.createRegionHost(trigger.ownerDocument.body, 'section', 'model-picker')
    popover.id = idPrefix
    popover.setAttribute('aria-label', t('settings.modelPicker.aria'))
    help = webUi.createRegionHost(popover, 'p', 'model-picker-help')
    help.dataset.modelPickerHelp = ''
    listbox = webUi.createRegionHost(popover, 'div', 'model-picker-list')
    listbox.id = `${idPrefix}-listbox`
    listbox.setAttribute('role', 'listbox')
    listbox.setAttribute('aria-label', t('settings.modelPicker.listAria'))
    listbox.tabIndex = -1
    webUi.bindListboxKeys(listbox, (intent) => {
      if (intent.kind === 'move') setActive(activeIndex + intent.delta)
      else if (intent.kind === 'first') setActive(0)
      else if (intent.kind === 'last') setActive(state.options.length - 1)
      else if (intent.kind === 'activate') void select(activeIndex)
      else close({ returnFocus: intent.returnFocus })
    })
    trigger.setAttribute('aria-controls', listbox.id)
    setTrigger()
    renderOptions()
    setActive(activeIndex)
    position()
    view?.requestAnimationFrame(position)
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
    const target = event.target
    if (!(target instanceof Node) || popover.contains(target) || trigger.contains(target)) return
    close()
  }

  trigger.addEventListener('click', toggle)
  trigger.addEventListener('keydown', triggerKeydown)
  trigger.ownerDocument.addEventListener('click', closeOutside)
  view?.addEventListener('resize', position)
  trigger.ownerDocument.addEventListener('scroll', position, true)

  return {
    close,
    destroy: () => {
      close()
      trigger.removeEventListener('click', toggle)
      trigger.removeEventListener('keydown', triggerKeydown)
      trigger.ownerDocument.removeEventListener('click', closeOutside)
      view?.removeEventListener('resize', position)
      trigger.ownerDocument.removeEventListener('scroll', position, true)
    },
    render: (nextState) => {
      const normalized: ModelPickerState = { ...nextState, options: [...nextState.options] }
      const changed = !sameState(state, normalized)
      state = normalized
      if (state.disabled && popover) close()
      else {
        setTrigger()
        if (changed && popover) {
          renderOptions()
          position()
        }
      }
    },
  }
}
