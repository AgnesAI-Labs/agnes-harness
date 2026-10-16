import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, Icon, type IconName, Menu } from '@agnes/web-ui'
import { useLayoutEffect, useRef } from 'react'
import type { SessionAction } from './session-actions.js'

const ITEMS: readonly (readonly [SessionAction, string, IconName])[] = [
  ['rename', 'session.menu.rename', 'pencil'],
  ['fork', 'session.menu.fork', 'git-branch'],
  ['revealWorkspace', 'session.menu.openFolder', 'folder-open'],
  ['runtime', 'session.menu.runtime', 'info'],
  ['archive', 'session.menu.archive', 'archive'],
]

let activeTrigger: HTMLButtonElement | null = null

export function SessionMenu({
  id,
  title,
  disabled,
  t,
  action,
  platform,
}: {
  platform?: string | undefined
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
        tone="neutral"
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
            <Icon name="ellipsis" />
          </Button>
        }
        items={ITEMS.map(([item, key, icon]) => ({
          id: item,
          dividerBefore: item === 'revealWorkspace' || item === 'archive',
          label: t(
            item === 'revealWorkspace'
              ? platform === 'darwin'
                ? 'session.menu.openFinder'
                : platform === 'win32'
                  ? 'session.menu.openExplorer'
                  : key
              : key,
          ),
          icon: <Icon name={icon} />,
          onSelect: () => {
            if (trigger.current) action(item, id, title, trigger.current)
          },
        }))}
      />
    </div>
  )
}
