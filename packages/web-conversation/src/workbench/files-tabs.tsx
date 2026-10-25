import type { UiExtensionContext } from '@agnes/web-client'
import { Button, IconButton } from '@agnes/web-ui'
import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'

const tabId = (position: number) => `workbench-file-tab-${position}`

/**
 * The strip above the preview: one pressed button per open path, its close button as a sibling.
 * The toolbar role keeps the close buttons out of a tablist, which must own only tabs.
 */
export function FileTabs({
  tabs,
  active,
  label,
  closeLabel,
  t,
  activate,
  close,
}: {
  tabs: readonly string[]
  active: string
  /** Disambiguated tab text; the full path stays in the title. */
  label(path: string): string
  closeLabel(path: string): string
  t: UiExtensionContext['t']
  activate(path: string): void
  close(path: string): void
}) {
  const index = tabs.indexOf(active)
  const strip = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // A newly opened tab can sit past the strip's width. Scroll the strip itself, so no ancestor
    // (the dock, the page) moves as a side effect of opening a file.
    const host = strip.current
    const tab = index < 0 ? undefined : (host?.children[index] as HTMLElement | undefined)
    if (!host || !tab) return
    const left = tab.offsetLeft
    const right = left + tab.offsetWidth
    if (left < host.scrollLeft) host.scrollLeft = left
    else if (right > host.scrollLeft + host.clientWidth) host.scrollLeft = right - host.clientWidth
  }, [index])
  return (
    <div
      ref={strip}
      role="toolbar"
      aria-label={t('workbench.files.tabs')}
      className="workbench-file-tabs"
      data-testid="file-tabs"
    >
      {tabs.map((path, position) => (
        <span
          key={path}
          className="workbench-file-tab"
          data-testid="file-tab"
          data-path={path}
          data-active={active === path || undefined}
        >
          <Button
            type="text"
            size="small"
            id={tabId(position)}
            className="workbench-file-tab-select"
            data-testid="file-tab-select"
            title={path}
            aria-pressed={active === path}
            tabIndex={active === path || (index < 0 && position === 0) ? 0 : -1}
            onClick={() => activate(path)}
            onKeyDown={(event) => {
              if (event.key === 'Delete') {
                event.preventDefault()
                close(path)
                return
              }
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              if (!step && event.key !== 'Home' && event.key !== 'End') return
              event.preventDefault()
              const next =
                tabs[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (position + step + tabs.length) % tabs.length
                ]
              if (!next) return
              if (next !== active) flushSync(() => activate(next))
              document.getElementById(tabId(tabs.indexOf(next)))?.focus()
            }}
          >
            <span className="workbench-file-tab-name">{label(path)}</span>
          </Button>
          <IconButton
            name="x"
            data-testid="file-tab-close"
            label={closeLabel(path)}
            onClick={() => close(path)}
          />
        </span>
      ))}
    </div>
  )
}
