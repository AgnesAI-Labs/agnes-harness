import { randomUUID } from 'node:crypto'
import {
  assertChildAgentAllowed,
  createChildEventQueue,
  trackExternalChild,
  updateExternalChild,
} from '@agnes/core'
import type {
  ChildAgentCapabilities,
  ChildAgentHandle,
  ChildAgentListing,
  ChildAgentPluginContext,
  ChildAgentProvider,
  ChildAgentStartOptions,
  ChildAgentStatus,
} from '@agnes/extension-api'
import { AcpChildProcess, type AcpCommand } from './client.js'

export const ACP_CHILD_PROVIDER_ID = 'acp'

export const ACP_CHILD_CAPABILITIES: ChildAgentCapabilities = Object.freeze({
  continuable: true,
  interrupt: true,
  modelSelection: false,
  inheritsParentContext: false,
  worktree: false,
  budget: false,
  toolFilter: false,
})

export type AcpChildAgentOptions = Omit<AcpCommand, 'cwd'> & {
  /** Send `_agnes/v1/workspace.add` before `session/new`. Required when the child is another agh. */
  agnesWorkspace?: boolean
}

const listings = new Map<string, Map<string, ChildAgentListing>>()

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

function requireCapability(ok: boolean, message: string): void {
  if (!ok) throw new Error(message)
}

/**
 * Run an external ACP agent as a child. Missing capabilities are refused.
 * `result` settles when the process exits or the handle is disposed, not after each turn.
 */
export function acpChildAgentProvider(options: AcpChildAgentOptions): ChildAgentProvider {
  const capabilities = ACP_CHILD_CAPABILITIES
  return {
    id: ACP_CHILD_PROVIDER_ID,
    version: '1.0.0',
    capabilities,
    list: async (sessionKey) => [...(listings.get(sessionKey)?.values() ?? [])],
    async start(task, startOptions) {
      if (!task) throw new Error('child task must not be empty')
      startOptions.signal.throwIfAborted()
      requireCapability(!startOptions.fork, 'provider cannot inherit parent context')
      requireCapability(!startOptions.model, 'provider cannot select a child model')
      requireCapability(startOptions.isolation !== 'worktree', 'provider cannot isolate a child worktree')
      requireCapability(startOptions.budget === undefined, 'provider cannot enforce a child budget')
      requireCapability(startOptions.toolFilter === undefined, 'provider cannot filter child tools')
      assertChildAgentAllowed(startOptions.sessionKey, {
        providerId: ACP_CHILD_PROVIDER_ID,
        ...(startOptions.model ? { model: startOptions.model } : {}),
      })
      if (!startOptions.cwd) throw new Error('acp child start requires a working directory')
      const acp = new AcpChildProcess({
        command: options.command,
        ...(options.args ? { args: options.args } : {}),
        cwd: startOptions.cwd,
        ...(options.env ? { env: options.env } : {}),
      })
      const abortStartup = () => {
        void acp.kill()
      }
      startOptions.signal.addEventListener('abort', abortStartup, { once: true })
      try {
        await acp.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        })
        if (options.agnesWorkspace) await acp.request('_agnes/v1/workspace.add', { path: startOptions.cwd })
        const created = (await acp.request('session/new', {
          cwd: startOptions.cwd,
          mcpServers: [],
        })) as { sessionId?: string }
        if (!created.sessionId) throw new Error('acp session/new returned no sessionId')
        startOptions.signal.throwIfAborted()
        return openSession(acp, created.sessionId, task, startOptions, capabilities)
      } catch (error) {
        await acp.kill()
        startOptions.signal.throwIfAborted()
        throw error
      } finally {
        startOptions.signal.removeEventListener('abort', abortStartup)
      }
    },
  }
}

