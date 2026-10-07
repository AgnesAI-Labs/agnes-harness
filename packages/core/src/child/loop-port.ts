import type { JsonValue } from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'
import { assertChildAgentAllowed } from './allowlist.js'

const IN_PROCESS = 'in-process'

function taskOf(input: JsonValue): { task: string; model?: string } {
  if (typeof input === 'string' && input.length > 0) return { task: input }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as { task?: unknown; model?: unknown }
    if (typeof record.task === 'string' && record.task.length > 0)
      return {
        task: record.task,
        ...(typeof record.model === 'string' && record.model.length > 0 ? { model: record.model } : {}),
      }
  }
  throw new Error('child input must be a non-empty string or { task, model? }')
}

/**
 * One in-process child turn for `LoopContext.children`.
 * The returned value is `{ text, childKey, providerId }`.
 */
export async function runLoopChild(
  session: SessionImpl,
  input: JsonValue,
  signal: AbortSignal,
): Promise<JsonValue> {
  signal.throwIfAborted()
  const { task, model } = taskOf(input)
  assertChildAgentAllowed(session.key, { providerId: IN_PROCESS, ...(model ? { model } : {}) })
  const child = await session.d.children.create({
    parent: session.key,
    cwd: session.d.cwd,
    input: task,
    ...(model ? { model } : {}),
  })
  const onAbort = () => {
    void child.cancel?.()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await child.run(task)
    return { text: result.text, childKey: child.key, providerId: IN_PROCESS }
  } finally {
    signal.removeEventListener('abort', onAbort)
    await child.close().catch(() => undefined)
  }
}
