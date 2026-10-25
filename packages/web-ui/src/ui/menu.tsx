import { Dropdown as AntDropdown, type MenuProps as AntMenuProps } from 'antd'
import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Icon } from './icon.js'
import { useReducedMotion } from './overlay.js'
import { Tooltip } from './tooltip.js'

export type MenuItem = {
  id: string
  label: string
  icon?: ReactElement
  danger?: boolean
  disabled?: boolean
  disabledReason?: string
  testId?: string
  className?: string
  ariaLabel?: string
  title?: string
  dividerBefore?: boolean
  /** Consecutive items sharing a name render under one group heading. */
  group?: string
  /** A choice menu marks the current option with a check. */
  checked?: boolean
  onSelect(): void
}
export type MenuProps = {
  trigger: ReactElement<HTMLAttributes<HTMLElement>>
  label: string
  items: readonly MenuItem[]
  triggerMode?: 'click' | 'contextMenu'
  /** Neutral action lists retain text/danger colors and use a visible keyboard focus ring. */
  tone?: 'default' | 'neutral'
  /** Read after a checked item's label, e.g. 「Selected」. */
  selectedLabel?: string
}
type MenuDismissOptions = {
  open: boolean
  close(): void
  anchor: RefObject<HTMLSpanElement | null>
  popup: RefObject<HTMLDivElement | null>
}

/**
 * A portalled menu cannot follow the pane that scrolls it away, so any scroll or resize outside the
 * popup dismisses it. A mouse pointer leaving both the trigger and the popup dismisses it too, after
 * a grace period. Touch and keyboard sessions ignore the pointer path: a touch point lifts right
 * after opening, and a keyboard user may never have aimed at the trigger with a mouse.
 */
function useMenuDismiss({ open, close, anchor, popup }: MenuDismissOptions) {
  const fromPointer = useRef(false)
  const leave = useRef<ReturnType<typeof setTimeout>>()
  const cancelLeave = useCallback(() => clearTimeout(leave.current), [])
  const scheduleLeave = (event: { pointerType: string }) => {
    if (event.pointerType !== 'mouse' || !fromPointer.current) return
    cancelLeave()
    // The popup lives in a portal, so the pointer crosses a gap before it can reach the menu.
    leave.current = setTimeout(close, 150)
  }
  useEffect(() => {
    if (open) return
    // Every close path ends the pointer session that armed the timer.
    cancelLeave()
    fromPointer.current = false
  }, [open, cancelLeave])
  useEffect(() => () => clearTimeout(leave.current), [])
  // Refs are stable handles: re-subscribing on their reads would only churn listeners.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and close are stable; only open gates the listeners.
  useEffect(() => {
    if (!open) return
    const doc = anchor.current?.ownerDocument ?? document
    const dismiss = (event: Event) => {
      // Scrolling inside the menu itself is navigation, not movement of its anchor.
      if (popup.current && event.composedPath().includes(popup.current)) return
      close()
    }
    // Capture sees scrolls of inner panes; the popup is portalled outside them.
    doc.addEventListener('scroll', dismiss, true)
    doc.defaultView?.addEventListener('resize', dismiss)
    return () => {
      doc.removeEventListener('scroll', dismiss, true)
      doc.defaultView?.removeEventListener('resize', dismiss)
    }
  }, [open])
  return { fromPointer, cancelLeave, scheduleLeave }
}

