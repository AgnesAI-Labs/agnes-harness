import type {
  ConfigOAuthInput,
  ConfigOAuthNotice,
  ConfigOAuthPrompt,
  ConfigOAuthResult,
} from '@agnes/protocol'

export type OAuthClient = { oauth(input: ConfigOAuthInput): Promise<ConfigOAuthResult> }
export type OAuthInteraction = {
  signal: AbortSignal
  notice(value: ConfigOAuthNotice): void
  prompt(value: ConfigOAuthPrompt, signal: AbortSignal): Promise<string>
  operation?(id: string): void
}

/** Keep polling while a manual-code prompt is open: the browser callback can finish independently. */
export async function loginSubscription(
  client: OAuthClient,
  input: ConfigOAuthInput,
  interaction: OAuthInteraction,
): Promise<ConfigOAuthResult> {
  let id: string | undefined
  let active: { id: string; controller: AbortController } | undefined
  let promptError: { id: string; error: unknown } | undefined
  const seen = new Set<string>()
  interaction.signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new Error('CONFIG_AUTH_CANCELLED'))
    onAbort = abort
    if (interaction.signal.aborted) abort()
    else interaction.signal.addEventListener('abort', abort, { once: true })
  })
  const call = (request: ConfigOAuthInput) => Promise.race([client.oauth(request), cancelled])
  try {
    interaction.signal.throwIfAborted()
    // Start is observed even if cancellation races the reply, so its server operation can be cleaned up.
    const started = client.oauth(input).then((result) => {
      id = result.operationId
      if (interaction.signal.aborted) void client.oauth({ action: 'cancel', operationId: id }).catch(() => {})
      else interaction.operation?.(id)
      return result
    })
    let result = await Promise.race([started, cancelled])
    for (;;) {
      interaction.signal.throwIfAborted()
      for (const notice of result.notices ?? []) {
        const key = JSON.stringify(notice)
        if (!seen.has(key)) {
          seen.add(key)
          interaction.notice(notice)
        }
      }
      if (result.state === 'ready') return result
      if (result.state !== 'running') throw new Error(result.error ?? 'CONFIG_AUTH_FAILED')
      if (promptError) {
        if (result.prompt?.id === promptError.id) throw promptError.error
        promptError = undefined
      }
      if (active && active.id !== result.prompt?.id) {
        active.controller.abort()
        active = undefined
      }
      if (result.prompt && !active) {
        const prompt = result.prompt
        const controller = new AbortController()
        active = { id: prompt.id, controller }
        const signal = AbortSignal.any([interaction.signal, controller.signal])
        void interaction
          .prompt(prompt, signal)
          .then(async (answer) => {
            if (!signal.aborted)
              await call({ action: 'answer', operationId: id as string, promptId: prompt.id, answer })
          })
          .catch((error) => {
            if (!signal.aborted) promptError = { id: prompt.id, error }
          })
      }
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 250)), cancelled])
      result = await call({ action: 'poll', operationId: id as string })
    }
  } catch (error) {
    if (id) void client.oauth({ action: 'cancel', operationId: id }).catch(() => {})
    throw error
  } finally {
    active?.controller.abort()
    interaction.signal.removeEventListener('abort', onAbort)
  }
}

export const loginCodex = loginSubscription
