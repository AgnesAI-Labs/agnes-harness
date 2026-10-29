/**
 * Reusable popover primitives shared by admin pickers.
 *
 * Extracted from the model picker, which had the only hand-written dropdown in the web client. These
 * two pieces are the parts that carry no product meaning: viewport-clamped placement, and the
 * listbox key map. A picker keeps its own state machine and rendering.
 */

export type PopoverPlacement = 'above' | 'below'

export type SubmenuPlacement = 'right' | 'left' | PopoverPlacement

export type PopoverPositionOptions = Readonly<{
  preferredWidth: number
  preferredHeight: number
  /**
   * `'fixed'` (default) pins the panel width to `preferredWidth`. `'content'` lets CSS choose the width,
   * clamped only to the viewport, avoiding empty space to the right of short menu items.
   */
  width?: 'fixed' | 'content'
  /** Minimum distance kept from every viewport edge. */
  viewportPadding?: number
  /** Gap between the trigger and the panel. */
  gap?: number
}>

/**
 * Places `panel` next to `trigger`, clamped to the viewport, and reports which side it landed on.
 * The panel must already be in the document so its height can be measured.
 */
export function positionPopover(
  trigger: HTMLElement,
  panel: HTMLElement,
  options: PopoverPositionOptions,
): PopoverPlacement {
  const padding = options.viewportPadding ?? 12
  const gap = options.gap ?? 8
  const triggerBounds = trigger.getBoundingClientRect()
  const viewportWidth = Math.max(0, window.innerWidth)
  const viewportHeight = Math.max(0, window.innerHeight)
  const measuredWidth = panel.getBoundingClientRect().width || options.preferredWidth
  const width = Math.max(
    0,
    Math.min(
      options.width === 'content' ? measuredWidth : options.preferredWidth,
      viewportWidth - padding * 2,
    ),
  )
  const left = Math.max(
    padding,
    Math.min(triggerBounds.left, Math.max(padding, viewportWidth - width - padding)),
  )
  // scrollHeight is the actual content height. The panel may still have a max-height from CSS or the previous pass;
  // getBoundingClientRect alone measures the clipped height, skewing side selection and placement.
  const measuredHeight =
    Math.max(panel.getBoundingClientRect().height, panel.scrollHeight) || options.preferredHeight
  const roomAbove = Math.max(0, triggerBounds.top - padding - gap)
  const roomBelow = Math.max(0, viewportHeight - triggerBounds.bottom - padding - gap)
  // Prefer the side that fits the panel outright; otherwise take the roomier one.
  const above = roomAbove >= Math.min(measuredHeight, options.preferredHeight) || roomAbove >= roomBelow
  const availableHeight = Math.min(options.preferredHeight, above ? roomAbove : roomBelow)
  const height = Math.min(measuredHeight, availableHeight)
  const top = above
    ? Math.max(padding, triggerBounds.top - height - gap)
    : Math.min(viewportHeight - height - padding, triggerBounds.bottom + gap)

  if (options.width !== 'content') panel.style.width = `${width}px`
  panel.style.maxHeight = `${Math.max(0, availableHeight)}px`
  panel.style.left = `${left}px`
  panel.style.top = `${Math.max(padding, top)}px`
  panel.dataset.placement = above ? 'above' : 'below'
  return above ? 'above' : 'below'
}

/**
 * Places `panel` beside `parent` (an open popover), vertically aligned with `anchor` — the row that
 * opened it. Prefers right, then left; a narrow viewport stacks it above/below the parent.
 */
export function positionSubmenu(
  anchor: HTMLElement,
  parent: HTMLElement,
  panel: HTMLElement,
  options: PopoverPositionOptions,
): SubmenuPlacement {
  const padding = options.viewportPadding ?? 12
  const gap = options.gap ?? 4
  const anchorBounds = anchor.getBoundingClientRect()
  const parentBounds = parent.getBoundingClientRect()
  const viewportWidth = Math.max(0, window.innerWidth)
  const viewportHeight = Math.max(0, window.innerHeight)
  const width = Math.max(0, Math.min(options.preferredWidth, viewportWidth - padding * 2))
  const toRight = parentBounds.right + gap
  const toLeft = parentBounds.left - gap - width
  // A viewport clamp must not cover the row that opened the submenu.
  if (toRight + width + padding > viewportWidth && toLeft < padding)
    return positionPopover(parent, panel, { ...options, width: 'fixed', gap })
  const opensRight = toRight + width + padding <= viewportWidth || toLeft < padding
  const left = Math.max(padding, Math.min(opensRight ? toRight : toLeft, viewportWidth - width - padding))
  // scrollHeight is the actual content height. The panel may still have a max-height from CSS or the previous pass;
  // getBoundingClientRect alone measures the clipped height, leaving the bottom overflowing when positioning from it.
  const measuredHeight =
    Math.max(panel.getBoundingClientRect().height, panel.scrollHeight) || options.preferredHeight
  const height = Math.min(measuredHeight, options.preferredHeight, viewportHeight - padding * 2)
  const top = Math.max(padding, Math.min(anchorBounds.top, viewportHeight - height - padding))
  panel.style.width = `${width}px`
  panel.style.maxHeight = `${Math.max(0, Math.min(options.preferredHeight, viewportHeight - top - padding))}px`
  panel.style.left = `${left}px`
  panel.style.top = `${top}px`
  panel.dataset.placement = opensRight ? 'right' : 'left'
  return opensRight ? 'right' : 'left'
}

export type ListboxIntent =
  | { kind: 'move'; delta: number }
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'activate' }
  | { kind: 'dismiss'; returnFocus: boolean }

/** Maps a keyboard event to listbox intent, or undefined when the key is not ours. */
export function listboxIntent(event: KeyboardEvent): ListboxIntent | undefined {
  switch (event.key) {
    case 'ArrowDown':
      return { kind: 'move', delta: 1 }
    case 'ArrowUp':
      return { kind: 'move', delta: -1 }
    case 'Home':
      return { kind: 'first' }
    case 'End':
      return { kind: 'last' }
    case 'Enter':
    case ' ':
      return { kind: 'activate' }
    case 'Escape':
      return { kind: 'dismiss', returnFocus: true }
    // Returning focus to the trigger lets the browser continue Tab from its ordinary place.
    case 'Tab':
      return { kind: 'dismiss', returnFocus: true }
    default:
      return undefined
  }
}

/** Wires the listbox key map; handled keys are preventDefault-ed so the page never scrolls. */
export function bindListboxKeys(listbox: HTMLElement, handle: (intent: ListboxIntent) => void): void {
  listbox.addEventListener('keydown', (event) => {
    const intent = listboxIntent(event)
    if (!intent) return
    event.preventDefault()
    handle(intent)
  })
}
