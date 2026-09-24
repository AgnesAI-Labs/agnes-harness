import { randomUUID } from 'node:crypto'
import {
  getSubscriptionProvider,
  type SubscriptionCredential,
  type SubscriptionCredentialStore,
  type SubscriptionInteraction,
  type SubscriptionProviderId,
  subscriptionAuth,
} from '@agnes/ai'
import type { ConfigOAuthInput, ConfigOAuthResult, ConfigSnapshot } from '@agnes/protocol'

type Start = {
  accountId: string
  label: string
  expectedRevision: number
  providerId: SubscriptionProviderId
}
type Operation = {
  id: string
  controller: AbortController
  result: ConfigOAuthResult
  input: Start
  credential?: SubscriptionCredential | undefined
  answer?: ((text: string) => void) | undefined
  refresh?: () => Promise<unknown>
  committing: boolean
  committedModel?: string
  timer: ReturnType<typeof setTimeout>
  detach(): void
}
export type CodexLoginDependencies = {
  test?: (
    input: Start,
    credential: SubscriptionCredential,
    model: string,
    signal: AbortSignal,
  ) => Promise<void>
  login?: (
    providerId: SubscriptionProviderId,
    store: SubscriptionCredentialStore,
    interaction: SubscriptionInteraction,
  ) => Promise<void>
  commit(
    input: Start,
    credential: SubscriptionCredential,
    model: string,
    signal: AbortSignal,
  ): Promise<ConfigSnapshot>
}

