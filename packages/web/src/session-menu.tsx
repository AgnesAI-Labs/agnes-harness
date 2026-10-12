import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, Menu } from '@agnes/web-ui'
import { useLayoutEffect, useRef } from 'react'
import type { SessionAction } from './session-actions.js'

const ITEMS: readonly (readonly [SessionAction, string, readonly string[]])[] = [
  [
    'rename',
    'session.menu.rename',
    [
      'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
      'm15 5 4 4',
    ],
  ],
  ['fork', 'session.menu.fork', ['M6 3v5a4 4 0 0 0 4 4h8', 'm14 8 4 4-4 4', 'M6 21v-5a4 4 0 0 1 4-4']],
  [
    'archive',
    'session.menu.archive',
    ['M3 4h18v4H3z', 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'M10 12h4'],
  ],
]
function MenuIcon({ paths }: { paths: readonly string[] }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

let activeTrigger: HTMLButtonElement | null = null

export function SessionMenu({
  id,
  title,
  disabled,
  t,
  action,
}: {
  id: string
  title: string
  disabled: boolean
  t: Translate
  action(action: SessionAction, id: string, title: string, trigger: HTMLElement): void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  // The shared Menu owns opening, keyboard navigation and portal placement. Mirror its
  // public expanded state onto the row so its hover treatment survives pointer movement.
  useLayoutEffect(() => {
    const button = trigger.current
    const row = button?.closest('.session-row')
    if (!button || !row) return
    const sync = () => {
      if (button.getAttribute('aria-expanded') === 'true') {
        if (
          activeTrigger &&
          activeTrigger !== button &&
          activeTrigger.getAttribute('aria-expanded') === 'true'
        )
          activeTrigger.click()
        activeTrigger = button
        row.setAttribute('data-menu-open', 'true')
      } else {
        row.removeAttribute('data-menu-open')
        if (activeTrigger === button) activeTrigger = null
      }
    }
    const observer = new MutationObserver(sync)
    observer.observe(button, { attributes: true, attributeFilter: ['aria-expanded'] })
    return () => {
      observer.disconnect()
      row.removeAttribute('data-menu-open')
      if (activeTrigger === button) activeTrigger = null
    }
  }, [])
  return (
    <div className="session-menu">
      <Menu
        label={t('session.menu.triggerAria', { name: title })}
        trigger={
          <Button
            ref={trigger}
            appearance="ghost"
            className="session-menu-trigger"
            disabled={disabled}
            data-session-action-id={id}
            aria-label={t('session.menu.triggerAria', { name: title })}
          >
            <MenuIcon paths={['M5 12h.01', 'M12 12h.01', 'M19 12h.01']} />
          </Button>
        }
        items={ITEMS.map(([item, key, paths]) => ({
          id: item,
          label: t(key),
          icon: <MenuIcon paths={paths} />,
          onSelect: () => {
            if (trigger.current) action(item, id, title, trigger.current)
          },
        }))}
      />
    </div>
  )
}
