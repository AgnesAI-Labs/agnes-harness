import { fallbackT, type Translate } from './locales/index.js'
import { getOverlayContainer } from './overlay-policy.js'
import { listboxIntent, positionPopover } from './popover.js'

const optionLabel = (item: HTMLOptionElement): string => item.getAttribute('label') || item.textContent || ''

export type SelectPicker = { sync(): void; close(): void; destroy(): void }
export type SelectPickerOptions = {
  label: string
  includeEmpty?: boolean
  formatOption?: (label: string) => string
  /** Locale-bound translate for the empty-selection placeholder; defaults to a readable fallback. */
  translate?: Translate
}

/** Presentation only. Call sync after programmatic value/options/disabled changes, destroy on unmount. */
export function createSelectPicker(select: HTMLSelectElement, options: SelectPickerOptions): SelectPicker {
  const doc = select.ownerDocument
  const view = doc.defaultView
  const trigger = doc.createElement('button')
  trigger.type = 'button'
  trigger.id = `${select.id}-trigger`
  trigger.className = 'select-picker-trigger'
  trigger.setAttribute('role', 'combobox')
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  const label = doc.createElement('span')
  label.className = 'select-picker-value'
  const arrow = doc.createElement('span')
  arrow.className = 'select-picker-chevron'
  arrow.setAttribute('aria-hidden', 'true')
  trigger.append(label, arrow)
  const wasHidden = select.hidden
  select.hidden = true
  select.after(trigger)
  const field = select.closest('label')
  const originalFor = field?.getAttribute('for')
  if (field) field.htmlFor = trigger.id
  let panel: HTMLElement | undefined
  let choices: HTMLOptionElement[] = []
  let active = 0
  let typed = ''
  let typedAt = 0
  let syncedState = ''
  let syncedValue: string | undefined
  let anchor: DOMRect | undefined
  let openedAt = 0
  const available = (item: HTMLOptionElement) =>
    (options.includeEmpty !== false || !!item.value) &&
    !item.hidden &&
    !item.disabled &&
    !item.closest('optgroup')?.disabled &&
    !item.closest('optgroup')?.hidden

  function close(): void {
    panel?.remove()
    panel = undefined
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-controls')
    trigger.removeAttribute('aria-activedescendant')
    doc.removeEventListener('pointerdown', outside, true)
    doc.removeEventListener('scroll', onScroll, true)
    view?.removeEventListener('resize', close)
  }

  function sync(): void {
    const state = JSON.stringify([
      select.disabled,
      select.getAttribute('aria-invalid'),
      select.getAttribute('aria-readonly'),
      select.getAttribute('aria-describedby'),
      Array.from(select.options).map((item) => {
        const group = item.closest('optgroup')
        return [item.value, optionLabel(item), item.selected, available(item), group?.label]
      }),
    ])
    if (state === syncedState) return
    syncedState = state
    // A late read can replace the options while the menu is open. Keep it open and current when
    // the value stayed; a programmatic value change still closes it.
    const reopen = !!panel && select.value === syncedValue && !select.disabled
    syncedValue = select.value
    close()
    const selected = select.options[select.selectedIndex]
    const selectedLabel = selected ? optionLabel(selected) : undefined
    const text = selectedLabel
      ? (options.formatOption?.(selectedLabel) ?? selectedLabel)
      : (options.translate ?? fallbackT)('settings.selectPicker.fallback', { label: options.label })
    label.textContent = text
    trigger.title = text
    // The separator between label and current value varies by locale (a fullwidth colon in Chinese), so use the catalog.
    trigger.setAttribute(
      'aria-label',
      (options.translate ?? fallbackT)('settings.selectPicker.ariaJoin', {
        label: options.label,
        value: text,
      }),
    )
    const invalid = select.getAttribute('aria-invalid') === 'true' || !!selected?.disabled
    trigger.setAttribute('aria-invalid', String(invalid))
    trigger.setAttribute('aria-readonly', select.getAttribute('aria-readonly') ?? 'false')
    const description = select.getAttribute('aria-describedby')
    if (description) trigger.setAttribute('aria-describedby', description)
    else trigger.removeAttribute('aria-describedby')
    trigger.disabled = select.disabled || !Array.from(select.options).some(available)
    if (reopen) open()
  }

  function outside(event: Event): void {
    const path = event.composedPath()
    if (!path.includes(trigger) && (!panel || !path.includes(panel))) close()
  }

  function onScroll(event: Event): void {
    if (!panel || event.composedPath().includes(panel)) return
    const next = trigger.getBoundingClientRect()
    // Focus/scroll-into-view can queue a trusted scroll before this popup existed. Re-anchor
    // when that event arrives late; only a new external scroll should dismiss the new popup.
    if (event.isTrusted && event.timeStamp < openedAt) {
      if (next.top !== anchor?.top || next.left !== anchor?.left) placePanel()
      return
    }
    // Scroll anchoring can settle fractional layout after focus. Keep the original
    // anchor so cumulative movement still dismisses, but subpixel jitter does not.
    if (anchor && (Math.abs(next.top - anchor.top) >= 1 || Math.abs(next.left - anchor.left) >= 1)) close()
  }

  function placePanel(): void {
    if (!panel) return
    positionPopover(trigger, panel, {
      preferredWidth: Math.max(trigger.getBoundingClientRect().width, 300),
      preferredHeight: 360,
      gap: 6,
    })
    const bottom = trigger.getBoundingClientRect().bottom + 6
    if (view && view.innerHeight - bottom - 12 >= panel.getBoundingClientRect().height) {
      panel.style.top = `${bottom}px`
      panel.dataset.placement = 'below'
    }
    anchor = trigger.getBoundingClientRect()
  }

  function highlight(index: number): void {
    active = Math.max(0, Math.min(index, choices.length - 1))
    const rows = panel?.querySelectorAll<HTMLElement>('[role="option"]')
    rows?.forEach((row, i) => {
      row.dataset.active = String(i === active)
    })
    const row = rows?.[active]
    if (!row) return
    trigger.setAttribute('aria-activedescendant', row.id)
    // Scroll only this menu. scrollIntoView can also scroll the containing dialog and dismiss it.
    if (panel) {
      const bottom = row.offsetTop + row.offsetHeight
      if (row.offsetTop < panel.scrollTop) panel.scrollTop = row.offsetTop
      else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight
    }
  }

  function choose(index: number): void {
    const choice = choices[index]
    if (!choice || select.disabled) return
    const changed = select.value !== choice.value
    select.value = choice.value
    close()
    sync()
    trigger.focus({ preventScroll: true })
    // Use the select's own realm (including embedded settings/test documents).
    if (changed && view) select.dispatchEvent(new view.Event('change', { bubbles: true }))
  }

  function open(): void {
    if (trigger.disabled || select.getAttribute('aria-readonly') === 'true' || panel) return
    choices = Array.from(select.options).filter(available)
    if (!choices.length) return
    openedAt = view?.performance.now() ?? 0
    typed = ''
    panel = doc.createElement('div')
    panel.id = `${select.id}-listbox`
    panel.className = 'select-picker-panel'
    panel.setAttribute('role', 'listbox')
    panel.setAttribute('aria-label', options.label)
    // Keep focus on the combobox while pointer selection delivers its click.
    panel.addEventListener('mousedown', (event) => event.preventDefault())
    let previousGroup: Element | null | undefined
    let container = panel
    for (const [index, choice] of choices.entries()) {
      const group = choice.closest('optgroup')
      if (group !== previousGroup) {
        previousGroup = group
        container = panel
        if (group) {
          container = doc.createElement('div')
          container.className = 'select-picker-group'
          container.setAttribute('role', 'group')
          const heading = doc.createElement('div')
          heading.id = `${panel.id}-group-${index}`
          heading.className = 'select-picker-heading'
          heading.textContent = group.label
          container.setAttribute('aria-labelledby', heading.id)
          container.append(heading)
          panel.append(container)
        }
      }
      const row = doc.createElement('div')
      row.id = `${panel.id}-${index}`
      row.className = 'select-picker-option'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(choice.selected))
      const copy = doc.createElement('span')
      copy.textContent = options.formatOption?.(optionLabel(choice)) ?? optionLabel(choice)
      const check = doc.createElement('span')
      check.className = 'select-picker-check'
      check.setAttribute('aria-hidden', 'true')
      check.textContent = choice.selected ? '✓' : ''
      row.append(copy, check)
      row.addEventListener('click', () => choose(index))
      container.append(row)
    }
    // Keep the popup in the modal's subtree; native popover escapes its scroll clipping.
    getOverlayContainer(trigger, doc).append(panel)
    if (typeof panel.showPopover === 'function') {
      panel.setAttribute('popover', 'manual')
      panel.showPopover()
    }
    // The shared picker defaults upward (composer). In a form, prefer below when it fits.
    placePanel()
    trigger.setAttribute('aria-expanded', 'true')
    trigger.setAttribute('aria-controls', panel.id)
    highlight(
      Math.max(
        0,
        choices.findIndex((item) => item.selected),
      ),
    )
    doc.addEventListener('pointerdown', outside, true)
    doc.addEventListener('scroll', onScroll, true)
    view?.addEventListener('resize', close)
  }

  trigger.addEventListener('click', () => {
    trigger.focus({ preventScroll: true })
    if (panel) close()
    else open()
  })
  trigger.addEventListener('blur', close)
  trigger.addEventListener('keydown', (event) => {
    const intent = listboxIntent(event)
    if (event.key === 'Tab') {
      close()
      return // Preserve the browser's ordinary forward/backward Tab order.
    }
    if (intent) {
      if (intent.kind === 'dismiss' && !panel) return
      event.preventDefault()
      event.stopPropagation() // Escape closes this menu, not the containing account dialog.
      if (intent.kind === 'dismiss') close()
      else if (!panel) {
        open()
        if (event.key === 'ArrowUp' || intent.kind === 'last') highlight(choices.length - 1)
        else if (intent.kind === 'first') highlight(0)
      } else if (intent.kind === 'activate') choose(active)
      else if (intent.kind === 'move') highlight(active + intent.delta)
      else highlight(intent.kind === 'first' ? 0 : choices.length - 1)
      if (panel) panel.dataset.keyboard = 'true'
      return
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    open()
    if (panel) panel.dataset.keyboard = 'true'
    const now = Date.now()
    typed = (now - typedAt > 700 ? '' : typed) + event.key.toLocaleLowerCase()
    typedAt = now
    const match = choices.findIndex((item) => optionLabel(item).toLocaleLowerCase().startsWith(typed))
    if (match >= 0) highlight(match)
  })
  select.closest('dialog')?.addEventListener('close', close)
  select.addEventListener('change', sync)
  const onReset = () =>
    queueMicrotask(() => {
      close()
      sync()
    })
  select.form?.addEventListener('reset', onReset)
  sync()
  return {
    sync,
    close,
    destroy: () => {
      close()
      trigger.remove()
      select.hidden = wasHidden
      if (field) {
        if (originalFor === null) field.removeAttribute('for')
        else if (originalFor !== undefined) field.setAttribute('for', originalFor)
      }
      select.removeEventListener('change', sync)
      select.form?.removeEventListener('reset', onReset)
      select.closest('dialog')?.removeEventListener('close', close)
    },
  }
}