/** Connection-owned, bounded operations. Access/refresh tokens never appear in public results. */
export function createCodexLogin(deps: CodexLoginDependencies) {
  const operations = new Map<object, Operation>()
  const error = (code = 'CONFIG_INVALID_INPUT'): never => {
    throw Object.assign(new Error(code), { code })
  }
  const forget = (owner: object, op: Operation) => {
    op.controller.abort()
    op.credential = undefined
    op.answer = undefined
    clearTimeout(op.timer)
    op.detach()
    if (operations.get(owner) === op) operations.delete(owner)
  }
  return async (
    input: ConfigOAuthInput,
    owner: object,
    lifetime: AbortSignal,
  ): Promise<ConfigOAuthResult> => {
    lifetime.throwIfAborted()
    const allowed: Record<string, string[]> = {
      start: ['action', 'accountId', 'providerId', 'label', 'expectedRevision', 'loginMethod'],
      poll: ['action', 'operationId'],
      answer: ['action', 'operationId', 'promptId', 'answer'],
      commit: ['action', 'operationId', 'model'],
      test: ['action', 'operationId', 'model'],
      cancel: ['action', 'operationId'],
    }
    if (
      !input ||
      !allowed[input.action] ||
      Object.keys(input).some((k) => !allowed[input.action]?.includes(k))
    )
      error()
    if (input.action === 'start') {
      const provider = getSubscriptionProvider(input.providerId ?? 'openai-codex')
      const callbackHost = process.env.PI_OAUTH_CALLBACK_HOST
      if (
        provider?.id === 'openai-codex' &&
        input.loginMethod === 'browser' &&
        callbackHost &&
        !['127.0.0.1', 'localhost', '::1'].includes(callbackHost)
      )
        error('CONFIG_AUTH_FAILED')
      if (
        !input.accountId ||
        !provider ||
        !/^[a-z0-9][a-z0-9-]{0,47}$/.test(input.accountId) ||
        !input.label?.trim() ||
        input.label.length > 128 ||
        /\p{Cc}/u.test(input.label) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        (input.expectedRevision as number) < 0 ||
        !provider.loginMethods.includes(input.loginMethod as 'browser' | 'device_code')
      )
        error()
      const selectedProvider = provider as NonNullable<typeof provider>
      const prior = operations.get(owner)
      if (prior?.committing) error('CONFIG_AUTH_BUSY')
      if (prior) forget(owner, prior)
      if (operations.size >= 8) error('CONFIG_AUTH_BUSY')
      const controller = new AbortController()
      const id = randomUUID()
      const op: Operation = {
        id,
        controller,
        input: {
          accountId: input.accountId as string,
          label: input.label as string,
          expectedRevision: input.expectedRevision as number,
          providerId: selectedProvider.id,
        },
        result: { operationId: id, state: 'running', notices: [] },
        committing: false,
        timer: setTimeout(() => forget(owner, op), 16 * 60_000),
        detach: () => {},
      }
      op.timer.unref()
      const close = () => forget(owner, op)
      lifetime.addEventListener('abort', close, { once: true })
      op.detach = () => lifetime.removeEventListener('abort', close)
      operations.set(owner, op)
      const store: SubscriptionCredentialStore = {
        read: async (id) => (id === selectedProvider.id ? op.credential : undefined),
        list: async () => [],
        delete: async () => {
          op.credential = undefined
        },
        modify: async (id, mutate) => {
          if (id !== selectedProvider.id) error('CONFIG_AUTH_FAILED')
          const next = await mutate(op.credential)
          controller.signal.throwIfAborted()
          if (
            next?.type !== 'oauth' ||
            (selectedProvider.id === 'openai-codex' && typeof next.accountId !== 'string')
          )
            error('CONFIG_AUTH_FAILED')
          op.credential = next as SubscriptionCredential
          return next
        },
      }
      op.refresh = () => subscriptionAuth(selectedProvider.id, store).resolve(controller.signal)
      const allowedHosts = new Set(selectedProvider.authOrigins.map((origin) => new URL(origin).hostname))
      const interaction: SubscriptionInteraction = {
        signal: controller.signal,
        prompt: async (prompt) => {
          if (prompt.type === 'select') return input.loginMethod as string
          const signal = prompt.signal
            ? AbortSignal.any([controller.signal, prompt.signal])
            : controller.signal
          signal.throwIfAborted()
          return new Promise<string>((resolve, reject) => {
            const promptId = randomUUID()
            const clear = () => {
              signal.removeEventListener('abort', abort)
              if (op.result.prompt?.id === promptId) {
                delete op.result.prompt
                op.answer = undefined
              }
            }
            const abort = () => {
              clear()
              reject(new Error('CONFIG_AUTH_CANCELLED'))
            }
            op.result.prompt = {
              id: promptId,
              type: prompt.type,
              message: prompt.message.slice(0, 2048),
              ...(prompt.placeholder ? { placeholder: prompt.placeholder.slice(0, 512) } : {}),
            }
            op.answer = (text) => {
              if (selectedProvider.id === 'github-copilot' && prompt.type === 'text' && text.trim()) {
                let host = ''
                try {
                  host = new URL(text.includes('://') ? text : `https://${text}`).hostname
                } catch {
                  error()
                }
                if (!/^[a-z0-9.-]+$/i.test(host) || host.length > 253) error()
                allowedHosts.add(host)
              }
              clear()
              resolve(text)
            }
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
        },
        notify: (event) => {
          if (controller.signal.aborted) return
          if ((op.result.notices?.length ?? 0) >= 100) {
            controller.abort()
            return
          }
          const url =
            event.type === 'auth_url'
              ? event.url
              : event.type === 'device_code'
                ? event.verificationUri
                : undefined
          if (!url) {
            if (event.type === 'info' || event.type === 'progress')
              op.result.notices?.push({ message: event.message.slice(0, 4096) })
            return
          }
          const parsed = new URL(url)
          if (
            parsed.protocol !== 'https:' ||
            !allowedHosts.has(parsed.hostname) ||
            parsed.username ||
            parsed.password ||
            url.length > 4096
          )
            error('CONFIG_AUTH_FAILED')
          if (event.type === 'device_code' && !/^[a-z0-9-]{1,128}$/i.test(event.userCode))
            error('CONFIG_AUTH_FAILED')
          op.result.notices?.push({
            url: parsed.href,
            message:
              event.type === 'device_code'
                ? `在登录页面输入验证码：${event.userCode.slice(0, 128)}`
                : `在浏览器完成 ${selectedProvider.displayName} 登录。`,
          })
        },
      }
      void (async () => {
        try {
          await (deps.login
            ? deps.login(selectedProvider.id, store, interaction)
            : subscriptionAuth(selectedProvider.id, store).login(interaction))
          controller.signal.throwIfAborted()
          if (!op.credential) error('CONFIG_AUTH_FAILED')
          op.result.models = (
            await subscriptionAuth(selectedProvider.id, store).available(controller.signal)
          ).map((m) => ({ id: m.id, name: m.name }))
          controller.signal.throwIfAborted()
          op.result.state = 'ready'
        } catch {
          op.credential = undefined
          op.result.state = controller.signal.aborted ? 'cancelled' : 'failed'
          op.result.error = controller.signal.aborted ? 'CONFIG_AUTH_CANCELLED' : 'CONFIG_AUTH_FAILED'
        } finally {
          delete op.result.prompt
          op.answer = undefined
        }
      })()
      return structuredClone(op.result)
    }
    const op = operations.get(owner)
    if (!op || op.id !== input.operationId) return error('CONFIG_AUTH_EXPIRED')
    if (input.action === 'cancel') {
      forget(owner, op)
      return { operationId: op.id, state: 'cancelled' }
    }
    if (input.action === 'answer') {
      if (
        !op.answer ||
        op.result.prompt?.id !== input.promptId ||
        typeof input.answer !== 'string' ||
        input.answer.length > 8192
      )
        error()
      op.answer?.(input.answer as string)
    }
    if (input.action === 'commit' || input.action === 'test') {
      if (input.action === 'commit' && op.result.state === 'saved') {
        if (input.model !== op.committedModel) error()
        return structuredClone(op.result)
      }
      if (
        op.committing ||
        op.result.state !== 'ready' ||
        !op.credential ||
        !op.result.models?.some((m) => m.id === input.model)
      )
        error()
      op.committing = true
      try {
        try {
          await op.refresh?.()
        } catch {
          error('CONFIG_SUBSCRIPTION_AUTH')
        }
        op.controller.signal.throwIfAborted()
        if (input.action === 'test') {
          if (!deps.test) error('CONFIG_AUTH_UNAVAILABLE')
          await deps.test?.(
            op.input,
            op.credential as SubscriptionCredential,
            input.model as string,
            op.controller.signal,
          )
          op.controller.signal.throwIfAborted()
          return structuredClone(op.result)
        }
        const snapshot = await deps.commit(
          op.input,
          op.credential as SubscriptionCredential,
          input.model as string,
          op.controller.signal,
        )
        op.credential = undefined
        op.committedModel = input.model as string
        op.result = { operationId: op.id, state: 'saved', snapshot }
      } finally {
        op.committing = false
      }
    }
    return structuredClone(op.result)
  }
}
