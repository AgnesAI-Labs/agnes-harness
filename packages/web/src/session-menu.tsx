import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, Icon, type IconName, Menu } from '@agnes/web-ui'
import { useLayoutEffect, useRef } from 'react'
import type { SessionAction } from './session-actions.js'

const ITEMS: readonly (readonly [SessionAction, string, IconName])[] = [
  ['pin', 'session.menu.pin', 'pin'],
  ['unpin', 'session.menu.unpin', 'pin-off'],
  ['rename', 'session.menu.rename', 'pencil'],
  ['fork', 'session.menu.fork', 'git-branch'],
  ['revealWorkspace', 'session.menu.openFolder', 'folder-open'],
  ['runtime', 'session.menu.runtime', 'info'],
  ['archive', 'session.menu.archive', 'archive'],
]

/**
 * The actions this row offers. An archived session cannot be pinned — the two states exclude each
 * other — and its most useful action is the way back, so 「归档会话」 becomes 「恢复会话」.
 */
function itemsFor({
  chats,
  pinned,
  archived,
}: {
  chats: boolean
  pinned: boolean
  archived: boolean
}): readonly (readonly [SessionAction, string, IconName])[] {
  return ITEMS.flatMap(([item, key, icon]) => {
    if (chats && item === 'revealWorkspace') return []
    if (archived) {
      if (item === 'pin' || item === 'unpin') return []
      return item === 'archive'
        ? ([['unarchive', 'session.menu.unarchive', 'history']] as const)
        : [[item, key, icon] as const]
    }
    return item === (pinned ? 'pin' : 'unpin') ? [] : [[item, key, icon] as const]
  })
}

let activeTrigger: HTMLButtonElement | null = null

export function SessionMenu({
  id,
  title,
  disabled,
  t,
  action,
  platform,
  chats = false,
  pinned = false,
  archived = false,
}: {
  /** Offers 「取消置顶」 in place of 「置顶」. */
  pinned?: boolean
  /** Offers 「恢复会话」 in place of 「归档会话」 and drops the pin actions. */
  archived?: boolean
  platform?: string | undefined
  /** A chat in the managed chats workspace has no folder of its own to show. */
  chats?: boolean
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
    if (disabled || !button || !row) return
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
  }, [disabled])
  const button = (
    <Button
      ref={trigger}
      appearance="ghost"
      className="session-menu-trigger"
      disabled={disabled}
      data-session-action-id={id}
      aria-label={t('session.menu.triggerAria', { name: title })}
      aria-haspopup="menu"
      aria-expanded={false}
    >
      <Icon name="ellipsis" />
    </Button>
  )
  return (
    <div className="session-menu">
      {disabled ? (
        button
      ) : (
        <Menu
          tone="neutral"
          label={t('session.menu.triggerAria', { name: title })}
          trigger={button}
          items={itemsFor({ chats, pinned, archived }).map(([item, key, icon]) => ({
            id: item,
            dividerBefore: item === 'revealWorkspace' || item === 'archive' || item === 'unarchive',
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
              const current = trigger.current
              if (!disabled && current?.isConnected && !current.disabled) action(item, id, title, current)
            },
          }))}
        />
      )}
    </div>
  )
}
