import * as webUi from '@agnes/web-ui'
import { createElement, type ReactNode } from 'react'
import type { Translate } from './presentation.js'

export type PermissionMode = 'view' | 'workspace' | 'full'

export type PermissionOption = {
  id: PermissionMode
  label: string
  description: string
}

const PERMISSION_OPTION_LABEL_KEYS: Record<PermissionMode, string> = {
  view: 'settings.picker.view',
  workspace: 'settings.picker.workspace',
  full: 'settings.picker.full',
}

const PERMISSION_OPTION_DESCRIPTION_KEYS: Record<PermissionMode, string> = {
  view: 'settings.picker.viewDescription',
  workspace: 'settings.picker.workspaceDescription',
  full: 'settings.picker.fullDescription',
}

/** 静态 id 行：label/description 渲染时经注入的 translate 取词，不在模块加载期写死。 */
export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  {
    id: 'view',
    label: PERMISSION_OPTION_LABEL_KEYS.view,
    description: PERMISSION_OPTION_DESCRIPTION_KEYS.view,
  },
  {
    id: 'workspace',
    label: PERMISSION_OPTION_LABEL_KEYS.workspace,
    description: PERMISSION_OPTION_DESCRIPTION_KEYS.workspace,
  },
  {
    id: 'full',
    label: PERMISSION_OPTION_LABEL_KEYS.full,
    description: PERMISSION_OPTION_DESCRIPTION_KEYS.full,
  },
]

export function permissionLabel(mode: PermissionMode | null, t: Translate): string {
  if (mode === null) return t('settings.picker.choosePermission')
  return t(PERMISSION_OPTION_LABEL_KEYS[mode] ?? PERMISSION_OPTION_LABEL_KEYS.workspace)
}

export function yoloEnabled(mode: PermissionMode): boolean {
  return mode === 'full'
}

export type PermissionPickerState = {
  disabled: boolean
  pending: boolean
  selected: PermissionMode | null
}

export type PermissionPicker = {
  close(): void
  destroy(): void
  render(state: PermissionPickerState): void
}

const viewportPadding = 12

function permissionOption(
  option: PermissionOption,
  index: number,
  state: PermissionPickerState,
  activeIndex: number,
  onSelect: (index: number) => void,
): ReactNode {
  return createElement(
    'div',
    {
      id: `permission-picker-option-${index}`,
      key: option.id,
      className: 'permission-picker-option',
      role: 'option',
      'aria-selected': option.id === state.selected,
      'aria-disabled': state.pending,
      'data-active': index === activeIndex,
      onClick: () => onSelect(index),
    },
    createElement('span', { className: 'permission-picker-check' }, option.id === state.selected ? '✓' : ''),
    createElement(
      'span',
      { className: 'permission-picker-copy' },
      createElement('span', { className: 'permission-picker-label' }, option.label),
      createElement('span', { className: 'permission-picker-hint' }, option.description),
    ),
  )
}

function permissionOptions(
  state: PermissionPickerState,
  activeIndex: number,
  t: Translate,
  onSelect: (index: number) => void,
): ReactNode[] {
  return PERMISSION_OPTIONS.map((option, index) =>
    permissionOption(
      {
        ...option,
        label: t(PERMISSION_OPTION_LABEL_KEYS[option.id]),
        description: t(PERMISSION_OPTION_DESCRIPTION_KEYS[option.id]),
      },
      index,
      state,
      activeIndex,
      onSelect,
    ),
  )
}

