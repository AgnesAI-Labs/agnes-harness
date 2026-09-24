import { randomUUID } from 'node:crypto'
import type {
  ConfigAccount,
  ConfigModel,
  ConfigProvider,
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigTestInput,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { loginSubscription } from '@agnes/sdk'
import { openLoginBrowser } from './login-browser.js'

export type ConfigWizardIO = {
  input: AsyncIterable<string>
  write(text: string): void
  /** Optional raw-terminal reader. Piped/non-TTY callers continue using the line iterator. */
  secret?(prompt: string): Promise<string>
}

async function ask(lines: AsyncIterator<string>, prompt: string, io: ConfigWizardIO): Promise<string> {
  io.write(prompt)
  const line = await lines.next()
  return line.done ? '' : String(line.value).trim()
}

function redact(message: string, secret: string): string {
  return secret.length === 0 ? message : message.split(secret).join('[redacted]')
}

function requestError(prefix: string, error: unknown, secret: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${prefix}: ${redact(message, secret)}`)
}

function selectedProvider(providers: readonly ConfigProvider[], answer: string): ConfigProvider | undefined {
  const index = Number(answer)
  if (!Number.isInteger(index) || index < 1) return undefined
  return providers[index - 1]
}

function selectedModel(models: readonly ConfigModel[], answer: string): ConfigModel | undefined {
  const index = Number(answer)
  if (!Number.isInteger(index) || index < 1) return undefined
  return models[index - 1]
}

function baseInput(providerId: string, baseUrl: string, apiKey: string): ConfigTestInput {
  return {
    providerId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  }
}

/**
 * Runs the shared config flow over the SDK. API keys are read only into this short-lived function
 * and never written to a profile, journal, or error prefix.
 */
export async function runConfigurationWizard(
  client: Client,
  snapshot: ConfigSnapshot,
  io: ConfigWizardIO,
): Promise<ConfigSnapshot> {
  const lines = io.input[Symbol.asyncIterator]()
  let account: ConfigAccount | undefined
  let accountId: string | undefined
  let label: string | undefined
  if (snapshot.accounts !== undefined) {
    io.write('Provider accounts (0 = add):\n')
    snapshot.accounts.forEach((row, index) => {
      io.write(
        `  ${index + 1}) ${row.label} (${row.providerId}) ${row.enabled ? 'enabled' : 'disabled'}${snapshot.defaultAccountId === row.accountId ? ' · default' : ''}\n`,
      )
    })
    const answer = snapshot.accounts.length ? await ask(lines, 'Account [0 = add]: ', io) : '0'
    if (answer === '0') {
      accountId = `acct-${randomUUID()}`
      label = await ask(lines, 'Account name: ', io)
      if (!label) throw new Error('configuration: account name required')
    } else {
      account = snapshot.accounts[Number(answer) - 1]
      if (!account) throw new Error('configuration: choose a listed account')
      accountId = account.accountId
      label = account.label
      const action = await ask(lines, 'Action [edit/test/enable/disable/default/remove]: ', io)
      if (action === 'test') {
        const result = await client.config.test({ providerId: account.providerId, accountId })
        io.write(
          result.verified
            ? 'Credentials and model directory verified; selected-model inference was not tested.\n'
            : 'Credentials and model directory could not be verified.\n',
        )
        return snapshot
      }
      if (['enable', 'disable', 'default', 'remove'].includes(action)) {
        if (action === 'remove' && (await ask(lines, 'Remove this account? Type yes: ', io)) !== 'yes')
          return snapshot
        if (action !== 'enable' && action !== 'disable' && action !== 'default' && action !== 'remove')
          throw new Error('invalid action')
        const saved = await client.config.account({ accountId, action, expectedRevision: snapshot.revision })
        io.write(
          saved.effect === 'restart-required'
            ? 'Saved; restart backend to apply.\n'
            : 'Saved for new sessions.\n',
        )
        return saved
      }
      if (action !== 'edit') throw new Error('configuration: choose a listed action')
      label = (await ask(lines, `Account name [${label}]: `, io)) || label
    }
  }
  const providerResult = await client.config.providers().catch((error) => {
    throw requestError('configuration providers failed', error, '')
  })
  const providers = providerResult.providers
  if (providers.length === 0) throw new Error('configuration providers failed: no providers are available')
  io.write('Configure a Provider for Agnes. The local backend stores the key and never returns it.\n')
  providers.forEach((provider, index) => {
    io.write(`  ${index + 1}) ${provider.label} (${provider.id})\n`)
  })
  const provider = account
    ? providers.find((row) => row.id === account.providerId)
    : selectedProvider(providers, await ask(lines, `Provider [1-${providers.length}]: `, io))
  if (!provider) throw new Error('configuration: choose a listed Provider')
  const authMethods = provider.authMethods ?? [provider.authType ?? 'api-key']
  const authType =
    account?.authType && authMethods.includes(account.authType)
      ? account.authType
      : authMethods.length === 1
        ? authMethods[0]
        : (await ask(lines, 'Authentication [1 = API key, 2 = subscription]: ', io)) === '2'
          ? 'oauth'
          : 'api-key'
  if (authType === 'oauth') {
    const controller = new AbortController()
    let operationId: string | undefined
    try {
      const loginMethods = provider.loginMethods ?? ['browser', 'device_code']
      const loginMethod = loginMethods.includes('device_code') ? 'device_code' : 'browser'
      io.write(`${provider.label} subscription login. The login link opens in your browser.\n`)
      const result = await loginSubscription(
        client.config,
        {
          action: 'start',
          providerId: provider.id,
          loginMethod,
          accountId: accountId ?? `acct-${randomUUID()}`,
          label: label ?? provider.label,
          expectedRevision: snapshot.revision,
        },
        {
          signal: controller.signal,
          operation: (id) => {
            operationId = id
          },
          notice: (notice) => {
            io.write(`${notice.message}\n${notice.url ?? ''}\n`)
            if (notice.url) openLoginBrowser(notice.url, controller.signal)
          },
          prompt: async (prompt) =>
            prompt.type === 'secret' && io.secret
              ? io.secret(`${prompt.message}: `)
              : ask(lines, `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ''}: `, io),
        },
      )
      const models = result.models ?? []
      models.forEach((model, index) => {
        io.write(`  ${index + 1}) ${model.name} (${model.id})\n`)
      })
      const model = selectedModel(models, await ask(lines, `Model [1-${models.length}]: `, io))
      if (!model) throw new Error('configuration: choose a listed model')
      io.write('Testing the selected model and saving…\n')
      const saved = await client.config.oauth({
        action: 'commit',
        operationId: result.operationId,
        model: model.id,
      })
      if (!saved.snapshot) throw new Error('configuration save failed')
      io.write(
        saved.snapshot.effect === 'restart-required'
          ? 'Saved; restart backend to apply.\n'
          : 'Saved for new sessions.\n',
      )
      return saved.snapshot
    } finally {
      controller.abort()
      if (operationId) await client.config.oauth({ action: 'cancel', operationId }).catch(() => {})
    }
  }
  const baseUrl = await ask(lines, `Base URL [${account?.baseUrl ?? provider.baseUrl}]: `, io)
  const effectiveBaseUrl = baseUrl || account?.baseUrl || provider.baseUrl
  let apiKey = io.secret
    ? await io.secret('API key (stored by the local backend; never returned): ')
    : await ask(lines, 'API key (stored by the local backend; never returned): ', io)
  try {
    const testedInput = {
      ...baseInput(provider.id, effectiveBaseUrl, apiKey),
      ...(accountId ? { accountId } : {}),
    }
    let tested: { models: ConfigModel[]; verified: boolean }
    try {
      tested = await client.config.test(testedInput)
    } catch (error) {
      throw requestError('configuration test failed', error, apiKey)
    }
    if (!tested.verified || tested.models.length === 0)
      throw new Error('configuration test failed: the Provider did not return any verified models')
    io.write('Credentials and model directory verified; selected-model inference was not tested.\n')
    io.write('Models returned by the Provider:\n')
    tested.models.forEach((entry, index) => {
      io.write(`  ${index + 1}) ${entry.name} (${entry.id})\n`)
    })
    const picked = selectedModel(tested.models, await ask(lines, `Model [1-${tested.models.length}]: `, io))
    if (!picked) throw new Error('configuration: choose a listed model')
    const saveInput: ConfigSaveInput = {
      ...baseInput(provider.id, effectiveBaseUrl, apiKey),
      ...(accountId ? { accountId } : {}),
      ...(label ? { label } : {}),
      model: picked.id,
      expectedRevision: snapshot.revision,
    }
    let saved: ConfigSnapshot
    try {
      saved = await client.config.save(saveInput)
    } catch (error) {
      throw requestError('configuration save failed', error, apiKey)
    }
    io.write(
      saved.effect === 'restart-required'
        ? 'Configuration saved. Restart Agnes before opening a session.\n'
        : 'Configuration saved for new sessions.\n',
    )
    return saved
  } finally {
    // The SDK needs the value across test and save, so the lifetime is this flow rather than one
    // RPC. Release the local reference as soon as the flow completes or fails.
    apiKey = ''
  }
}
