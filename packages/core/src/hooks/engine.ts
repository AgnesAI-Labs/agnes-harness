import type {
  HookContext,
  HookEvent,
  HookHandler,
  HookInvocationSnapshot,
  HookPayloadMap,
  HookReturnMap,
  PlatformFacts,
} from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import { HookRegistry, type HookSnapshot } from '../registry/hooks.js'
import type { ToolSource } from '../registry/tools.js'
import { CoreError, type Disposer } from '../types.js'
import type { WorkspaceHookSandbox } from '../workspace/runtime.js'
import { type DispatchOutcome, HookDispatch } from './dispatch.js'
import { authorHookReturn } from './returns.js'

/** Host-private, non-wire capability read only by the bundled hooks runner adapter. */
export const WORKSPACE_HOOK_SANDBOX: unique symbol = Symbol('agnes.workspace-hook-sandbox')
/** Host-private sentinel for a pre-registered adapter with no participant this invocation. */
export const HOOK_UNHANDLED: unique symbol = Symbol('agnes.hook-unhandled')

// The engine fills platform itself (assembly-time facts handed in at construction), so a dispatch
// caller never supplies it - one source, one snapshot, identical for every hook of the kernel.
export type DispatchContext = Omit<HookContext, 'lease' | 'projections' | 'platform'> & {
  lease?: HookContext['lease']
  workspaceHooks?: HookInvocationSnapshot
  workspaceSandbox?: WorkspaceHookSandbox
}
type EngineOptions = ConstructorParameters<typeof HookDispatch>[0] & {
  leaseFor?: (source: string) => HookContext['lease'] | undefined
  /** Host-owned capability check. No structural or frozen-object guess may preserve identity. */
  retainSessionRefIdentity?: (session: HookContext['session']) => boolean
  /** Read-only facts every hook context carries (spec 2026-09-15 §4 row 9). Required: no default platform. */
  platform: PlatformFacts
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Reject accessors before structuredClone can invoke them while reading an author-supplied value. */
function assertCloneableData(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  let descriptors: PropertyDescriptorMap
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch (cause) {
    throw new CoreError('E_ENVELOPE', 'invalid hook session identity', { cause })
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!('value' in descriptor))
      throw new CoreError('E_ENVELOPE', 'hook session identity cannot contain accessors')
    assertCloneableData(descriptor.value, seen)
  }
}

function snapshotSession(
  session: HookContext['session'],
  retainIdentity?: (session: HookContext['session']) => boolean,
): HookContext['session'] {
  // Only an exact capability already registered by the Host may cross by identity. WeakMap-backed
  // predicates do not inspect proxies or execute getters; all ordinary caller values stay isolated.
  if (retainIdentity?.(session) === true) return session
  assertCloneableData(session)
  try {
    return freeze(structuredClone(session))
  } catch (cause) {
    throw new CoreError('E_ENVELOPE', 'invalid hook session identity', { cause })
  }
}

/** Snapshot data for each invocation; the only callable payload field is the lazy surface reader. */
function payloadSnapshot<E extends HookEvent>(payload: HookPayloadMap[E]): HookPayloadMap[E] {
  const { getSurface, ...data } = payload as HookPayloadMap[E] & { getSurface?: () => unknown }
  const snapshot = structuredClone(data)
  return freeze({
    ...snapshot,
    ...(getSurface ? { getSurface: () => freeze(structuredClone(getSurface())) } : {}),
  }) as HookPayloadMap[E]
}

/** Typed registration and invocation. Event adapters own rebuilding input after a validated return. */
export class HookEngine {
  private readonly dispatcher: HookDispatch

  constructor(
    private readonly options: EngineOptions,
    private readonly registry = new HookRegistry(),
  ) {
    this.dispatcher = new HookDispatch(options)
  }

  on<E extends HookEvent>(event: E, handler: NoInfer<HookHandler<E>>, meta: ToolSource): Disposer {
    return this.registry.on(event, handler, meta)
  }

  snapshot(source?: string): HookSnapshot {
    return this.registry.snapshot(source)
  }

  resetTurn(): void {
    this.dispatcher.resetTurn()
  }

  /**
   * readPayload supplies the current event-specific input, including prior accepted transformations.
   * accept is called only after author schema validation and timeout arbitration have succeeded.
   */
  async dispatch<E extends HookEvent>(
    event: E,
    readPayload: () => HookPayloadMap[E],
    context: DispatchContext,
    options: {
      snapshot?: HookSnapshot
      accept?: (value: HookReturnMap[E], source: string) => void
      terminal?: (value: HookReturnMap[E]) => boolean
    } = {},
  ): Promise<DispatchOutcome<HookReturnMap[E]>> {
    const entries = (options.snapshot ?? this.snapshot()).entries(event)
    const session = snapshotSession(context.session, this.options.retainSessionRefIdentity)
    const identity = Object.freeze({ session })
    const legacyLease = context.lease && freeze(structuredClone(context.lease))
    const log = Object.freeze({
      debug: context.log.debug.bind(context.log),
      info: context.log.info.bind(context.log),
      warn: context.log.warn.bind(context.log),
      error: context.log.error.bind(context.log),
    })
    return this.dispatcher.run(
      event,
      entries.map((registration) => ({
        source: registration.meta.source,
        invoke: async ({ signal, replayed }) => {
          const lease = this.options.leaseFor ? this.options.leaseFor(registration.meta.source) : legacyLease
          if (!lease) throw new CoreError('E_ENVELOPE', 'hook source lease unavailable')
          const payload = payloadSnapshot(readPayload())
          const handlerContext: HookContext = Object.freeze({
            ...identity,
            projections: unavailableProjections,
            platform: this.options.platform,
            lease: freeze(structuredClone(lease)),
            log,
            signal,
            replayed,
            ...(context.workspaceHooks
              ? { workspaceHooks: freeze(structuredClone(context.workspaceHooks)) }
              : {}),
            ...(context.workspaceSandbox ? { [WORKSPACE_HOOK_SANDBOX]: context.workspaceSandbox } : {}),
          })
          const handler = registration.handler as HookHandler<E>
          const invoke = async () => {
            const value = await handler(payload, handlerContext)
            return value === (HOOK_UNHANDLED as unknown) ? (value as never) : authorHookReturn(event, value)
          }
          // Emit dispatches and timeout arbitration may stop awaiting a handler before its raw
          // promise settles. When a Host-fitted workspace sandbox is present, register that raw
          // promise with the invocation scope so its lease cannot be released underneath it.
          return context.workspaceSandbox?.track ? context.workspaceSandbox.track(() => invoke()) : invoke()
        },
      })),
      context.signal,
      {
        replayed: context.replayed,
        ...(options.accept ? { commit: options.accept } : {}),
        ...(options.terminal ? { terminal: options.terminal } : {}),
      },
    )
  }
}
