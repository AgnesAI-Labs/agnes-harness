import { type SystemPromptSaveParams, type SystemPromptSnapshot, validateAgainst } from '@agnes/protocol'
import { SystemPromptSnapshot as Schema } from '@agnes/protocol/gen/agnes-v1'
/**
 * A save made against a revision that is no longer stored: another window saved first. `current` is
 * that saved value with its revision; keep the draft, show `current`, and save again against it.
 */
export class SystemPromptConflict extends Error {
  constructor(readonly current: SystemPromptSnapshot) {
    super('Prompt changed elsewhere')
  }
}

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
    const conflict = (result as { error?: { data?: { code?: unknown; current?: unknown } } } | null)?.error
      ?.data
    if (
      response.status === 409 &&
      conflict?.code === 'CONFIG_REVISION_CONFLICT' &&
      validateAgainst(Schema, conflict.current).ok
    )
      throw new SystemPromptConflict(conflict.current as SystemPromptSnapshot)
    if (!response.ok || !validateAgainst(Schema, result).ok) throw new Error('Prompt unavailable')
    return result as SystemPromptSnapshot
  }
  return {
    session: (sessionId: string, signal?: AbortSignal) => call(undefined, signal, sessionId),
    get: (signal?: AbortSignal) => call(undefined, signal),
    save: (input: SystemPromptSaveParams, signal?: AbortSignal) => call(input, signal),
  }
}
