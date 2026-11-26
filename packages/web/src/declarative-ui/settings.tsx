import { Button, Icon } from '@agnes/web-ui'
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { pluginUiEntries } from './entries.js'
import {
  PluginUiContent,
  pluginUiIcon,
  pluginUiLabels,
  pluginUiLocale,
  returnPluginUiFocus,
} from './presentation.js'

export function PluginUiSettingsNavigation() {
  const { entries, settings } = useSyncExternalStore(pluginUiEntries.subscribe, pluginUiEntries.getSnapshot)
  const installed = entries.filter((entry) => entry.placement === 'settings')
  if (!installed.length) return null
  const locale = pluginUiLocale()
  return (
    <div className="declarative-ui-settings">
      <p className="settings-nav-label">{pluginUiLabels().extensions}</p>
      <div className="declarative-ui-settings-list">
        {installed.map((entry) => {
          const title = entry.title[locale] ?? entry.title.en
          return (
            <Button
              key={entry.key}
              className="settings-nav-item"
              appearance="ghost"
              htmlType="button"
              title={title}
              data-testid={entry.testId}
              aria-current={settings?.entry === entry ? 'page' : undefined}
              onClick={(event) => pluginUiEntries.open('settings', entry, event.currentTarget)}
            >
              <Icon name={pluginUiIcon(entry.icon)} />
              <span>{title}</span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}

export function PluginUiSettingsPage() {
  const { settings } = useSyncExternalStore(pluginUiEntries.subscribe, pluginUiEntries.getSnapshot)
  const prior = useRef(settings)
  useLayoutEffect(() => {
    const closed = prior.current
    prior.current = settings
    const closeButton = document.getElementById('config-close')
    if (
      !settings &&
      closed &&
      !pluginUiEntries.isCurrent(closed.entry) &&
      document.activeElement === document.body &&
      closeButton?.closest('dialog')?.open
    )
      returnPluginUiFocus(closed.trigger, document.getElementById('settings-back'), closeButton)
  }, [settings])
  if (!settings) return null
  return (
    <div className="settings-content declarative-ui-settings-page">
      <PluginUiContent
        key={settings.entry.key}
        entry={settings.entry}
        onBack={() => {
          pluginUiEntries.close('settings')
          returnPluginUiFocus(
            settings.trigger,
            document.getElementById('settings-back'),
            document.getElementById('config-close'),
          )
        }}
      />
    </div>
  )
}
