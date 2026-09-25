import { bindListboxKeys, positionPopover } from '@agnes/web-ui'
import { createRegionHost, renderRegion, unmountRegion } from '@agnes/web-ui'
import { createElement, type ReactNode } from 'react'

export type PermissionMode = 'view' | 'workspace' | 'full'

export type PermissionOption = {
  id: PermissionMode
  label: string
  description: string
}

export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { id: 'view', label: '仅可查看', description: '本会话弹出的命令审批一律拒绝' },
  { id: 'workspace', label: '工作区内修改', description: '工作区读写按默认策略；跑命令仍要审批' },
  { id: 'full', label: '完全权限', description: '本会话跳过其余审批' },
]

export function permissionLabel(mode: PermissionMode): string {
  return PERMISSION_OPTIONS.find((option) => option.id === mode)?.label ?? '工作区内修改'
}

export function yoloEnabled(mode: PermissionMode): boolean {
  return mode === 'full'
}

export type PermissionPickerState = {
  disabled: boolean
  pending: boolean
  selected: PermissionMode
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
  onSelect: (index: number) => void,
): ReactNode[] {
  return PERMISSION_OPTIONS.map((option, index) =>
    permissionOption(option, index, state, activeIndex, onSelect),
  )
}

export function createPermissionPicker(options: {
  onError(error: unknown): void
  onSelect(mode: PermissionMode): Promise<boolean>
  trigger: HTMLButtonElement
}): PermissionPicker {
  const { trigger } = options
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
    trigger.title = permissionLabel(state.selected)
    const label = trigger.querySelector<HTMLElement>('[data-permission-label]')
    if (label) label.textContent = permissionLabel(state.selected)
  }

  function renderOptions(): void {
    if (!listbox) return
    listbox.setAttribute('aria-activedescendant', `permission-picker-option-${activeIndex}`)
    listbox.setAttribute('aria-busy', String(state.pending || selecting))
    renderRegion(
      listbox,
      permissionOptions(state, activeIndex, (index) => {
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
    positionPopover(trigger, popover, { preferredWidth: 280, preferredHeight: 220, viewportPadding })
  }

  function close(closeOptions: { returnFocus?: boolean } = {}): void {
    interaction += 1
    selecting = false
    const wasOpen = popover !== undefined
    if (listbox) unmountRegion(listbox)
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
      if (accepted) close({ returnFocus: document.activeElement === listbox })
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
    popover = createRegionHost(document.body, 'section', 'permission-picker')
    popover.id = 'permission-picker-popover'
    popover.setAttribute('aria-label', '选择本会话权限')
    listbox = createRegionHost(popover, 'div', 'permission-picker-list')
    listbox.id = 'permission-listbox'
    listbox.setAttribute('role', 'listbox')
    listbox.setAttribute('aria-label', '本会话权限')
    listbox.tabIndex = -1
    bindListboxKeys(listbox, (intent) => {
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
    requestAnimationFrame(position)
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
  document.addEventListener('click', closeOutside)
  window.addEventListener('resize', position)

  return {
    close,
    destroy: () => {
      close()
      trigger.removeEventListener('click', toggle)
      trigger.removeEventListener('keydown', triggerKeydown)
      document.removeEventListener('click', closeOutside)
      window.removeEventListener('resize', position)
    },
    render(next) {
      state = next
      setTrigger()
      if (popover) renderOptions()
    },
  }
}
