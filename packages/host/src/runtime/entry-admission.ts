import { randomUUID } from 'node:crypto'
import type {
  CallContext,
  Outcome,
  ScopedDependencies,
  StateStoreControl,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type AdmissionProbe,
  type BindingRef,
  type Digest,
  type Id,
  type RunAdmission,
  type RuntimeError,
  type StateCancelAdmissionRequest,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { createLocalDeploymentIdentity } from './identity/local-deployment-identity.js'
import type { HostSelectedProvider } from './scoped-dependencies.js'

const contracts = ['agh.identity', 'agh.state', 'agh.assembly'] as const
type Contract = (typeof contracts)[number]
type LocalConnection = Pick<
  Awaited<ReturnType<ReturnType<typeof createLocalDeploymentIdentity>['connect']>>,
  'issue' | 'close'
>

/** Deployment-only adapter slot. No installation capability is accepted from a wire request. */
export type HostRuntimeAdmissionInstallation = Readonly<{
  ready(): Promise<void>
  connectLocalOwner(signal: AbortSignal): Promise<LocalConnection>
  admission: Readonly<{
    confirm: StateStoreControl['probeAdmission']
    cancel: StateStoreControl['cancelAdmission']
    probe: StateStoreControl['probeAdmission']
  }>
  state: Pick<StateStoreControl, 'createRun' | 'probeAdmission'>
  close(): Promise<void>
  /** Original selected identities; the bootstrap package identity cannot stand in for these. */
  selected: Readonly<Record<Contract, Readonly<{ binding: BindingRef; packageDigest: Digest }>>>
}>

export type HostRuntimeRunRequest =
  | { operation: 'create'; request: RunAdmission }
  | { operation: 'status' | 'probe'; request: Id }
  | { operation: 'cancel'; request: StateCancelAdmissionRequest }

export function runtimeAdmissionRefusal(code: RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Runtime admission entry refused the request',
      diagnosticId: 'host-runtime-admission',
      retryAdvice: { kind: 'never' },
    },
  }
}

/** Bind private control methods to identities selected by the one Host service root. */
export function selectHostRuntimeAdmission(
  installation: HostRuntimeAdmissionInstallation | undefined,
  clock: () => number,
) {
  const selected = installation ? structuredClone(installation.selected) : undefined
  const lifetime = new AbortController()
  const active = new Set<Promise<Outcome<AdmissionProbe>>>()
  let closed = false
  let closing: Promise<void> | undefined
  const providers: HostSelectedProvider[] = contracts.flatMap((contract, index) => {
    const entry = selected?.[contract]
    if (!entry) {
      if (installation) throw new Error('Runtime admission selection is incomplete')
      return []
    }
    if (
      !validateRuntime('BindingRef', entry.binding).ok ||
      entry.binding.contract !== contract ||
      entry.binding.logicalName !== 'default' ||
      !validateRuntime('Digest', entry.packageDigest).ok
    )
      throw new Error('Runtime admission selection is invalid')
    return [
      {
        binding: Object.freeze(entry.binding),
        major: 1,
        scope: 'runtime',
        features: [],
        packageDigest: entry.packageDigest,
        ownerId: entry.binding.providerId,
        permissions: [],
        // These bindings expose only Host-private controls, never a generic control/maintenance RPC.
        requires: contracts.slice(0, index).map((dependency) => ({
          contract: dependency,
          major: 1,
          logicalName: 'default',
          scope: 'runtime' as const,
          features: [],
          optional: false,
          capture: 'instance' as const,
        })),
        ...(index === 0
          ? {
              create() {},
              async ready() {
                await installation?.ready()
              },
              close,
            }
          : {}),
      },
    ]
  })

  function root(dependencies: ScopedDependencies): Outcome<true> {
    for (const contract of contracts) {
      const found = dependencies.get({
        contract,
        major: 1,
        logicalName: 'default',
        scope: 'runtime',
        features: [],
        optional: false,
      })
      if (!found.ok) return found
      if (!selected || jcs(found.value.binding) !== jcs(selected[contract].binding))
        return runtimeAdmissionRefusal('denied', 'binding_mismatch')
    }
    return { ok: true, value: true }
  }
  function checked(reply: Outcome<AdmissionProbe>): Outcome<AdmissionProbe> {
    if (!reply.ok) return reply
    return validateRuntime('AdmissionProbe', reply.value).ok
      ? reply
      : runtimeAdmissionRefusal('internal', 'output_invalid')
  }
  async function invoke(
    dependencies: ScopedDependencies,
    input: HostRuntimeRunRequest,
  ): Promise<Outcome<AdmissionProbe>> {
    const registered = root(dependencies)
    if (!registered.ok) return registered
    if (closed) return runtimeAdmissionRefusal('cancelled', 'admission_disposed')
    if (!installation) return runtimeAdmissionRefusal('incompatible', 'service_not_registered')
    const schema =
      input.operation === 'create'
        ? 'RunAdmission'
        : input.operation === 'cancel'
          ? 'StateCancelAdmissionRequest'
          : 'Id'
    if (!validateRuntime(schema, input.request).ok)
      return runtimeAdmissionRefusal('invalid_input', 'input_invalid')
    // Capture the official payload before the authentication await. No Context comes from the caller.
    const request = structuredClone(input)
    let connection: LocalConnection | undefined
    try {
      connection = await installation.connectLocalOwner(lifetime.signal)
      if (closed) return runtimeAdmissionRefusal('cancelled', 'admission_disposed')
      const current = root(dependencies)
      if (!current.ok) return current
      const context: CallContext = connection.issue(new Date(clock() + 30_000).toISOString(), randomUUID())
      if (context.bindingId !== selected?.['agh.assembly'].binding.bindingId)
        return runtimeAdmissionRefusal('denied', 'binding_mismatch')
      // Keep the original Context and receivers: C14/source owners recognize their exact objects.
      if (request.operation === 'create') {
        const created = checked(await installation.state.createRun(request.request, context))
        if (!created.ok) return created
        if (closed || context.signal.aborted)
          return runtimeAdmissionRefusal('cancelled', 'admission_disposed')
        const confirmed = checked(await installation.admission.confirm(request.request.ticketId, context))
        return confirmed.ok && jcs(confirmed.value) !== jcs(created.value)
          ? runtimeAdmissionRefusal('denied', 'admission_proof_mismatch')
          : confirmed
      }
      if (request.operation === 'cancel')
        return checked(
          await installation.admission.cancel(request.request.ticketId, request.request.fingerprint, context),
        )
      return checked(
        await (request.operation === 'status'
          ? installation.state.probeAdmission(request.request, context)
          : installation.admission.probe(request.request, context)),
      )
    } catch {
      return runtimeAdmissionRefusal(
        closed ? 'cancelled' : 'denied',
        closed ? 'admission_disposed' : 'admission_owner_unavailable',
      )
    } finally {
      connection?.close()
    }
  }
  function close(): Promise<void> {
    closing ??= (async () => {
      closed = true
      lifetime.abort()
      await Promise.allSettled([...active])
      await installation?.close()
    })()
    return closing
  }
  return {
    providers,
    stop: () => {
      closed = true
      lifetime.abort()
    },
    close,
    run(dependencies: ScopedDependencies, request: HostRuntimeRunRequest): Promise<Outcome<AdmissionProbe>> {
      const pending = invoke(dependencies, request).catch(() =>
        runtimeAdmissionRefusal('internal', 'admission_owner_unavailable'),
      )
      active.add(pending)
      void pending.then(
        () => active.delete(pending),
        () => active.delete(pending),
      )
      return pending
    },
  }
}
