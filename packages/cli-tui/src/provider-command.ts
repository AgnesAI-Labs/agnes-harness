import type { ConfigProvider } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { formatTuiErrorNotice } from './error-notice.js'
import { tt } from './locale-extended.js'
import { rememberAccounts } from './model-label.js'
import type { ThemedAnsi } from './theme.js'
import { type ProviderPort, ProviderSetup } from './views/provider-setup.js'

/** Providers that take a pasted API key: OAuth-only and the bring-your-own-endpoint entry are out of scope here. */
export function apiKeyProviders(providers: readonly ConfigProvider[]): ConfigProvider[] {
  return providers.filter(
    (p) =>
      p.id !== 'openai-compatible' &&
      (p.authMethods ? p.authMethods.includes('api-key') : p.authType !== 'oauth'),
  )
}

/**
 * `/provider`: reads the account list and the provider catalogue, then hands the dialog what it needs. It takes
 * no argument so a key can never end up in the input history.
 */
export async function providerSlash(app: TuiApp): Promise<SlashResult> {
  const { locale } = app
  if (app.o.remote) return { text: tt('provider.remote', locale) }
  const { client } = app.session
  let snapshot: Awaited<ReturnType<typeof client.config.get>>
  let providers: ConfigProvider[]
  try {
    snapshot = await client.config.get()
    rememberAccounts(client, snapshot.accounts)
    providers = apiKeyProviders((await client.config.providers()).providers)
  } catch (error) {
    return { text: tt('provider.loadFailed', locale, { error: formatTuiErrorNotice(error, locale) }) }
  }
  if (!providers.length) return { text: tt('provider.none', locale) }
  const port: ProviderPort = {
    test: (input) => client.config.test(input),
    save: (input) => client.config.save(input),
    published: async (saved, providerId, model) => {
      rememberAccounts(client, saved.accounts)
      const accounts = saved.accounts ?? []
      const account =
        accounts.find((a) => a.accountId === `legacy-${providerId}`) ??
        accounts.find((a) => a.providerId === providerId)
      const offered = (await client.apis()).profile.models ?? []
      return offered.some((m) => m.id === model && (!account || m.route === account.route))
    },
  }
  return {
    providerSetup: {
      providers,
      configured: new Set((snapshot.accounts ?? []).map((a) => a.providerId)),
      revision: snapshot.revision,
      port,
    },
  }
}

/** The dialog `app.ts` mounts; kept here so the app only holds one line for it. */
export function createProviderSetup(app: TuiApp, ansi: ThemedAnsi, locale: string): ProviderSetup {
  return new ProviderSetup({
    ansi,
    locale,
    maxRows: () => Math.max(4, app.o.term.size().rows - 6),
    notice: (text) => app.statusBar.setNotice(text),
    changed: () => app.stopped || app.renderer.requestRender(),
  })
}
