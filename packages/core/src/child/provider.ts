import type {
  ChildAgentCapabilities,
  ChildAgentEvent,
  ChildAgentHandle,
  ChildAgentListing,
  ChildAgentProvider,
  ChildAgentResult,
  ChildAgentStartOptions,
  ChildAgentStatus,
  ChildAgentToolFilter,
} from '@agnes/extension-api'
import { assertChildAgentAllowed } from './allowlist.js'
import { createChildEventQueue } from './events.js'
import { childBackend } from './sessions.js'

export const IN_PROCESS_CHILD_PROVIDER_ID = 'in-process'

export const IN_PROCESS_CHILD_CAPABILITIES: ChildAgentCapabilities = Object.freeze({
  continuable: true,
  interrupt: true,
  modelSelection: true,
  inheritsParentContext: true,
  // Git worktree preparation belongs to the official tool's deferred-start path.
  worktree: false,
  budget: true,
  toolFilter: true,
})

export type ResidentStart = {
  task: string
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
  startResident(input: ResidentStart): Promise<{ id: string }>
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

/**
 * The default provider. It delegates to the parent session's existing child factory.
 * Pass `resolve` only from tests; production uses the session binding.
 */
export function inProcessChildAgentProvider(
  resolve: (sessionKey: string) => InProcessChildBackend | undefined = (sessionKey) =>
    childBackend(sessionKey),
): ChildAgentProvider {
  const capabilities = IN_PROCESS_CHILD_CAPABILITIES
  return {
    id: IN_PROCESS_CHILD_PROVIDER_ID,
    version: '1.0.0',
    capabilities,
    list: async (sessionKey) => (await resolve(sessionKey)?.list()) ?? [],
    async start(task, options: ChildAgentStartOptions): Promise<ChildAgentHandle> {
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
        cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.isolation ? { isolation: options.isolation } : {}),
        ...(options.budget !== undefined ? { budget: options.budget } : {}),
        ...(options.fork ? { fork: true } : {}),
        ...(options.toolFilter ? { toolFilter: options.toolFilter } : {}),
      }
      const queue = createChildEventQueue()
      const publish = (event: ChildAgentEvent) => queue.push(event)
      const started = await backend.startResident(input)
      publish({ type: 'status', status: 'running' })
      const stop = backend.onTurn(started.id, (event) => {
        if (event.text) publish({ type: 'text', text: event.text })
        publish({ type: 'status', status: event.status })
        if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled')
          queue.settle({
            status: event.status,
            text: event.text,
          })
      })
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
          stop()
          await backend.cancel(started.id)
          queue.settle({ status: 'cancelled', text: '' })
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
        events: () => queue.events(),
        sendMessage: (text, signal) => backend.sendMessage(started.id, text, signal),
        interrupt: () => backend.interrupt(started.id),
        result: () => queue.result,
        dispose,
      }
    },
  }
}