function openSession(
  acp: AcpChildProcess,
  sessionId: string,
  task: string,
  options: ChildAgentStartOptions,
  capabilities: ChildAgentCapabilities,
): ChildAgentHandle {
  const id = `acp:${randomUUID()}`
  const queue = createChildEventQueue()
  const pending: string[] = []
  let text = ''
  let busy = false
  let disposed = false
  let disposal: Promise<void> | undefined
  let status: ChildAgentStatus = 'starting'
  const listing = (): ChildAgentListing => ({
    id,
    providerId: ACP_CHILD_PROVIDER_ID,
    status,
    continuable: true,
    ...(text ? { text } : {}),
  })
  const publishListing = (next: ChildAgentStatus) => {
    const changed = status !== next
    status = next
    const current = listing()
    remember(options.sessionKey, current)
    updateExternalChild(options.sessionKey, id, current)
    if (changed) queue.push({ type: 'status', status: next })
  }
  const untrack = trackExternalChild(options.sessionKey, {
    listing: listing(),
    sendMessage: (value, signal) => deliver(value, signal),
    interrupt: () => stopTurn(),
  })
  const finish = (next: 'completed' | 'failed' | 'cancelled') => {
    if (disposed) return
    disposed = true
    untrack()
    forget(options.sessionKey, id)
    options.signal.removeEventListener('abort', onAbort)
    queue.settle({ status: next, text })
    void acp.kill()
  }
  const pump = () => {
    if (disposed || busy) return
    const next = pending.shift()
    if (next === undefined) return
    busy = true
    publishListing('running')
    acp.onChunk = (chunk) => {
      text += chunk
      queue.push({ type: 'text', text: chunk })
      const current = listing()
      remember(options.sessionKey, current)
      updateExternalChild(options.sessionKey, id, current)
    }
    void acp
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: next }] })
      .then((result) => {
        acp.onChunk = undefined
        if (disposed) return
        const stopReason = (result as { stopReason?: string }).stopReason
        busy = false
        publishListing(stopReason === 'cancelled' || stopReason === 'canceled' ? 'interrupted' : 'idle')
        pump()
      })
      .catch((error: unknown) => {
        acp.onChunk = undefined
        busy = false
        if (disposed) return
        queue.push({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        finish('failed')
      })
  }
  function deliver(value: string, signal: AbortSignal): Promise<{ messageId: string }> {
    signal.throwIfAborted()
    if (disposed) return Promise.reject(new Error('acp child is closed'))
    if (!value) return Promise.reject(new Error('message must not be empty'))
    pending.push(value)
    pump()
    return Promise.resolve({ messageId: `acp-msg-${randomUUID()}` })
  }
  function stopTurn(): Promise<{ accepted: boolean }> {
    if (!busy || disposed) return Promise.resolve({ accepted: false })
    acp.notify('session/cancel', { sessionId })
    return Promise.resolve({ accepted: true })
  }
  const handle: ChildAgentHandle = {
    id,
    providerId: ACP_CHILD_PROVIDER_ID,
    capabilities,
    events: () => queue.events(),
    sendMessage: deliver,
    interrupt: stopTurn,
    result: () => queue.result,
    dispose() {
      disposal ??= (async () => {
        if (!disposed) {
          if (busy) acp.notify('session/cancel', { sessionId })
          finish('cancelled')
        }
        await acp.kill()
      })()
      return disposal
    },
  }
  const onAbort = () => {
    void handle.dispose().catch((error) => queue.fail(error))
  }
  options.signal.addEventListener('abort', onAbort, { once: true })
  acp.onExit = (error) => {
    if (disposed) return
    queue.push({ type: 'error', message: error.message })
    finish('failed')
  }
  if (options.signal.aborted) onAbort()
  publishListing('starting')
  void deliver(task, new AbortController().signal)
  return handle
}

export function acpChildAgentsPlugin(options: AcpChildAgentOptions) {
  const provider = acpChildAgentProvider(options)
  return {
    inject: ['childAgents'] as const,
    apply(ctx: ChildAgentPluginContext) {
      ctx.childAgents.register(provider)
    },
  }
}
