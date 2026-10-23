import type {
  ChildAgentHandle,
  ChildAgentParentScope,
  ChildAgentService,
  ChildAgentSessionService,
} from '@agnes/extension-api'
import { narrowChildToolFilter } from './tool-filter.js'

/** Bind provider selection and every child handle to one immutable parent scope. */
export function bindChildAgentSession(
  service: ChildAgentService,
  parent: ChildAgentParentScope,
): ChildAgentSessionService {
  const lifetime = new AbortController()
  // Read at every start: a session filter set after this scope was bound still binds later children.
  const owner = {
    ...parent,
    get toolFilter() {
      return narrowChildToolFilter(parent.toolFilter)
    },
  }
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
    start: (task, options = {}) => start(task, options, false),
    adoptStart: (task, options) => start(task, options, true),
    list: async () =>
      (await service.list(owner.sessionKey))
        .filter((child) => handles.has(child.id))
        .map((child) => ({
          ...child,
          interrupt: handles.get(child.id)!.capabilities.interrupt,
          continuable: child.continuable && handles.get(child.id)!.capabilities.continuable,
        })),
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
  async function start(
    task: string,
    options: import('@agnes/extension-api').ChildAgentSessionStartOptions,
    recovering: boolean,
  ) {
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
    const boundOptions = {
      ...(options.invocationId === undefined ? {} : { invocationId: options.invocationId }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
      ...(options.fork === undefined ? {} : { fork: options.fork }),
      sessionKey: owner.sessionKey,
      cwd: owner.cwd,
      ...(owner.generation === undefined ? {} : { generation: owner.generation }),
      signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
      ...(budget === undefined ? {} : { budget }),
      ...(toolFilter === undefined ? {} : { toolFilter }),
    }
    if (recovering && (!service.adopt || !options.invocationId))
      throw new Error('child provider does not support invocation adoption')
    const pending = (
      recovering
        ? service.adopt!(options.providerId, task, { ...boundOptions, invocationId: options.invocationId! })
        : service.start(options.providerId, task, boundOptions)
    ).then(async (handle) => {
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
  }
  const onAbort = () => {
    void facade.dispose().catch(() => undefined)
  }
  owner.signal.addEventListener('abort', onAbort, { once: true })
  if (owner.signal.aborted) onAbort()
  return facade
}
