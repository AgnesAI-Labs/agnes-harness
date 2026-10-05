import {
  type ContextFactoryOptions,
  createContextFactory,
  createDefaultLoopFactory,
  createDefaultToolsFactory,
  type DefaultLoopSource,
  type ToolsDeployment,
} from '@agnes/core'
import type {
  ActionProviderFactory,
  CallContext,
  FactoryContext,
  LoopReadPorts,
  Outcome,
  ProviderLifecycle,
  ScopedDependencies,
  ServiceProvider,
  StateStoreControl,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { runtimeAdmissionRefusal as refusal } from './entry-admission.js'
import type { HostPermissionGrant, HostSelectedProvider } from './scoped-dependencies.js'

/** Native owner adapters only. State owns commits, refusal facts and replay decisions. */
export type HostRuntimeLoopRun = Readonly<{
  frame: W.RunFrame
  contextFor(binding: W.BindingRef): CallContext
  factoryContextFor(binding: W.BindingRef): FactoryContext
  reads: LoopReadPorts
  state?: Readonly<{
    control: Pick<StateStoreControl, 'acceptInbox' | 'advanceRun' | 'publishActionResult'>
    /** Native adapter invokes control.advanceRun with its original guard, then rereads the committed frame. */
    commit(frame: W.RunFrame, transition: W.LoopTransition): Promise<Outcome<W.RunFrame>>
  }>
  supervisor?: Readonly<{
    dispatch(
      frame: W.RunFrame,
      transition: W.LoopTransition,
      actions: ReadonlyMap<string, ActionProviderFactory>,
      state: NonNullable<HostRuntimeLoopRun['state']>,
    ): Promise<Outcome<W.RunFrame>>
  }>
  /** C04 infer factory, assembled by its owner with the binding-scoped model egress. */
  model?: ActionProviderFactory
  /** Cold frames must come from the original durable continuation/source reader. */
  coldState?: Readonly<{ check(frame: W.RunFrame): Promise<Outcome<void>> }>
  close(): Promise<void>
}>

export type HostRuntimeLoopInstallation = Readonly<{
  tools: Omit<ToolsDeployment, 'verifyCall'>
  /** The original model/Run/Action/pure-stage source implements the existing verification contract. */
  toolCallSource?: Pick<ToolsDeployment, 'verifyCall'>
  /** Optional selected alternative implementing the same public factory SPI. */
  toolsFactory?: typeof createDefaultToolsFactory
  context: ContextFactoryOptions & Readonly<{ configuration: W.DataRef; binding: W.BindingRef }>
  loop: Readonly<{
    descriptor: W.ProviderDescriptor
    configuration: W.DataRef
    binding: W.BindingRef
    source: DefaultLoopSource
  }>
  /** Original selected Routing, Model and Supervisor bindings, registered in the same root. */
  peers: readonly HostSelectedProvider[]
  /** Current owner-issued grants; bootstrap package grants cannot authorize a run. */
  grants: readonly HostPermissionGrant[]
  open(request: W.RunAdmission, signal: AbortSignal): Promise<Outcome<HostRuntimeLoopRun | null>>
  /** Persist through the original State owner; an unavailable writer must refuse. */
  reject(request: W.RunAdmission, error: W.RuntimeError): Promise<Outcome<void>>
}>

const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(a as W.JsonValue) === canonicalJsonDigest(b as W.JsonValue)

/** Register factory identities at startup; instantiate run-scoped providers only after admission. */
export function selectHostRuntimeLoop(installation: HostRuntimeLoopInstallation) {
  const toolsFactory = (installation.toolsFactory ?? createDefaultToolsFactory)({
    ...installation.tools,
    verifyCall(call, frame, context) {
      return installation.toolCallSource
        ? installation.toolCallSource.verifyCall(call, frame, context)
        : Promise.resolve(
            refusal(
              'incompatible',
              call.modelContextRef === null
                ? 'tools_action_source_unavailable'
                : 'tools_model_context_source_unavailable',
            ),
          )
    },
  })
  const contextFactory = createContextFactory(installation.context)
  const loopFactory = createDefaultLoopFactory(installation.loop.descriptor, installation.loop.source)
  const entries = [
    { factory: toolsFactory, binding: installation.tools.definition.executor },
    { factory: contextFactory, binding: installation.context.binding },
    { factory: loopFactory, binding: installation.loop.binding },
  ]
  const instances = new Map<string, ReadonlyMap<string, ServiceProvider>>()
  function instance(binding: W.BindingRef, context: CallContext) {
    return 'runId' in context.scope ? instances.get(context.scope.runId)?.get(binding.bindingId) : undefined
  }
  for (const { factory, binding } of entries) {
    if (
      !validateRuntime('BindingRef', binding).ok ||
      binding.contract !== factory.descriptor.contract ||
      binding.providerId !== factory.descriptor.providerId ||
      binding.logicalName !== factory.descriptor.logicalName
    )
      throw new TypeError('Runtime factory selection differs from its installed binding')
  }
  const providers: HostSelectedProvider[] = [
    ...installation.peers,
    ...entries.map(({ factory, binding }) => ({
      binding,
      major: factory.descriptor.major,
      scope: factory.descriptor.scope,
      features: factory.descriptor.features,
      packageDigest: factory.descriptor.packageDigest,
      ownerId: binding.providerId,
      permissions: [],
      async query(request: W.ServiceQuery, context: CallContext) {
        const opened = instance(binding, context)
        return opened?.query
          ? opened.query(request, context)
          : refusal('incompatible', 'loop_run_provider_unavailable')
      },
      async compute(request: W.ServiceOperation, context: CallContext) {
        const opened = instance(binding, context)
        return opened?.compute
          ? opened.compute(request, context)
          : refusal('incompatible', 'loop_run_provider_unavailable')
      },
    })),
  ]
  const lifetime = new AbortController()
  const active = new Map<
    string,
    { fingerprint: W.Digest; stop: AbortController; pending: Promise<Outcome<void>> }
  >()
  let closed = false
  const cleanupFailures = new Set<string>()

  async function execute(
    dependencies: ScopedDependencies,
    request: W.RunAdmission,
    signal: AbortSignal,
  ): Promise<Outcome<void>> {
    let run: HostRuntimeLoopRun | undefined
    const owned: ProviderLifecycle[] = []
    let result: Outcome<void> = { ok: true, value: undefined }
    try {
      const opened = await installation.open(request, signal)
      if (!opened.ok) result = opened
      else if (opened.value) {
        run = opened.value
        let frame = run.frame
        if (
          !validateRuntime('RunFrame', frame).ok ||
          frame.runId !== request.runId ||
          frame.sessionId !== request.sessionId ||
          frame.workspaceId !== request.workspaceId ||
          frame.bindingId !== installation.loop.binding.bindingId ||
          !same(frame.input, request.input)
        )
          result = refusal('denied', 'loop_run_source_mismatch')
        else if (
          !run.state ||
          ['acceptInbox', 'advanceRun', 'publishActionResult'].some(
            (name) =>
              typeof run?.state?.control[
                name as keyof NonNullable<HostRuntimeLoopRun['state']>['control']
              ] !== 'function',
          )
        )
          result = refusal('incompatible', 'loop_state_transactions_unavailable')
        else if (!run.supervisor) result = refusal('incompatible', 'loop_supervisor_unavailable')
        else if (!run.model) result = refusal('incompatible', 'loop_model_action_unavailable')
        else if (frame.reason !== 'start' && !run.coldState)
          result = refusal('incompatible', 'loop_cold_state_consumer_unavailable')
        else {
          if (frame.reason !== 'start' && run.coldState) result = await run.coldState.check(frame)
          if (!result.ok) return await reject(result)
          const contextFor = run.contextFor.bind(run)
          const factoryContext = (binding: W.BindingRef) => {
            const original = run?.factoryContextFor(binding)
            if (!original) throw new Error('Run factory context unavailable')
            return { ...original, signal: AbortSignal.any([original.signal, signal]) }
          }
          const tools = await toolsFactory.create(
            installation.tools.configuration,
            dependencies,
            factoryContext(installation.tools.definition.executor),
          )
          owned.push(tools)
          const context = await contextFactory.create(
            installation.context.configuration,
            dependencies,
            factoryContext(installation.context.binding),
          )
          owned.push(context)
          instances.set(
            request.runId,
            new Map([
              [installation.tools.definition.executor.bindingId, tools],
              [installation.context.binding.bindingId, context],
            ]),
          )
          const loop = await loopFactory.create(
            installation.loop.configuration,
            dependencies,
            factoryContext(installation.loop.binding),
          )
          owned.push(loop)
          for (const [provider, binding] of [
            [tools, installation.tools.definition.executor],
            [context, installation.context.binding],
            [loop, installation.loop.binding],
          ] as const) {
            result = await provider.ready(contextFor(binding))
            if (!result.ok) break
          }
          const checkedTarget = (target: W.BindingRef) => {
            const selected = providers.find((provider) => same(provider.binding, target))
            if (!selected) return refusal('denied', 'loop_binding_not_selected')
            const found = dependencies.get({
              contract: target.contract,
              major: selected.major,
              logicalName: target.logicalName,
              scope: selected.scope,
              features: [],
              optional: false,
            })
            return found.ok && !same(found.value.binding, target)
              ? refusal('denied', 'loop_binding_not_selected')
              : found
          }
          const reads = run.reads
          const ports: LoopReadPorts = {
            prepare: (spec) =>
              signal.aborted ? refusal('cancelled', 'loop_cancelled') : reads.prepare(spec),
            resolveData: (ref) =>
              signal.aborted
                ? Promise.resolve(refusal('cancelled', 'loop_cancelled'))
                : reads.resolveData(ref),
            async query(request) {
              if (signal.aborted) return refusal('cancelled', 'loop_cancelled')
              const selected = checkedTarget(request.target)
              if (!selected.ok) return selected
              return selected.value.query(request, contextFor(request.target))
            },
            async compute(request) {
              if (signal.aborted) return refusal('cancelled', 'loop_cancelled')
              const selected = checkedTarget(request.target)
              if (!selected.ok) return selected
              return selected.value.compute(request, contextFor(request.target))
            },
          }
          const actions = new Map<string, ActionProviderFactory>()
          const invoke = tools.actions?.invoke
          if (!invoke) result = refusal('incompatible', 'loop_tools_action_unavailable')
          else {
            actions.set(`${installation.tools.definition.executor.bindingId}/invoke`, invoke)
            const model = providers.find((provider) => provider.binding.contract === 'agh.model')
            if (!model) result = refusal('incompatible', 'loop_model_action_unavailable')
            else actions.set(`${model.binding.bindingId}/infer`, run.model)
          }
          while (result.ok) {
            if (signal.aborted) {
              result = refusal('cancelled', 'loop_cancelled')
              break
            }
            const transition = await (frame.reason === 'start'
              ? loop.start(frame, ports)
              : loop.resume(frame, ports))
            if (!validateRuntime('LoopTransition', transition).ok) {
              result = refusal('internal', 'loop_transition_invalid')
              break
            }
            const committed = await run.state.commit(frame, transition)
            if (!committed.ok) {
              result = committed
              break
            }
            if (
              !validateRuntime('RunFrame', committed.value).ok ||
              committed.value.runId !== request.runId ||
              committed.value.bindingId !== installation.loop.binding.bindingId ||
              committed.value.revision <= frame.revision
            ) {
              result = refusal('denied', 'loop_state_frame_mismatch')
              break
            }
            frame = committed.value
            if (transition.next.kind === 'fail') {
              result = { ok: false, error: transition.next.error }
              break
            }
            if (transition.next.kind === 'complete') break
            const dispatched = await run.supervisor.dispatch(frame, transition, actions, run.state)
            if (signal.aborted) {
              result = refusal('cancelled', 'loop_cancelled')
              break
            }
            if (!dispatched.ok) {
              result = dispatched
              break
            }
            if (
              !validateRuntime('RunFrame', dispatched.value).ok ||
              dispatched.value.runId !== request.runId ||
              dispatched.value.bindingId !== installation.loop.binding.bindingId ||
              dispatched.value.revision < frame.revision
            ) {
              result = refusal('denied', 'loop_supervisor_frame_mismatch')
              break
            }
            frame = dispatched.value
          }
        }
      }
      return result.ok ? result : await reject(result)
    } catch {
      return await reject(
        refusal(
          signal.aborted ? 'cancelled' : 'internal',
          signal.aborted ? 'loop_cancelled' : 'loop_owner_unavailable',
        ),
      )
    } finally {
      instances.delete(request.runId)
      // Settle every close even if one owner reports a failure. Never abandon later owners.
      const cleaned = await Promise.allSettled(owned.reverse().map((provider) => provider.close('shutdown')))
      try {
        await run?.close()
      } catch {
        cleanupFailures.add(request.runId)
      }
      if (cleaned.some((item) => item.status === 'rejected')) cleanupFailures.add(request.runId)
    }
    async function reject(failed: Outcome<void>): Promise<Outcome<void>> {
      if (failed.ok) return failed
      const saved = await installation.reject(request, failed.error)
      return saved.ok ? failed : saved
    }
  }
  return {
    providers,
    grants: installation.grants,
    run(dependencies: ScopedDependencies, request: W.RunAdmission): Promise<Outcome<void>> {
      if (closed) return Promise.resolve(refusal('cancelled', 'loop_disposed'))
      if (!validateRuntime('RunAdmission', request).ok)
        return Promise.resolve(refusal('invalid_input', 'input_invalid'))
      const existing = active.get(request.ticketId)
      if (existing)
        return same(existing.fingerprint, canonicalJsonDigest(request))
          ? existing.pending
          : Promise.resolve(refusal('conflict', 'loop_request_conflict'))
      const stop = new AbortController()
      const pending = execute(
        dependencies,
        structuredClone(request),
        AbortSignal.any([lifetime.signal, stop.signal]),
      ).then(
        (result) =>
          cleanupFailures.has(request.runId) ? refusal('unknown_effect', 'loop_cleanup_unavailable') : result,
        () => refusal('unknown_effect', 'loop_run_resolution_unavailable'),
      )
      active.set(request.ticketId, { fingerprint: canonicalJsonDigest(request), stop, pending })
      void pending.then(() => active.delete(request.ticketId))
      return pending
    },
    async cancel(ticketId: string) {
      const running = active.get(ticketId)
      running?.stop.abort()
      await running?.pending
    },
    stop() {
      closed = true
      lifetime.abort()
    },
    async close() {
      closed = true
      lifetime.abort()
      await Promise.allSettled([...active.values()].map((run) => run.pending))
      if (cleanupFailures.size) throw new Error('Runtime loop cleanup left unresolved owners')
    },
  }
}
