import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  useEffect,
  useId,
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
  onSelect(): void
}
export type MenuProps = {
  trigger: ReactElement<
    HTMLAttributes<HTMLElement> & {
      'aria-expanded'?: boolean
      'aria-controls'?: string
      'aria-haspopup'?: 'menu'
    }
  >
  label: string
  items: readonly MenuItem[]
}
/** Action menus are distinct from value pickers (listbox). Dangerous actions stay last. */
export function Menu({ trigger, label, items }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const endOnOpen = useRef(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const ordered = [...items.filter((item) => !item.danger), ...items.filter((item) => item.danger)]
  const enabled = ordered.flatMap((item, i) => (item.disabled ? [] : [i]))
  const close = () => {
    setOpen(false)
    anchor.current?.querySelector<HTMLElement>('button, a, [tabindex]')?.focus()
  }
  const focus = (index: number) => {
    setActive(index)
    menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus()
  }
  useEffect(() => {
    if (!open) return
    const index = endOnOpen.current ? enabled.at(-1) : enabled[0]
    endOnOpen.current = false
    if (index !== undefined) focus(index)
    else menu.current?.focus()
  }, [open])
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      content={
        <div
          id={id}
          ref={menu}
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
              setOpen(false)
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
                  <div role="separator" className="agh-menu-separator" />
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
              setOpen(true)
            }
          },
        })}
      </span>
    </Popover>
  )
}
