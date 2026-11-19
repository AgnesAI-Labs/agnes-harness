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
  // The voice page lists and edits voice model accounts; a change there refreshes the voice buttons.
  const config = client.config
  const models = {
    get: () => config.get(),
    test: (input: Parameters<typeof config.test>[0]) => config.test(input),
    save: (input: Parameters<typeof config.save>[0]) => config.save(input).finally(refresh),
    account: (input: Parameters<typeof config.account>[0]) => config.account(input).finally(refresh),
  }
  window.addEventListener('agnes:settings-route', refresh, true)
  const stops = [
    () => window.removeEventListener('agnes:settings-route', refresh, true),
    onBroadcast('agnes:session-configuration-changed', refresh),
    onWindowFocus(refresh),
    registerVoiceSettingsSection(voice.settingsApi, models),
  ]
  const dispose = voice.dispose
  voice.dispose = () => {
    for (const stop of stops.splice(0)) stop()
    dispose()
  }
  onPageHide(() => voice.dispose())
  return voice
}
