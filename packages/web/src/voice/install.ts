import type { Client } from '@agnes/sdk/browser'
import { onBroadcast, onPageHide, onWindowFocus } from '../app/global-events.js'
import { createVoiceController, type VoiceController, type VoiceControllerDeps } from './controller.js'

/**
 * The page's voice controller: refreshes the button state when settings open, when the session
 * configuration changes and when the window regains focus, and releases the tab lock on page hide.
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
  window.addEventListener('agnes:settings-route', refresh, true)
  const stops = [
    () => window.removeEventListener('agnes:settings-route', refresh, true),
    onBroadcast('agnes:session-configuration-changed', refresh),
    onWindowFocus(refresh),
  ]
  const dispose = voice.dispose
  voice.dispose = () => {
    for (const stop of stops.splice(0)) stop()
    dispose()
  }
  onPageHide(() => voice.dispose())
  return voice
}
