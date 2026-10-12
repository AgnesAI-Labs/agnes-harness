import { Dropdown as AntDropdown } from 'antd'
import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
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
  onSelect(): void
}
export type MenuProps = {
  trigger: ReactElement<HTMLAttributes<HTMLElement>>
  label: string
  items: readonly MenuItem[]
}
/** antd owns placement and menu semantics; this adapter preserves the existing keyboard contract. */
export function Menu({ trigger, label, items }: MenuProps) {
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion()
  const endOnOpen = useRef(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLDivElement | null>(null)
  const id = useId()
  const ordered = useMemo(
    () => [...items.filter((item) => !item.danger), ...items.filter((item) => item.danger)],
    [items],
  )
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
  const close = () => {
    setOpen(false)
    anchor.current?.querySelector<HTMLElement>('button, a, [tabindex]')?.focus({ preventScroll: true })
  }
  return (
    <AntDropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['click']}
      placement="bottomRight"
      destroyOnHidden
      transitionName={reduce ? '' : 'ant-slide-up'}
      rootClassName="agh-menu-popup"
      menu={{
        id,
        'aria-label': label,
        selectable: false,
        className: 'agh-menu',
        items: ordered.flatMap((item, index) => {
          const text = <span key={item.id}>{item.label}</span>
          const action = {
            key: item.id,
            label:
              item.disabled && item.disabledReason ? (
                <Tooltip title={item.disabledReason}>{text}</Tooltip>
              ) : (
                text
              ),
            icon: item.icon,
            danger: item.danger ?? false,
            disabled: item.disabled ?? false,
            className: ['agh-menu-item', item.className].filter(Boolean).join(' '),
            'data-testid': item.testId,
            'data-danger': item.danger || undefined,
            'aria-label': item.ariaLabel,
            ...(item.title ? { title: item.title } : {}),
          }
          return item.danger && index > 0 && !ordered[index - 1]?.danger
            ? [
                { type: 'divider' as const, key: `${item.id}-divider`, className: 'agh-menu-separator' },
                action,
              ]
            : [action]
        }),
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
          onKeyDown: (event) => {
            trigger.props.onKeyDown?.(event)
            if (!event.defaultPrevented && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
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
