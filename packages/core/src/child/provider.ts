import { assertChildAgentAllowed } from '@agnes/core-child-control/child/allowlist'
import {
  type ChildCursor,
  ChildEventBus,
  createChildEventQueue,
  providerFrame,
} from '@agnes/core-child-control/child/events'
import { projectChildStatus } from '@agnes/core-child-control/child/status-projection'
import type {
  ChildAgentCapabilities,
  ChildAgentEvent,
  ChildAgentHandle,
  ChildAgentListing,
  ChildAgentProvider,
  ChildAgentProviderStartOptions,
  ChildAgentResult,
  ChildAgentStartOptions,
  ChildAgentStatus,
  ChildAgentToolFilter,
} from '@agnes/extension-api'
import type { ChildEventStream } from './event-stream.js'
import { childBackend } from './sessions.js'

export const IN_PROCESS_CHILD_PROVIDER_ID = 'in-process'

export const IN_PROCESS_CHILD_CAPABILITIES: ChildAgentCapabilities = Object.freeze({
  continuable: true,
  interrupt: true,
  pause: true,
  modelSelection: true,
  inheritsParentContext: true,
  // Git worktree preparation belongs to the official tool's deferred-start path.
  worktree: false,
  budget: true,
  toolFilter: true,
})

export type ResidentStart = {
  task: string
  invocationId?: string
  cwd: string
  model?: string
  isolation?: 'worktree' | 'shared'
  budget?: number
  fork?: boolean
  toolFilter?: ChildAgentToolFilter
}

export type ResidentTurn = { text: string; status: ChildAgentStatus }

/** The session-scoped backend today's in-process children already are. */
export interface InProcessChildBackend {
  readonly childEvents?: ChildEventStream | undefined
  startResident(input: ResidentStart): Promise<{ id: string }>
  adoptResident?(input: ResidentStart & { invocationId: string }): Promise<{ id: string }>
  startFork(input: ResidentStart): Promise<{ id: string; text: string }>
  sendMessage(id: string, text: string, signal: AbortSignal): Promise<{ messageId: string }>
  interrupt(id: string): Promise<{ accepted: boolean }>
  cancel(id: string): Promise<void>
  list(): Promise<readonly ChildAgentListing[]>
  onTurn(id: string, listener: (event: ResidentTurn) => void): () => void
  completion(id: string): Promise<ChildAgentResult>
}

function requireCapability(ok: boolean, message: string): void {
  if (!ok) throw new Error(message)
}

type CursorHandle = Omit<ChildAgentHandle, 'events'> & {
  events(cursor?: ChildCursor): AsyncIterable<ChildAgentEvent>
}
type CursorProvider = Omit<ChildAgentProvider, 'start' | 'adopt'> & {
  start(task: string, options: ChildAgentProviderStartOptions): Promise<CursorHandle>
  adopt(
    task: string,
    options: ChildAgentProviderStartOptions & { invocationId: string },
  ): Promise<CursorHandle>
}

function handleEvents(stream: ChildEventStream | undefined, id: string) {
  if (!stream) {
    const queue = createChildEventQueue()
    return { queue, publish: queue.push, stop: () => {} }
  }
  // Turn text is handle-local. Preserve it for late readers without allocating a journal cursor.
  const texts: Array<{ after: number; event: ChildAgentEvent }> = []
  let lastSeq = 0
  const bus = new ChildEventBus({
    scan: async (after) => {
      const retained = texts.filter((text) => text.after >= after)
      const snapshot = await stream.snapshot(id, after)
      const frames: ChildAgentEvent[] = []
      const pending = retained.values()
      let next = pending.next()
      for (const frame of snapshot) {
        while (!next.done && next.value.after < frame.envelope.seq) {
          frames.push(next.value.event)
          next = pending.next()
        }
        frames.push(providerFrame(frame))
      }
      if (!next.done) frames.push(next.value.event, ...Array.from(pending, (text) => text.event))
      return frames
    },
  })
  const stop = stream.listen(id, (event) => {
    if (event.type === 'envelope') lastSeq = event.envelope.seq
    bus.notify(providerFrame(event))
  })
  return {
    queue: createChildEventQueue(bus),
    stop,
    publish(event: ChildAgentEvent) {
      if (event.type !== 'text') return
      texts.push({ after: lastSeq, event })
      bus.notify(event)
    },
  }
}

