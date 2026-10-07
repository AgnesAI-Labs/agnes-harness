import type {
  ChildAgentHandle,
  ChildAgentParentScope,
  ChildAgentService,
  ChildAgentSessionService,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'
import { assertChildAgentAllowed } from './allowlist.js'
import { narrowChildToolFilter } from './tool-filter.js'

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

/** Bind provider selection and every child handle to one immutable parent scope. */
export function bindChildAgentSession(
  service: ChildAgentService,
  parent: ChildAgentParentScope,
): ChildAgentSessionService {
  const lifetime = new AbortController()
  const owner = { ...parent, toolFilter: narrowChildToolFilter(parent.toolFilter) }
  const signal = AbortSignal.any([parent.signal, lifetime.signal])
  const handles = new Map<string, ChildAgentHandle>()
  const starting = new Set<Promise<unknown>>()
  let disposal: Promise<void> | undefined
  const owned = (id: string) => {
    const handle = handles.get(id)
    if (!handle) throw new Error(`child ${id} is not owned by parent ${owner.sessionKey}`)
    return handle
  }
  const facade: ChildAgentSessionService = {
    async start(task, options = {}) {
      signal.throwIfAborted()
      const budget =
        options.budget === undefined
          ? owner.budget
          : owner.budget === undefined
            ? options.budget
            : Math.min(owner.budget, options.budget)
      if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
        throw new Error('child budget must be positive and finite')
      const toolFilter = narrowChildToolFilter(owner.toolFilter, options.toolFilter)
      const pending = service
        .start(options.providerId, task, {
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
          ...(options.fork === undefined ? {} : { fork: options.fork }),
          sessionKey: owner.sessionKey,
          cwd: owner.cwd,
          ...(owner.generation === undefined ? {} : { generation: owner.generation }),
          signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
          ...(budget === undefined ? {} : { budget }),
          ...(toolFilter === undefined ? {} : { toolFilter }),
        })
        .then(async (handle) => {
          if (signal.aborted) {
            await handle.dispose()
            signal.throwIfAborted()
          }
          handles.set(handle.id, handle)
          return handle
        })
      starting.add(pending)
      try {
        return await pending
      } finally {
        starting.delete(pending)
      }
    },
    list: async () => (await service.list(owner.sessionKey)).filter((child) => handles.has(child.id)),
    sendMessage: (id, text, other) =>
      owned(id).sendMessage(text, other ? AbortSignal.any([signal, other]) : signal),
    interrupt: (id) => owned(id).interrupt(),
    result: (id) => owned(id).result(),
    events: (id) => owned(id).events(),
    dispose(id) {
      if (id !== undefined) return owned(id).dispose()
      disposal ??= (async () => {
        lifetime.abort()
        owner.signal.removeEventListener('abort', onAbort)
        const starts = await Promise.allSettled([...starting])
        const results = await Promise.allSettled([...handles.values()].map((handle) => handle.dispose()))
        const failures = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason)
        for (const result of starts)
          if (result.status === 'rejected' && result.reason !== signal.reason) failures.push(result.reason)
        if (failures.length) throw new AggregateError(failures, 'Child scope cleanup failed')
      })()
      return disposal
    },
  }
  const onAbort = () => {
    void facade.dispose().catch(() => undefined)
  }
  owner.signal.addEventListener('abort', onAbort, { once: true })
  if (owner.signal.aborted) onAbort()
  return facade
}

/**
 * Legacy synchronous in-process compatibility operation.
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