export function createPermissionPicker(options: {
  onError(error: unknown): void
  onSelect(mode: PermissionMode): Promise<boolean>
  t: Translate
  trigger: HTMLButtonElement
}): PermissionPicker {
  const { t, trigger } = options
  // Popover, outside-click and viewport listeners belong to the trigger's document, not the global one.
  const view = trigger.ownerDocument.defaultView
  let state: PermissionPickerState = { disabled: true, pending: false, selected: 'workspace' }
  let activeIndex = 1
  let interaction = 0
  let selecting = false
  let selectingFromPointer = false
  let popover: HTMLElement | undefined
  let listbox: HTMLElement | undefined

  function selectedIndex(): number {
    const index = PERMISSION_OPTIONS.findIndex((option) => option.id === state.selected)
    return index >= 0 ? index : 1
  }

  function setTrigger(): void {
    trigger.disabled = state.disabled || state.pending || selecting
    trigger.setAttribute('aria-expanded', String(popover !== undefined))
    trigger.setAttribute('aria-busy', String(state.pending || selecting))
    trigger.title = permissionLabel(state.selected, t)
    const label = trigger.querySelector<HTMLElement>('[data-permission-label]')
    if (label) label.textContent = permissionLabel(state.selected, t)
  }

  function renderOptions(): void {
    if (!listbox) return
    listbox.setAttribute('aria-activedescendant', `permission-picker-option-${activeIndex}`)
    listbox.setAttribute('aria-busy', String(state.pending || selecting))
    webUi.renderRegion(
      listbox,
      permissionOptions(state, activeIndex, t, (index) => {
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
    webUi.positionPopover(trigger, popover, { preferredWidth: 360, preferredHeight: 220, viewportPadding })
  }

  function close(closeOptions: { returnFocus?: boolean } = {}): void {
    interaction += 1
    selecting = false
    const wasOpen = popover !== undefined
    if (listbox) webUi.unmountRegion(listbox)
    popover?.remove()
    popover = undefined
    listbox = undefined
    trigger.removeAttribute('aria-controls')
    setTrigger()
    if (wasOpen && closeOptions.returnFocus) trigger.focus({ preventScroll: true })
  }

  function setActive(index: number): void {
    if (!listbox) return
    activeIndex = (index + PERMISSION_OPTIONS.length) % PERMISSION_OPTIONS.length
    listbox.setAttribute('aria-activedescendant', `permission-picker-option-${activeIndex}`)
    renderOptions()
  }

  async function select(index: number): Promise<void> {
    if (state.disabled || state.pending || selecting) return
    const option = PERMISSION_OPTIONS[index]
    if (!option) return
    const request = ++interaction
    selecting = true
    setTrigger()
    renderOptions()
    try {
      const accepted = await options.onSelect(option.id)
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

  function open(): void {
    if (popover || state.disabled || state.pending || selecting) return
    interaction += 1
    activeIndex = selectedIndex()
    popover = webUi.createRegionHost(trigger.ownerDocument.body, 'section', 'permission-picker')
    popover.id = 'permission-picker-popover'
    popover.setAttribute('aria-label', t('settings.picker.aria'))
    listbox = webUi.createRegionHost(popover, 'div', 'permission-picker-list')
    listbox.id = 'permission-listbox'
    listbox.setAttribute('role', 'listbox')
    listbox.setAttribute('aria-label', t('settings.picker.listAria'))
    listbox.tabIndex = -1
    webUi.bindListboxKeys(listbox, (intent) => {
      if (intent.kind === 'move') setActive(activeIndex + intent.delta)
      else if (intent.kind === 'first') setActive(0)
      else if (intent.kind === 'last') setActive(PERMISSION_OPTIONS.length - 1)
      else if (intent.kind === 'activate') void select(activeIndex)
      else close({ returnFocus: intent.returnFocus })
    })
    trigger.setAttribute('aria-controls', listbox.id)
    setTrigger()
    renderOptions()
    position()
    view?.requestAnimationFrame(position)
    listbox.focus({ preventScroll: true })
  }

  function closeOutside(event: MouseEvent): void {
    if (!popover || selectingFromPointer) return
    const path = event.composedPath()
    if (path.includes(popover) || path.includes(trigger)) return
    close()
  }

  function triggerKeydown(event: KeyboardEvent): void {
    if (state.disabled || state.pending) return
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open()
    }
  }

  const toggle = () => {
    if (popover) close()
    else open()
  }
  trigger.addEventListener('click', toggle)
  trigger.addEventListener('keydown', triggerKeydown)
  trigger.ownerDocument.addEventListener('click', closeOutside)
  view?.addEventListener('resize', position)

  return {
    close,
    destroy: () => {
      close()
      trigger.removeEventListener('click', toggle)
      trigger.removeEventListener('keydown', triggerKeydown)
      trigger.ownerDocument.removeEventListener('click', closeOutside)
      view?.removeEventListener('resize', position)
    },
    render(next) {
      state = next
      setTrigger()
      if (popover) renderOptions()
    },
  }
}
