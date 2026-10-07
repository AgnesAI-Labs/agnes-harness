import { randomUUID } from 'node:crypto'
import { createChildEventQueue, trackExternalChild, updateExternalChild } from '@agnes/core'
import type {
  ChildAgentCapabilities,
  ChildAgentHandle,
  ChildAgentListing,
  ChildAgentResult,
  ChildAgentStartOptions,
  ChildAgentStatus,
} from '@agnes/extension-api'
import type { EngineProcess } from './process.js'

const listings = new Map<string, Map<string, ChildAgentListing>>()

export function listEngineChildren(sessionKey: string, providerId: string): readonly ChildAgentListing[] {
  return [...(listings.get(sessionKey)?.values() ?? [])].filter((child) => child.providerId === providerId)
}

export function refuseUnsupportedChildOptions(
  options: ChildAgentStartOptions,
  capabilities: ChildAgentCapabilities,
): void {
  if (options.fork && !capabilities.inheritsParentContext)
    throw new Error('provider cannot inherit parent context')
  if (options.model && !capabilities.modelSelection) throw new Error('provider cannot select a child model')
  if (options.isolation === 'worktree' && !capabilities.worktree)
    throw new Error('provider cannot isolate a child worktree')
  if (options.budget !== undefined && !capabilities.budget)
    throw new Error('provider cannot enforce a child budget')
  if (options.toolFilter !== undefined && !capabilities.toolFilter)
    throw new Error('provider cannot filter child tools')
}

export type EngineWireEvent =
  | { kind: 'text'; text: string }
  | { kind: 'done'; status: 'completed' | 'failed' | 'cancelled'; text?: string }
  | { kind: 'ignore' }

function remember(sessionKey: string, listing: ChildAgentListing): void {
  let session = listings.get(sessionKey)
  if (!session) {
    session = new Map()
    listings.set(sessionKey, session)
  }
  session.set(listing.id, listing)
}

function forget(sessionKey: string, id: string): void {
  const session = listings.get(sessionKey)
  session?.delete(id)
  if (session?.size === 0) listings.delete(sessionKey)
}

/**
 * One process, one turn. Interrupt kills the turn and leaves the handle until dispose.
 * sendMessage is refused because the process is not continuable.
 */
export function attachOneShot(input: {
  idPrefix: string
  providerId: string
  capabilities: ChildAgentCapabilities
  options: ChildAgentStartOptions
  process: EngineProcess
  interpret(message: unknown): EngineWireEvent
  cancel?(): void
}): ChildAgentHandle {
  const id = `${input.idPrefix}:${randomUUID()}`
  const queue = createChildEventQueue()
  const { options, capabilities } = input
  let text = ''
  let status: ChildAgentStatus = 'starting'
  let terminal = false
  let interruptRequested = false
  let disposal: Promise<void> | undefined
  const listing = (): ChildAgentListing => ({
    id,
    providerId: input.providerId,
    status,
    continuable: false,
    ...(text ? { text } : {}),
  })
  const publish = (next: ChildAgentStatus) => {
    const changed = status !== next
    status = next
    const current = listing()
    remember(options.sessionKey, current)
    updateExternalChild(options.sessionKey, id, current)
    if (changed) queue.push({ type: 'status', status: next })
  }
  const append = (chunk: string) => {
    if (!chunk || terminal) return
    text += chunk
    queue.push({ type: 'text', text: chunk })
    const current = listing()
    remember(options.sessionKey, current)
    updateExternalChild(options.sessionKey, id, current)
  }
  const finish = (next: ChildAgentResult['status']) => {
    if (terminal) return
    terminal = true
    publish(next)
    options.signal.removeEventListener('abort', onAbort)
    queue.settle({ status: next, text })
  }
  const untrack = trackExternalChild(options.sessionKey, {
    listing: listing(),
    interrupt: () => stop(),
  })
  function stop(): Promise<{ accepted: boolean }> {
    if (terminal) return Promise.resolve({ accepted: false })
    interruptRequested = true
    try {
      input.cancel?.()
    } catch {
      /* The process kill below is the cancellation. */
    }
    void input.process.kill()
    finish('interrupted')
    return Promise.resolve({ accepted: true })
  }
  const handle: ChildAgentHandle = {
    id,
    providerId: input.providerId,
    capabilities,
    events: () => queue.events(),
    sendMessage: () => Promise.reject(new Error('child engine is not continuable')),
    interrupt: stop,
    result: () => queue.result,
    dispose() {
      disposal ??= (async () => {
        if (!terminal) finish('cancelled')
        untrack()
        forget(options.sessionKey, id)
        await input.process.kill()
      })()
      return disposal
    },
  }
  const onAbort = () => {
    void handle.dispose().catch((error) => queue.fail(error))
  }
  options.signal.addEventListener('abort', onAbort, { once: true })
  input.process.onMessage = (message) => {
    if (terminal) return
    let event: EngineWireEvent
    try {
      event = input.interpret(message)
    } catch {
      queue.push({ type: 'error', message: 'child engine protocol error' })
      finish('failed')
      return
    }
    if (event.kind === 'text') {
      publish('running')
      append(event.text)
      return
    }
    if (event.kind === 'done') {
      if (event.text && !text) append(event.text)
      finish(interruptRequested ? 'interrupted' : event.status === 'cancelled' ? 'cancelled' : event.status)
    }
  }
  input.process.onProtocolError = () => {
    if (terminal) return
    queue.push({ type: 'error', message: 'child engine protocol error' })
    finish('failed')
  }
  void input.process.exited.then((exit) => {
    if (terminal) return
    if (interruptRequested || exit.signal) finish('interrupted')
    else if (exit.code === 0 && text) finish('completed')
    else {
      queue.push({ type: 'error', message: 'child engine exited' })
      finish('failed')
    }
  })
  if (options.signal.aborted) onAbort()
  publish('running')
  return handle
}
