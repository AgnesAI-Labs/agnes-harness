import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { ExecutionDomain } from '@agnes/protocol'
import type { Timers } from '../log/session-log.js'
import type { Clock } from '../types.js'
import { CoreError, type Seq } from '../types.js'
import type {
  WorkspaceInvocationPort,
  WorkspaceInvocationView,
  WorkspacePublicationDispatch,
} from '../workspace/runtime.js'
import type { ExecuteAttempt, ExecutePermitRegistry } from './execute-permits.js'
import { type HumanWaitScope, ManagedToolBudget } from './managed-human-wait.js'
import type { FsOps, ToolContextDeps } from './tool-context.js'
import {
  assertToolDispatchAvailable,
  dispatchTool,
  type HostDispatchObservation,
  type HostToolDispatchPort,
} from './tool-dispatch.js'

/** Host-owned bindings for a single already authorized, durably announced tool attempt. */
export interface PermittedToolDispatch {
  readonly name: string
  readonly args: unknown
  readonly context: ToolContext
  readonly executionDomain: ExecutionDomain
  readonly attempt: ExecuteAttempt
  readonly effectId: string
  readonly startSeq: Seq
  readonly owner: object
  readonly permits: ExecutePermitRegistry
  readonly hostPort?: HostToolDispatchPort
  readonly invoke: () => Promise<ToolResult>
}

/**
 * Consume one session-owned execution capability before the trusted dispatch boundary. This
 * function neither authorizes a call nor decides to replay one. The caller must first commit its
 * action/effect intent and pass that receipt's sequence; restoration of attempt counters belongs
 * exclusively to that runtime's recovery path. Native operation replacements wrap invoke at the
 * Native adapter; alternate runtimes never receive those replacements.
 */
export function dispatchPermittedTool(input: PermittedToolDispatch): Promise<HostDispatchObservation> {
  assertToolDispatchAvailable(input.executionDomain, input.hostPort)
  const binding = {
    effectId: input.effectId,
    startSeq: input.startSeq,
    owner: input.owner,
    attempt: input.attempt,
  }
  const permit = input.permits.issue(binding)
  input.permits.consume(permit, binding)
  return dispatchTool({
    name: input.name,
    args: input.args,
    context: input.context,
    executionDomain: input.executionDomain,
    attempt: input.attempt,
    ...(input.hostPort ? { hostPort: input.hostPort } : {}),
    invoke: input.invoke,
  })
}

/** Workspace capabilities and the controlled dispatcher, supplied by a Host adapter. */
export interface ToolExecutionContext {
  readonly name: string
  readonly executionDomain: ExecutionDomain
  readonly timeoutMs: number
  readonly signal: AbortSignal
  /** Trusted nested-call ancestry; never read from extension tool arguments. */
  readonly humanWaitParent?: HumanWaitScope
  readonly timers?: Timers
  readonly monotonicClock?: Clock
  readonly workspaceInvocation?: WorkspaceInvocationPort
  readonly workspacePublication?: WorkspacePublicationDispatch
  /** Register the actual invocation lifetime so cancellation can abort and drain it. */
  track?(pending: Promise<HostDispatchObservation>): void
  createContext(fs: FsOps, workspace?: ToolContextDeps['workspace']): ToolContext
  /** Must consume the durably bound permit, e.g. through dispatchPermittedTool. */
  dispatch(context: ToolContext): Promise<HostDispatchObservation>
}

export interface ToolAttemptObservation {
  readonly observation: HostDispatchObservation
  readonly timedOut: boolean
  readonly cancelled: boolean
}

const unavailableFs = (): Promise<never> =>
  Promise.reject(
    new CoreError('E_WORKSPACE_CLOSED', 'filesystem is unavailable outside a workspace invocation'),
  )
const NO_WORKSPACE_FS: FsOps = Object.freeze({
  read: unavailableFs,
  write: unavailableFs,
  list: unavailableFs,
  stat: unavailableFs,
})

/**
 * Run exactly one attempt under the workspace invocation and publication fences. The owning
 * runtime has already persisted intent before calling. Returned transport evidence is not a
 * business-success assertion: only that runtime settles its action and decides whether another
 * attempt is permitted. Timeout or cancellation cannot prove a sent mutation did not happen.
 */
export async function dispatchToolAttempt(ctx: ToolExecutionContext): Promise<ToolAttemptObservation> {
  if (ctx.signal.aborted)
    return {
      observation: { phase: 'not_sent', error: ctx.signal.reason ?? new Error('cancelled before dispatch') },
      timedOut: false,
      cancelled: true,
    }
  const budget = new ManagedToolBudget({
    timeoutMs: ctx.timeoutMs,
    label: ctx.name,
    signal: ctx.signal,
    ...(ctx.humanWaitParent ? { parent: ctx.humanWaitParent } : {}),
    ...(ctx.timers ? { timers: ctx.timers } : {}),
    ...(ctx.monotonicClock ? { monotonicClock: ctx.monotonicClock } : {}),
  })
  const invoke = (): Promise<HostDispatchObservation> => {
    const port = ctx.workspaceInvocation
    if (port) {
      const handler = async (view: WorkspaceInvocationView) => {
        const confined = await view.ready(ctx.signal)
        const context = budget.bind(
          ctx.createContext(view.fs(), {
            sandbox: view.hookSandbox(),
            confine: (argv) => confined.confine(argv),
            checkpoint: view.checkpointContext(),
          }),
        )
        return ctx.dispatch(context)
      }
      return ctx.workspacePublication
        ? ctx.workspacePublication.workspace(() => ({ port, handler }))
        : port.run(handler)
    }
    if (ctx.executionDomain === 'workspace')
      throw new CoreError('E_WORKSPACE_CLOSED', 'workspace tool execution needs an invocation port')
    return ctx.dispatch(budget.bind(ctx.createContext(NO_WORKSPACE_FS)))
  }
  try {
    budget.signal.throwIfAborted()
    const pending = invoke()
    const observing = budget.run(pending)
    void observing.catch(() => undefined)
    ctx.track?.(pending)
    const observation = await observing
    return { observation, timedOut: false, cancelled: false }
  } catch (error) {
    const timedOut = error instanceof Error && error.message.startsWith('timeout:')
    return {
      observation: { phase: 'may_have_sent', error },
      timedOut,
      cancelled: !timedOut && ctx.signal.aborted,
    }
  } finally {
    budget.close()
  }
}