type AntMenuItem = NonNullable<AntMenuProps['items']>[number]
/** antd owns placement and menu semantics; this adapter preserves the existing keyboard contract. */
export function Menu({
  trigger,
  label,
  items,
  triggerMode = 'click',
  tone = 'default',
  selectedLabel,
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const hold = useRef<ReturnType<typeof setTimeout>>()
  const held = useRef(false)
  useEffect(() => () => clearTimeout(hold.current), [])
  const reduce = useReducedMotion()
  const endOnOpen = useRef(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLDivElement | null>(null)
  const id = useId()
  const ordered = useMemo(
    () => [...items.filter((item) => !item.danger), ...items.filter((item) => item.danger)],
    [items],
  )
  // Group headings are presentation only: every `[role="menuitem"]` still follows `ordered`, so the
  // index arithmetic below keeps working whether or not the menu uses groups.
  const nodes = useMemo(() => {
    const out: AntMenuItem[] = []
    let run: { name: string; children: NonNullable<AntMenuProps['items']> } | undefined
    const flush = () => {
      if (!run) return
      out.push({
        type: 'group',
        key: `group-${run.name}`,
        className: 'agh-menu-group',
        label: <span className="agh-menu-group-label">{run.name}</span>,
        children: run.children,
      })
      run = undefined
    }
    ordered.forEach((item, index) => {
      const text = (
        <span key={item.id} className="agh-menu-label">
          <span className="agh-menu-label-text">{item.label}</span>
          {item.checked && <Icon name="check" className="agh-menu-check" />}
        </span>
      )
      // The check is the sighted cue; the accessible name carries the same state as words.
      const selected = item.checked && selectedLabel
      const action = {
        key: item.id,
        label:
          item.disabled && item.disabledReason ? <Tooltip title={item.disabledReason}>{text}</Tooltip> : text,
        icon: item.icon ? <span className="agh-menu-icon">{item.icon}</span> : undefined,
        danger: item.danger ?? false,
        disabled: item.disabled ?? false,
        className: ['agh-menu-item', item.className].filter(Boolean).join(' '),
        'data-testid': item.testId,
        'data-danger': item.danger || undefined,
        'data-checked': item.checked || undefined,
        'aria-label': selected
          ? `${item.ariaLabel ?? item.label}, ${selectedLabel}`
          : (item.ariaLabel ?? undefined),
        ...(item.title ? { title: item.title } : {}),
      }
      if (item.dividerBefore || (item.danger && index > 0 && !ordered[index - 1]?.danger)) {
        flush()
        out.push({ type: 'divider', key: `${item.id}-divider`, className: 'agh-menu-separator' })
      }
      if (item.group === undefined) {
        flush()
        out.push(action)
        return
      }
      if (run && run.name !== item.group) flush()
      run ??= { name: item.group, children: [] }
      run.children.push(action)
    })
    flush()
    return out
  }, [ordered, selectedLabel])
  const enabled = useMemo(() => ordered.flatMap((item, i) => (item.disabled ? [] : [i])), [ordered])
  const focus = (index: number | undefined) => {
    if (index !== undefined) popup.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus()
    else popup.current?.querySelector<HTMLElement>('[role="menu"]')?.focus()
  }
  useEffect(() => {
    if (!open) return
    const index = endOnOpen.current ? enabled.at(-1) : enabled[0]
    let frame = 0,
      remaining = 3
    const ready = () => {
      // Dropdown can reuse an exiting popup. Wait for its visibility/alignment frames on reopen.
      if (--remaining > 0) {
        frame = requestAnimationFrame(ready)
        return
      }
      const triggerNode = anchor.current?.querySelector<HTMLElement>('button, a, [tabindex]')
      if (document.activeElement === triggerNode || document.activeElement === document.body) {
        const menu = popup.current?.querySelector<HTMLElement>('[role="menu"]')
        const node =
          index === undefined ? menu : menu?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]
        node?.focus()
      }
      endOnOpen.current = false
    }
    frame = requestAnimationFrame(ready)
    return () => cancelAnimationFrame(frame)
  }, [open, enabled])
  const close = useCallback(() => {
    setOpen(false)
    anchor.current?.querySelector<HTMLElement>('button, a, [tabindex]')?.focus({ preventScroll: true })
  }, [])
  const { fromPointer, cancelLeave, scheduleLeave } = useMenuDismiss({ open, close, anchor, popup })
  return (
    <AntDropdown
      open={open}
      onOpenChange={setOpen}
      trigger={[triggerMode]}
      placement="bottomRight"
      destroyOnHidden
      transitionName={reduce ? '' : 'ant-slide-up'}
      rootClassName={`agh-menu-popup${tone === 'neutral' ? ' agh-menu-popup--neutral' : ''}`}
      menu={{
        id,
        'aria-label': label,
        selectable: false,
        className: 'agh-menu',
        items: nodes,
        onClick: ({ key }) => {
          const item = ordered.find((item) => item.id === key)
          if (!item || item.disabled) return
          close()
          item.onSelect()
        },
      }}
      popupRender={(node) => (
        <div
          ref={(node) => {
            popup.current = node
            if (node && open) focus(endOnOpen.current ? enabled.at(-1) : enabled[0])
          }}
          onPointerEnter={cancelLeave}
          onPointerLeave={scheduleLeave}
          onKeyDownCapture={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              const node = (event.target as Element).closest<HTMLElement>('[role="menuitem"]')
              if (
                node?.getAttribute('role') === 'menuitem' &&
                node.getAttribute('aria-disabled') !== 'true'
              ) {
                event.preventDefault()
                event.stopPropagation()
                node.click()
              }
              return
            }
            if (event.key === 'Tab') {
              event.stopPropagation()
              close()
              return
            }
            const nodes = popup.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
            const active = nodes ? [...nodes].indexOf(document.activeElement as HTMLElement) : -1
            const position = enabled.indexOf(active)
            let next: number | undefined
            if (event.key === 'ArrowDown') next = enabled[(position + 1) % enabled.length]
            else if (event.key === 'ArrowUp') next = enabled[(position - 1 + enabled.length) % enabled.length]
            else if (event.key === 'Home') next = enabled[0]
            else if (event.key === 'End') next = enabled.at(-1)
            else if (
              event.key.length === 1 &&
              event.key !== ' ' &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              const cyclic = [...enabled.filter((i) => i > active), ...enabled.filter((i) => i <= active)]
              next = cyclic.find((i) =>
                ordered[i]?.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()),
              )
            }
            if (next !== undefined) {
              event.preventDefault()
              event.stopPropagation()
              focus(next)
            }
          }}
        >
          {node}
        </div>
      )}
    >
      <span ref={anchor} className="agh-menu-anchor">
        {cloneElement(trigger, {
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? id : undefined,
          onPointerDown: (event) => {
            // Only a pointer press makes this an interaction the pointer path may dismiss.
            fromPointer.current = event.pointerType === 'mouse'
            trigger.props.onPointerDown?.(event)
            held.current = false
            if (triggerMode !== 'contextMenu' || event.pointerType === 'mouse') return
            hold.current = setTimeout(() => {
              held.current = true
              setOpen(true)
            }, 500)
          },
          onPointerUp: (event) => {
            clearTimeout(hold.current)
            trigger.props.onPointerUp?.(event)
          },
          onPointerCancel: (event) => {
            clearTimeout(hold.current)
            trigger.props.onPointerCancel?.(event)
          },
          onPointerEnter: (event) => {
            cancelLeave()
            trigger.props.onPointerEnter?.(event)
          },
          onPointerLeave: (event) => {
            clearTimeout(hold.current)
            scheduleLeave(event)
            trigger.props.onPointerLeave?.(event)
          },
          onClickCapture: (event) => {
            trigger.props.onClickCapture?.(event)
            // Context menus also hide on click inside rc-trigger. Consume the synthetic touch
            // click before that handler runs, so a long press neither launches nor closes it.
            if (held.current) {
              held.current = false
              event.preventDefault()
              event.stopPropagation()
            }
          },
          onClick: (event) => {
            if (held.current) {
              held.current = false
              event.preventDefault()
              event.stopPropagation()
              return
            }
            trigger.props.onClick?.(event)
          },
          onKeyDown: (event) => {
            trigger.props.onKeyDown?.(event)
            if (
              !event.defaultPrevented &&
              (['ArrowDown', 'ArrowUp', 'ContextMenu'].includes(event.key) ||
                (event.shiftKey && event.key === 'F10'))
            ) {
              event.preventDefault()
              endOnOpen.current = event.key === 'ArrowUp'
              setOpen(true)
            }
          },
        })}
      </span>
    </AntDropdown>
  )
}
