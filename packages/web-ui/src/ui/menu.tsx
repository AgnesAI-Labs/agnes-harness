import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Popover } from './popover.js'
import { Tooltip } from './tooltip.js'

export type MenuItem = {
  id: string
  label: string
  icon?: ReactElement
  danger?: boolean
  disabled?: boolean
  disabledReason?: string
  testId?: string
  onSelect(): void
}
export type MenuProps = {
  trigger: ReactElement<HTMLAttributes<HTMLElement>>
  label: string
  items: readonly MenuItem[]
}
/** Action menus are distinct from value pickers (listbox). Dangerous actions stay last. */
export function Menu({ trigger, label, items }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const endOnOpen = useRef(false)
  const pendingFocus = useRef(true)
  const anchor = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const id = useId()
  const ordered = useMemo(
    () => [...items.filter((item) => !item.danger), ...items.filter((item) => item.danger)],
    [items],
  )
  const enabled = useMemo(() => ordered.flatMap((item, i) => (item.disabled ? [] : [i])), [ordered])
  const close = () => {
    setOpen(false)
    anchor.current?.querySelector<HTMLElement>('button, a, [tabindex]')?.focus()
  }
  const focus = (index: number) => {
    setActive(index)
    menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus()
  }
  const initialFocus = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !pendingFocus.current) return
      pendingFocus.current = false
      const index = endOnOpen.current ? enabled.at(-1) : enabled[0]
      endOnOpen.current = false
      if (index !== undefined) {
        setActive(index)
        node.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus()
      } else node.focus()
    },
    [enabled],
  )
  useEffect(() => {
    if (open) initialFocus(menu.current)
  }, [open, initialFocus])
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        pendingFocus.current = next
        setOpen(next)
      }}
      trigger="click"
      placement="bottomRight"
      content={
        <div
          id={id}
          ref={(node) => {
            menu.current = node
            if (open) initialFocus(node)
          }}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          className="agh-menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
              return
            }
            if (event.key === 'Tab') {
              // Natural Tab navigation continues from the trigger, not the detached portal.
              close()
              return
            }
            let next: number | undefined
            const position = enabled.indexOf(active)
            if (event.key === 'ArrowDown') next = enabled[(position + 1) % enabled.length]
            else if (event.key === 'ArrowUp') next = enabled[(position - 1 + enabled.length) % enabled.length]
            else if (event.key === 'Home') next = enabled[0]
            else if (event.key === 'End') next = enabled.at(-1)
            else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              const cyclic = [...enabled.filter((i) => i > active), ...enabled.filter((i) => i <= active)]
              next = cyclic.find((i) =>
                ordered[i]?.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()),
              )
            }
            if (next !== undefined) {
              event.preventDefault()
              focus(next)
            }
          }}
        >
          {ordered.map((item, index) => {
            const button = (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-testid={item.testId}
                tabIndex={active === index ? 0 : -1}
                className="agh-menu-item"
                data-danger={item.danger || undefined}
                aria-disabled={item.disabled || undefined}
                onFocus={() => setActive(index)}
                onClick={() => {
                  if (!item.disabled) {
                    close()
                    item.onSelect()
                  }
                }}
              >
                {item.icon && <span aria-hidden="true">{item.icon}</span>}
                {item.label}
              </button>
            )
            return (
              <div key={item.id}>
                {item.danger && !ordered[index - 1]?.danger && index > 0 && (
                  <hr className="agh-menu-separator" />
                )}
                {item.disabled && item.disabledReason ? (
                  <Tooltip title={item.disabledReason}>{button}</Tooltip>
                ) : (
                  button
                )}
              </div>
            )
          })}
        </div>
      }
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
              pendingFocus.current = true
              setOpen(true)
            }
          },
        })}
      </span>
    </Popover>
  )
}
