import { randomUUID } from 'node:crypto'
import type { ConfigModel, ConfigProvider, ConfigSaveInput, ConfigSnapshot } from '@agnes/protocol'
import { type Client, loginSubscription } from '@agnes/sdk'
import { openLoginBrowser } from '../login-browser.js'
import { type Component, Text, VStack } from '../tui/component.js'
import { Select } from '../tui/components/select.js'
import { parseKey } from '../tui/keys.js'
import { Renderer } from '../tui/renderer.js'
import type { Terminal } from '../tui/terminal.js'
import { AuthMethodView } from '../tui/views/auth-method.js'
import { SecretInputView } from '../tui/views/secret-input.js'
import { type OnboardingState, reduceOnboarding } from './state.js'

/**
 * First-run authentication flow, rendered with the TUI's own components.
 *
 * Configuration travels over `client.config.*` -- the same authenticated app-server endpoint Web's
 * settings panel uses -- so this module is presentation only and never opens a Host credential
 * store itself. The key is held in one local variable for the span of test+save and is deliberately
 * absent from the reduced state, which carries metadata only.
 */
export async function runOnboardingTui(
  client: Client,
  snapshot: ConfigSnapshot,
  term: Terminal,
): Promise<ConfigSnapshot | undefined> {
  return new Promise<ConfigSnapshot | undefined>((resolve, reject) => {
    let state: OnboardingState = {
      kind: 'auth-method',
      reason: 'Agnes needs a model provider before it can open a session.',
      suggested: 'api-key',
    }
    let providers: readonly ConfigProvider[] = []
    let provider: ConfigProvider | undefined
    let selectedAuth: 'api-key' | 'oauth' | undefined
    let apiKey = ''
    let oauthController: AbortController | undefined
    let oauthOperation: string | undefined
    const clearOAuth = () => {
      oauthController?.abort()
      oauthController = undefined
      if (oauthOperation)
        void client.config.oauth({ action: 'cancel', operationId: oauthOperation }).catch(() => {})
      oauthOperation = undefined
    }
    // Advanced by each key submission and by leaving the key prompt. A provider test answered after
    // either belongs to a key or provider no longer on screen, so it must not move the flow on: that
    // would carry the old key into a later provider's save.
    let attempt = 0
    // Saving is not idempotent: the API-key path mints a fresh accountId per call and both
    // paths bill a live test request against the chosen model, while the OAuth path would
    // commit the same operationId twice. The Select stays interactive across the await, so
    // the latch has to live here rather than in that shared component.
    let saving = false
    let notice = ''
    let child: Component = authMethodView()
    let renderer: Renderer | undefined

    const root: Component = {
      invalidate: () => child.invalidate?.(),
      // The views hand ctrl+c back unhandled; every hint on these screens promises it cancels the flow.
      handleInput: (data) => {
        if (child.handleInput?.(data) === true) return true
        if (parseKey(data, term.caps.kittyKeyboard).name !== 'ctrl-c') return false
        finish(undefined)
        return true
      },
      render: (width) => (notice ? new VStack([child, new Text(notice)]).render(width) : child.render(width)),
    }

    const redraw = (): void => {
      child = viewFor(state)
      renderer?.requestRender()
    }

    const finish = (result: ConfigSnapshot | undefined): void => {
      clearOAuth()
      apiKey = ''
      renderer?.stop()
      resolve(result)
    }

    const fail = (error: unknown): void => {
      clearOAuth()
      apiKey = ''
      renderer?.stop()
      reject(error)
    }

    const dispatch = (action: Parameters<typeof reduceOnboarding>[1]): void => {
      state = reduceOnboarding(state, action)
      redraw()
    }

    function authMethodView(): Component {
      return new AuthMethodView({
        suggested: 'api-key',
        onChoose: (choice) => {
          if (choice === 'agnes-account') {
            // The account path needs the platform's PKCE/token contract, which this build does not
            // carry. Say so and stay on the selector rather than opening a flow that cannot finish.
            notice = 'Agnes account sign-in is not available in this build yet. Choose an API key.'
            renderer?.requestRender()
            return
          }
          notice = ''
          dispatch({ type: 'choose-auth', choice })
          void loadProviders()
        },
        onCancel: () => finish(undefined),
      })
    }

    async function loadProviders(): Promise<void> {
      try {
        const result = await client.config.providers()
        providers = result.providers
        dispatch({
          type: 'providers-available',
          providers: providers.map((row) => ({ id: row.id, label: row.label })),
        })
      } catch (error) {
        fail(new Error('configuration providers failed', { cause: error }))
      }
    }

    async function submitKey(secret: string): Promise<void> {
      if (!provider) return
      const current = ++attempt
      apiKey = secret
      notice = 'Testing the provider…'
      renderer?.requestRender()
      let models: readonly ConfigModel[]
      try {
        const result = await client.config.test({
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          apiKey,
        })
        if (!result.verified || result.models.length === 0)
          throw new Error('the Provider did not return any verified models')
        models = result.models
      } catch {
        if (current !== attempt) return
        // The key never reaches the rendered failure: only this driver's own summary is shown.
        apiKey = ''
        notice = 'Could not verify that key. Press escape to go back and try again.'
        dispatch({
          type: 'operation-failed',
          failure: { code: 'AUTH_FAILED', message: notice, retryable: true },
        })
        return
      }
      if (current !== attempt) return
      notice = ''
      dispatch({
        type: 'models-required',
        models: models.map((row) => ({ id: row.id, label: row.name })),
      })
    }

    function oauthView(): Component {
      const methods = provider?.loginMethods ?? ['browser', 'device_code']
      return new Select({
        title: `${provider?.label ?? 'Provider'} subscription login:`,
        options: methods.map((id) => ({
          id,
          label: id === 'browser' ? 'Browser login' : 'Device code login',
        })),
        onChoose: (method) => void startOAuth(method as 'browser' | 'device_code'),
        onCancel: () => {
          clearOAuth()
          notice = ''
          dispatch({ type: 'back' })
        },
      })
    }
    async function startOAuth(loginMethod: 'browser' | 'device_code'): Promise<void> {
      clearOAuth()
      const controller = new AbortController()
      oauthController = controller
      child = new Text(`Waiting for ${provider?.label ?? 'Provider'} authorization. Ctrl+C cancels.`)
      notice = ''
      renderer?.requestRender()
      try {
        const result = await loginSubscription(
          client.config,
          {
            action: 'start',
            providerId: provider?.id ?? '',
            loginMethod,
            accountId: `acct-${randomUUID()}`,
            label: provider?.label ?? 'Subscription account',
            expectedRevision: snapshot.revision,
          },
          {
            signal: controller.signal,
            operation: (id) => {
              oauthOperation = id
            },
            notice: (value) => {
              notice = `${value.message}\n${value.url ?? ''}`
              renderer?.requestRender()
              if (value.url) openLoginBrowser(value.url, controller.signal)
            },
            prompt: (value, signal) =>
              new Promise<string>((resolve, reject) => {
                const abort = () => {
                  reject(new Error('cancelled'))
                }
                signal.addEventListener('abort', abort, { once: true })
                child = new SecretInputView({
                  label: value.message,
                  hint: `${value.placeholder ? `${value.placeholder} · ` : ''}Enter submits. Ctrl+C cancels.`,
                  masked: value.type !== 'text',
                  allowEmpty: value.type === 'text',
                  allowSpaces: value.type === 'text',
                  onSubmit: (answer) => {
                    signal.removeEventListener('abort', abort)
                    resolve(answer)
                    child = new Text('Waiting for login…')
                    renderer?.requestRender()
                  },
                  onBack: () => {
                    controller.abort()
                    clearOAuth()
                    child = oauthView()
                    notice = ''
                    renderer?.requestRender()
                  },
                })
                renderer?.requestRender()
                if (signal.aborted) abort()
              }),
          },
        )
        if (controller.signal.aborted) return
        notice = 'Authorized. Saving will send a test request to the selected model.'
        dispatch({
          type: 'models-required',
          models: (result.models ?? []).map((m) => ({ id: m.id, label: m.name })),
        })
      } catch {
        if (!controller.signal.aborted) {
          clearOAuth()
          notice = 'Login failed. Retry or choose device code.'
          child = oauthView()
          renderer?.requestRender()
        }
      }
    }

    async function saveModel(modelId: string): Promise<void> {
      if (saving) return
      saving = true
      if (oauthOperation) {
        notice = 'Testing the selected model and saving…'
        renderer?.requestRender()
        try {
          const result = await client.config.oauth({
            action: 'commit',
            operationId: oauthOperation,
            model: modelId,
          })
          if (!result.snapshot) throw new Error('save failed')
          finish(result.snapshot)
        } catch {
          saving = false
          notice = 'Could not save. Retry, or press escape to sign in again.'
          renderer?.requestRender()
        }
        return
      }
      if (!provider) {
        saving = false
        return
      }
      notice = 'Saving…'
      renderer?.requestRender()
      const account =
        snapshot.accounts === undefined ? {} : { accountId: `acct-${randomUUID()}`, label: provider.label }
      const input: ConfigSaveInput = {
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        apiKey,
        model: modelId,
        expectedRevision: snapshot.revision,
        ...account,
      }
      try {
        finish(await client.config.save(input))
      } catch (error) {
        fail(new Error('configuration save failed', { cause: error }))
      }
    }

    function viewFor(next: OnboardingState): Component {
      switch (next.kind) {
        case 'auth-method':
          return authMethodView()
        case 'provider-select':
          return new Select({
            title: 'Select a provider:',
            options: next.providers.map((option) => ({ id: option.id, label: option.label })),
            onChoose: (id) => {
              provider = providers.find((row) => row.id === id)
              selectedAuth = undefined
              dispatch({ type: 'choose-provider', providerId: id })
            },
            onCancel: () => dispatch({ type: 'back' }),
          })
        case 'key-input':
          {
            const methods = provider?.authMethods ?? [provider?.authType ?? 'api-key']
            if (!selectedAuth && methods.length > 1)
              return new Select({
                title: 'Choose authentication:',
                options: [
                  { id: 'api-key', label: 'API key' },
                  { id: 'oauth', label: 'Subscription login' },
                ].filter((option) => methods.includes(option.id as 'api-key' | 'oauth')),
                onChoose: (id) => {
                  selectedAuth = id as 'api-key' | 'oauth'
                  child = viewFor(next)
                  renderer?.requestRender()
                },
                onCancel: () => dispatch({ type: 'back' }),
              })
            if ((selectedAuth ?? methods[0]) === 'oauth') return oauthView()
          }
          return new SecretInputView({
            label: `${next.provider.label} API key`,
            hint: 'enter submit  escape back  ctrl+c cancel',
            onSubmit: (secret) => void submitKey(secret),
            onBack: () => {
              attempt++
              apiKey = ''
              notice = ''
              dispatch({ type: 'back' })
            },
          })
        case 'model-select':
          return new Select({
            title: 'Select the default model:',
            options: next.models.map((option) => ({ id: option.id, label: option.label })),
            onChoose: (id) => void saveModel(id),
            onCancel: () => {
              clearOAuth()
              notice = ''
              dispatch({ type: 'back' })
            },
          })
        case 'error':
          return viewFor(next.previous)
        case 'cancelled':
          finish(undefined)
          return child
        default:
          return child
      }
    }

    renderer = new Renderer(term, root)
    try {
      renderer.start()
    } catch (error) {
      fail(error)
    }
  })
}