async function listChildren(backend: InProcessChildBackend | undefined, parentKey: string) {
  if (!backend) return []
  const listings = await backend.list()
  const store = backend.childEvents?.store
  if (!store) return listings
  const [records, leases] = await Promise.all([
    store.listByParent(parentKey),
    store.listChildLeasesByParent(parentKey),
  ])
  const tasks = new Map(records.map((record) => [record.childKey, record]))
  const beats = new Map(leases.map((lease) => [lease.childKey, lease]))
  return listings.map((listing) => {
    const record = tasks.get(listing.id)
    if (!record) return listing
    const lease = beats.get(listing.id)
    const hints =
      record.state === 'running'
        ? { humanStopped: listing.status === 'interrupted', residentIdle: listing.status === 'idle' }
        : undefined
    const { status, executionState } = projectChildStatus(record, hints)
    return {
      ...listing,
      status,
      executionState,
      ...(lease ? { lastHeartbeatAt: lease.lastHeartbeatAt, leaseUntil: lease.leaseUntil } : {}),
    }
  })
}

/**
 * The default provider. It delegates to the parent session's existing child factory.
 * Pass `resolve` only from tests; production uses the session binding.
 */
export function inProcessChildAgentProvider(
  resolve: (sessionKey: string) => InProcessChildBackend | undefined = (sessionKey) =>
    childBackend(sessionKey),
): CursorProvider {
  const capabilities = IN_PROCESS_CHILD_CAPABILITIES
  const connect = async (
    task: string,
    options: ChildAgentStartOptions,
    recovering: boolean,
  ): Promise<CursorHandle> => {
    if (!task) throw new Error('child task must not be empty')
    options.signal.throwIfAborted()
    assertChildAgentAllowed(options.sessionKey, {
      providerId: IN_PROCESS_CHILD_PROVIDER_ID,
      ...(options.model ? { model: options.model } : {}),
    })
    requireCapability(
      !options.fork || capabilities.inheritsParentContext,
      'provider cannot inherit parent context',
    )
    requireCapability(!options.model || capabilities.modelSelection, 'provider cannot select a child model')
    requireCapability(
      options.isolation !== 'worktree' || capabilities.worktree,
      'provider cannot isolate a child worktree',
    )
    const backend = resolve(options.sessionKey)
    if (!backend) throw new Error(`in-process child agents are not bound for session ${options.sessionKey}`)
    const cwd = options.cwd
    if (!cwd) throw new Error('in-process child start requires a working directory')
    const input: ResidentStart = {
      task,
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
      cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.isolation ? { isolation: options.isolation } : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
      ...(options.fork ? { fork: true } : {}),
      ...(options.toolFilter ? { toolFilter: options.toolFilter } : {}),
    }
    let started: { id: string }
    if (recovering) {
      if (!backend.adoptResident || !options.invocationId)
        throw new Error('in-process backend cannot adopt this invocation')
      started = await backend.adoptResident({ ...input, invocationId: options.invocationId })
    } else started = await backend.startResident(input)
    const events = handleEvents(backend.childEvents, started.id)
    const { queue, publish } = events
    publish({ type: 'status', status: 'running' })
    let observedTurn = false
    const stopTurn = backend.onTurn(started.id, (event) => {
      observedTurn = true
      if (event.text) publish({ type: 'text', text: event.text })
      publish({ type: 'status', status: event.status })
      if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled')
        queue.settle({
          status: event.status,
          text: event.text,
        })
    })
    const stop = () => {
      stopTurn()
      events.stop()
    }
    if (recovering) {
      const snapshot = (await backend.list()).find((child) => child.id === started.id)
      if (!observedTurn && snapshot?.text) publish({ type: 'text', text: snapshot.text })
      if (!observedTurn && snapshot) publish({ type: 'status', status: snapshot.status })
    }
    void backend.completion(started.id).then(
      (value) => {
        stop()
        queue.settle(value)
      },
      (error: unknown) => {
        stop()
        queue.fail(error)
      },
    )
    let disposal: Promise<void> | undefined
    const dispose = () => {
      disposal ??= (async () => {
        options.signal.removeEventListener('abort', onAbort)
        try {
          await backend.cancel(started.id)
          queue.settle({ status: 'cancelled', text: '' })
        } finally {
          stop()
        }
      })()
      return disposal
    }
    const onAbort = () => {
      void dispose().catch((error) => queue.fail(error))
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    if (options.signal.aborted) {
      await dispose()
      options.signal.throwIfAborted()
    }
    return {
      id: started.id,
      providerId: IN_PROCESS_CHILD_PROVIDER_ID,
      capabilities,
      events: queue.events,
      sendMessage: (text, signal) => backend.sendMessage(started.id, text, signal),
      interrupt: () => backend.interrupt(started.id),
      result: () => queue.result,
      dispose,
    }
  }
  return {
    id: IN_PROCESS_CHILD_PROVIDER_ID,
    version: '1.0.0',
    capabilities,
    list: (sessionKey) => listChildren(resolve(sessionKey), sessionKey),
    start: (task, options) => connect(task, options, false),
    adopt: (task, options) => connect(task, options, true),
  }
}
