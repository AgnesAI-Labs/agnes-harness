import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { WORKSPACE_HOOK_SANDBOX, type WorkspaceHookSandbox } from '@agnes/core'
import type {
  ExtensionFactory,
  HookEvent,
  HookInvocationSnapshot,
  HookPayloadMap,
  HookReturnMap,
  LeaseView,
  PlatformFacts,
  SessionRef,
} from '@agnes/extension-api'
import { HOOK_EVENTS } from '@agnes/extension-api'
import { HostError } from '../errors.js'
import { connectExtensionRunner } from './runner-transport.js'

const workspaceSandboxes = new AsyncLocalStorage<WorkspaceHookSandbox>()

export type HooksRunnerBootstrap = {
  nonce: string
  packageDigest: string
  manifestDigest: string
  extensionId: string
  data: Record<string, unknown>
}

export type IsolatedHooksRunner = {
  readonly pid: number
  readonly events: readonly HookEvent[]
  readonly registrations?: readonly { id: string; event: HookEvent }[]
  onUnregister?(listener: (event: string) => void): () => void
  onFailure(listener: (error: Error) => void): () => void
  invoke<E extends HookEvent>(
    event: E,
    payload: HookPayloadMap[E],
    context: {
      session: SessionRef
      lease: LeaseView
      replayed: boolean
      platform: PlatformFacts
      workspaceHooks?: HookInvocationSnapshot
      signal: AbortSignal
    },
    registrationId?: string,
  ): Promise<HookReturnMap[E]>
  close(): Promise<void>
}

/** Adapt the fixed remote event list to the existing managed-host factory boundary. */
export function isolatedHooksRunnerFactory(
  start: () => Promise<IsolatedHooksRunner>,
  onFailure: (error: Error) => void = () => undefined,
): ExtensionFactory {
  return async (api) => {
    const runner = await start()
    const disposers = new Map<string, () => void>()
    let stopWatching = () => {},
      stopWithdrawals = () => {}
    const clear = (): void => {
      const callbacks = [...disposers.values()].reverse()
      disposers.clear()
      const errors: unknown[] = []
      for (const dispose of callbacks) {
        try {
          dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'hook registration cleanup failed')
    }
    try {
      for (const { id, event } of runner.registrations ??
        runner.events.map((event) => ({ id: event, event })))
        disposers.set(
          id,
          api.registerHook(event, (payload, context) => {
            const sandbox = (context as typeof context & { [WORKSPACE_HOOK_SANDBOX]?: WorkspaceHookSandbox })[
              WORKSPACE_HOOK_SANDBOX
            ]
            const invoke = () =>
              runner.invoke(
                event,
                payload,
                {
                  session: context.session,
                  lease: context.lease,
                  replayed: context.replayed,
                  platform: context.platform,
                  ...(context.workspaceHooks ? { workspaceHooks: context.workspaceHooks } : {}),
                  signal: context.signal,
                },
                id,
              )
            return sandbox ? workspaceSandboxes.run(sandbox, invoke) : invoke()
          }),
        )
      stopWithdrawals =
        runner.onUnregister?.((event) => {
          const dispose = disposers.get(event)
          disposers.delete(event)
          dispose?.()
        }) ?? (() => {})
      let failure: Error | undefined
      stopWatching = runner.onFailure((error) => {
        failure = error
        try {
          clear()
        } finally {
          onFailure(error)
        }
      })
      if (failure) throw failure
    } catch (error) {
      stopWatching()
      stopWithdrawals()
      try {
        clear()
      } catch {
        /* The managed bag retains failed cleanup diagnostics. */
      }
      await runner.close()
      throw error
    }
    return async () => {
      stopWatching()
      stopWithdrawals()
      try {
        clear()
      } finally {
        await runner.close()
      }
    }
  }
}

export async function connectIsolatedHooksRunner(
  child: ChildProcessWithoutNullStreams,
  bootstrap: HooksRunnerBootstrap,
  capability: (
    method: string,
    input: unknown,
    signal: AbortSignal,
    invocation: {
      event: HookEvent
      payload: unknown
      session: SessionRef
      workspaceHooks?: HookInvocationSnapshot
      sandbox?: WorkspaceHookSandbox
    },
  ) => Promise<unknown>,
  startupTimeoutMs?: number,
): Promise<IsolatedHooksRunner> {
  const eventsById = new Map<string, HookEvent>()
  const runner = await connectExtensionRunner(
    child,
    bootstrap,
    (method, input, signal, invocation) => {
      const sandbox = workspaceSandboxes.getStore()
      const invoke = () =>
        capability(method, input, signal, {
          event: eventsById.get(invocation.event) ?? (invocation.event as HookEvent),
          payload: invocation.payload,
          session: invocation.context.session as SessionRef,
          ...(invocation.context.workspaceHooks
            ? { workspaceHooks: invocation.context.workspaceHooks as HookInvocationSnapshot }
            : {}),
          ...(sandbox ? { sandbox } : {}),
        })
      // An isolated handler may send a result without awaiting an HTTP/event request. Join the raw
      // Host capability promise to the same workspace invocation before calling the adapter.
      return sandbox?.track ? sandbox.track(() => invoke()) : invoke()
    },
    startupTimeoutMs,
  )
  const events = runner.proposal.events
  if (
    !Array.isArray(events) ||
    events.length > HOOK_EVENTS.length ||
    new Set(events).size !== events.length ||
    events.some((event) => typeof event !== 'string' || !HOOK_EVENTS.includes(event as HookEvent))
  ) {
    await runner.close()
    throw new HostError('E_EXT_LOAD', 'invalid ready event list')
  }
  const hooks = runner.proposal.hooks
  if (
    hooks !== undefined &&
    (!Array.isArray(hooks) ||
      hooks.length > 1024 ||
      hooks.some(
        (h) =>
          !h ||
          typeof h !== 'object' ||
          Array.isArray(h) ||
          typeof h.id !== 'string' ||
          !/^h-[1-9][0-9]{0,3}$/.test(h.id) ||
          !events.includes(h.event),
      ) ||
      new Set(hooks.map((h) => (h as { id: string }).id)).size !== hooks.length)
  ) {
    await runner.close()
    throw new HostError('E_EXT_LOAD', 'invalid ready hook registrations')
  }
  if (Array.isArray(hooks))
    for (const hook of hooks as { id: string; event: HookEvent }[]) eventsById.set(hook.id, hook.event)
  return Object.freeze({
    ...(hooks ? { registrations: Object.freeze(hooks as { id: string; event: HookEvent }[]) } : {}),
    pid: runner.pid,
    events: Object.freeze(events as HookEvent[]),
    onFailure: runner.onFailure,
    onUnregister: runner.onUnregister,
    close: runner.close,
    invoke<E extends HookEvent>(
      event: E,
      payload: HookPayloadMap[E],
      context: {
        session: SessionRef
        lease: LeaseView
        replayed: boolean
        platform: PlatformFacts
        workspaceHooks?: HookInvocationSnapshot
        signal: AbortSignal
      },
      registrationId?: string,
    ): Promise<HookReturnMap[E]> {
      const { signal, ...data } = context
      const surface =
        event === 'context' || event === 'before_compact'
          ? (payload as HookPayloadMap['context']).getSurface()
          : undefined
      return runner.invoke(
        registrationId ?? event,
        payload,
        { ...data, ...(surface ? { surface } : {}) },
        signal,
      ) as Promise<HookReturnMap[E]>
    },
  })
}
