import type { Client } from '@agnes/sdk/browser'
import { registerVoiceSettingsSection } from '@agnes/web-admin/settings/voice'
import { onBroadcast, onPageHide, onWindowFocus } from '../app/global-events.js'
import { createVoiceController, type VoiceController, type VoiceControllerDeps } from './controller.js'

/**
 * The page's voice controller: refreshes the button state when settings open, when the session
 * configuration changes and when the window regains focus, and releases the tab lock on page hide.
 * It also registers the voice section of the settings page, which reads and saves through the controller.
 */
export function installVoice(
  client: Pick<Client, 'call' | 'config'>,
  overrides: Partial<Pick<VoiceControllerDeps, 'channel' | 'media' | 'tabId'>> = {},
): VoiceController {
  const voice = createVoiceController({
    call: (method, params, options) => client.call(method, params, options),
    config: () => client.config.get(),
    openSettings: (section) => {
      document.dispatchEvent(
        new CustomEvent('agnes:open-settings', { bubbles: true, cancelable: true, detail: { section } }),
      )
    },
    ...overrides,
  })
  const refresh = () => voice.refresh()
  // Inside the settings page the link routes there directly; elsewhere it opens settings first.
  const openSideModels = () => {
    const form = document.getElementById('config-form')
    if (!form) return voice.settingsApi.openSideModels()
    form.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'side-models', bubbles: true }))
  }
  window.addEventListener('agnes:settings-route', refresh, true)
  const stops = [
    () => window.removeEventListener('agnes:settings-route', refresh, true),
    onBroadcast('agnes:session-configuration-changed', refresh),
    onWindowFocus(refresh),
    registerVoiceSettingsSection({ ...voice.settingsApi, openSideModels }),
  ]
  const dispose = voice.dispose
  voice.dispose = () => {
    for (const stop of stops.splice(0)) stop()
    dispose()
  }
  onPageHide(() => voice.dispose())
  return voice
}
