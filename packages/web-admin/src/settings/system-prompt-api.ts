import { type SystemPromptSaveParams, type SystemPromptSnapshot, validateAgainst } from '@agnes/protocol'
import { SystemPromptSnapshot as Schema } from '@agnes/protocol/gen/agnes-v1'
export function systemPromptApi(fetcher: typeof fetch = fetch) {
  async function call(
    input?: SystemPromptSaveParams,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<SystemPromptSnapshot> {
    const response = await fetcher(
      sessionId ? '/admin/api/system-prompt/session' : '/admin/api/system-prompt',
      {
        credentials: 'same-origin',
        cache: 'no-store',
        ...(signal ? { signal } : {}),
        ...(input || sessionId
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input ?? { sessionId }),
            }
          : {}),
      },
    )
    const result: unknown = await response.json()
    if (!response.ok || !validateAgainst(Schema, result).ok) throw new Error('Prompt unavailable')
    return result as SystemPromptSnapshot
  }
  return {
    session: (sessionId: string, signal?: AbortSignal) => call(undefined, signal, sessionId),
    get: (signal?: AbortSignal) => call(undefined, signal),
    save: (input: SystemPromptSaveParams, signal?: AbortSignal) => call(input, signal),
  }
}
