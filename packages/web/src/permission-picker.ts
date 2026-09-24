import { bindListboxKeys, positionPopover } from '@agnes/web-admin-frame'

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

  function optionId(index: number): string {
    return `permission-picker-option-${index}`
  }

  function renderOptions(): void {
    if (!popover || !listbox) return
    listbox.replaceChildren()
    listbox.setAttribute('aria-activedescendant', optionId(activeIndex))
    for (const [index, option] of PERMISSION_OPTIONS.entries()) {
      const entry = document.createElement('div')
      entry.id = optionId(index)
      entry.className = 'permission-picker-option'
      entry.setAttribute('role', 'option')
      entry.setAttribute('aria-selected', String(option.id === state.selected))
      entry.dataset.active = String(index === activeIndex)
      entry.addEventListener('click', () => {
        selectingFromPointer = true
        void select(index)
        queueMicrotask(() => {
          selectingFromPointer = false
        })
      })
      const mark = document.createElement('span')
      mark.className = 'permission-picker-check'
      mark.textContent = option.id === state.selected ? '✓' : ''
      const copy = document.createElement('span')
      copy.className = 'permission-picker-copy'
      const title = document.createElement('span')
      title.className = 'permission-picker-label'
      title.textContent = option.label
      const hint = document.createElement('span')
      hint.className = 'permission-picker-hint'
      hint.textContent = option.description
      copy.append(title, hint)
      entry.append(mark, copy)
      listbox.append(entry)
    }
  }

  function position(): void {
    if (!popover) return
    positionPopover(trigger, popover, { preferredWidth: 280, preferredHeight: 220, viewportPadding })
  }

  function close(closeOptions: { returnFocus?: boolean } = {}): void {
    interaction += 1
    selecting = false
    const wasOpen = popover !== undefined
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
    for (const [optionIndex, option] of Array.from(listbox.children).entries())
      (option as HTMLElement).dataset.active = String(optionIndex === activeIndex)
    listbox.setAttribute('aria-activedescendant', optionId(activeIndex))
  }

  async function select(index: number): Promise<void> {
    if (state.disabled || state.pending || selecting) return
    const option = PERMISSION_OPTIONS[index]
    if (!option) return
    const request = ++interaction
    selecting = true
    setTrigger()
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
    popover = document.createElement('section')
    popover.id = 'permission-picker-popover'
    popover.className = 'permission-picker'
    popover.setAttribute('aria-label', '选择本会话权限')
    const nextListbox = document.createElement('div')
    nextListbox.id = 'permission-listbox'
    nextListbox.className = 'permission-picker-list'
    nextListbox.setAttribute('role', 'listbox')
    nextListbox.setAttribute('aria-label', '本会话权限')
    nextListbox.tabIndex = -1
    bindListboxKeys(nextListbox, (intent) => {
      if (intent.kind === 'move') setActive(activeIndex + intent.delta)
      else if (intent.kind === 'first') setActive(0)
      else if (intent.kind === 'last') setActive(PERMISSION_OPTIONS.length - 1)
      else if (intent.kind === 'activate') void select(activeIndex)
      else close({ returnFocus: intent.returnFocus })
    })
    popover.append(nextListbox)
    document.body.append(popover)
    listbox = nextListbox
    trigger.setAttribute('aria-controls', nextListbox.id)
    setTrigger()
    renderOptions()
    setActive(activeIndex)
    position()
    requestAnimationFrame(position)
    nextListbox.focus({ preventScroll: true })
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
