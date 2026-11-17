import type { ConfigProvider } from '@agnes/protocol'
import { tr } from '@agnes/web-foundation/locale-bridge'
import { setSettingsSelectOptions } from '@agnes/web-ui'
import { option, type SettingsElements } from './dialog.js'

const authMethods = (provider: ConfigProvider) => provider.authMethods ?? [provider.authType ?? 'api-key']
export const providerValue = (provider: ConfigProvider, auth: string) =>
  auth === 'oauth' && authMethods(provider).includes('api-key') ? `${provider.id}:oauth` : provider.id

/** Project provider choices without losing the saved provider selection. */
export function renderAccountProviders(
  ui: SettingsElements,
  providers: readonly ConfigProvider[],
  savedProviderId: string | undefined,
): void {
  const groups = (['api-key', 'oauth'] as const).map((method) => ({
    label: method === 'oauth' ? tr('settings.provider.subscriptionLogin') : 'API Key',
    options: providers
      .filter((provider) => authMethods(provider).includes(method))
      .map((provider) =>
        option(
          method === 'oauth'
            ? `${provider.label.replace(/\s*subscription$/i, '')}${tr('settings.provider.subscriptionLoginSuffix')}`
            : provider.label,
          providerValue(provider, method),
        ),
      ),
  }))
  setSettingsSelectOptions(
    ui.provider,
    [option(providers.length ? tr('settings.provider.choose') : tr('settings.provider.none'), '')],
    groups,
  )
  if (savedProviderId && providers.some((provider) => provider.id === savedProviderId))
    ui.provider.value = savedProviderId
  else if (providers[0]) ui.provider.value = providers[0].id
}
