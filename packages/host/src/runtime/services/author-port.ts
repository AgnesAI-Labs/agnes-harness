import type { Context } from '@agnes/cordis'
import {
  EXTENSION_ID_PATTERN,
  ProviderError,
  unavailableProjections,
  type ProjectionReader,
  type ServiceInstance,
  type ServiceKind,
  type ServicePorts,
} from '@agnes/extension-api'
import type { ProvidersService } from '@agnes/host-common/assemble/provider-registry'
import {
  ServiceBindings,
  type ServiceCall,
  type ServiceDescriptor,
  type ServicePortFactories,
} from '@agnes/host-common/assemble/service-binding'
import type { ExtensionInvocation } from '@agnes/host-extensions/ext-host/invocation'
import type { KernelPorts } from '@agnes/host-extensions/ext-host/ports'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { Actor } from '@agnes/protocol'
import { createSessionAgentInput, createSessionLedger, type SessionLedgerSession } from './session-ports.js'

export interface ServiceAdmission {
  readonly token: object
  readonly owner?: string
  readonly active: boolean
  readonly signal: AbortSignal
  readonly session: SessionLedgerSession & { readonly key: string }
}

export interface ExtensionServiceHost {
  readonly sink: { current?: ExtensionInvocation }
  readonly ports: NonNullable<KernelPorts['serviceProviders']>
  install(ctx: Context, kind: ServiceKind, descriptor: ServiceDescriptor, origins?: RowOriginLookup): void
  bindHost<S extends ServiceInstance, P extends ServicePorts>(
    kind: ServiceKind<S, P>,
    call: ServiceCall,
    factories?: ServicePortFactories,
  ): Promise<S>
  attachBinder(providers: ProvidersService): void
}

function closed(kind: string, operation: string): ProviderError {
  return new ProviderError('E_PROVIDER_UNAVAILABLE', 'service binding is closed', { kind, operation })
}

function extensionActor(owner: string): Actor {
  return { id: owner, org: 'local', role: 'extension', deptPath: [], attrs: {} }
}

/**
 * The granted author path is ExtensionAPI.providers. ctx.providers.bindOwn uses the same admission
 * and fails closed for projections, because that path has no per-extension projection lease.
 */
export function createExtensionServiceHost(input: {
  providers(): ProvidersService
  sessionGeneration?: (sessionKey: string) => string | undefined
  readAdmission?: () => ServiceAdmission | undefined
}): ExtensionServiceHost {
  const sink: { current?: ExtensionInvocation } = {}
  const bindings = new ServiceBindings(() => input.providers())
  const readAdmission = (): ServiceAdmission | undefined => {
    if (input.readAdmission) return input.readAdmission()
    const admitted = sink.current?.admission()
    if (!admitted) return undefined
    return {
      token: admitted.token,
      ...(admitted.owner === undefined ? {} : { owner: admitted.owner }),
      active: admitted.active,
      signal: admitted.signal,
      // SessionImpl satisfies the structural ledger port. The invocation stores the concrete session.
      session: admitted.session as unknown as ServiceAdmission['session'],
    }
  }
  const bindAdmitted = <S extends ServiceInstance, P extends ServicePorts>(
    kind: ServiceKind<S, P>,
    identity: {
      readonly owner: string
      readonly packageId: string
      readonly trust: 'builtin' | 'trusted'
      readonly recheck: () => void
      readonly projections: ProjectionReader
    },
  ): Promise<S> => {
    const admitted = readAdmission()
    if (!admitted?.active || admitted.owner !== identity.owner || admitted.session.closingOrClosed)
      throw closed(kind.kind, 'bind')
    const session = admitted.session
    const token = admitted.token
    const generationId = input.sessionGeneration?.(session.key)
    const call: ServiceCall = {
      owner: identity.owner,
      packageId: identity.packageId,
      session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
      ...(generationId === undefined ? {} : { generationId }),
      signal: admitted.signal,
      watermark: session.lastSeq,
      actor: extensionActor(identity.owner),
      live: () => {
        try {
          identity.recheck()
        } catch {
          return undefined
        }
        const current = readAdmission()
        if (!current?.active || current.token !== token || current.owner !== identity.owner) return undefined
        if (current.session !== session || current.session.closingOrClosed) return undefined
        const generation = input.sessionGeneration?.(current.session.key)
        return {
          owner: identity.owner,
          active: true,
          ...(generation === undefined ? {} : { generationId: generation }),
        }
      },
    }
    return bindings.bind(kind, call, {
      ledger: (call, _binding, descriptor) =>
        createSessionLedger(session, {
          kind: kind.kind,
          owner: identity.owner,
          eventNames: descriptor.eventNames ?? [],
          watermark: call.watermark ?? session.lastSeq,
          trust: identity.trust,
          alive() {
            identity.recheck()
            if (session.closingOrClosed) throw closed(kind.kind, 'call')
          },
        }),
      input: (_call, _binding, descriptor) => ({
        deliver: createSessionAgentInput(
          session,
          extensionActor(identity.owner),
          descriptor.delivery ?? 'next-turn',
        ),
      }),
      projections: identity.projections,
      now: () => Date.now(),
    })
  }
  const ports: NonNullable<KernelPorts['serviceProviders']> = {
    register(kind, provider, identity) {
      if (!EXTENSION_ID_PATTERN.test(identity.owner) || identity.packageId.trim() === '')
        throw closed(kind.kind, 'register')
      const dispose = input.providers().register(kind, identity.packageId, provider)
      try {
        bindings.noteOwner(kind.kind, provider.id, provider.version, identity.owner, identity.packageId)
      } catch (error) {
        void dispose()
        throw error
      }
      return async () => {
        bindings.forget(kind.kind, provider.id, provider.version)
        await dispose()
      }
    },
    bindOwn(kind, identity) {
      return bindAdmitted(kind, identity)
    },
  }
  return {
    sink,
    ports,
    install(ctx, kind, descriptor, origins) {
      bindings.install(ctx, kind, descriptor, origins)
    },
    bindHost(kind, call, factories) {
      return bindings.bind(kind, call, factories ?? {})
    },
    attachBinder(providers) {
      providers.installServiceBinder((kind) => {
        const admitted = readAdmission()
        if (!admitted?.active || !admitted.owner) throw closed(kind.kind, 'bind')
        const packageId = bindings.claimPackage(kind.kind, admitted.owner)
        if (!packageId) throw closed(kind.kind, 'bind')
        const token = admitted.token
        const owner = admitted.owner
        return bindAdmitted(kind, {
          owner,
          packageId,
          trust: 'trusted',
          projections: unavailableProjections,
          recheck() {
            const current = readAdmission()
            if (!current?.active || current.token !== token || current.owner !== owner)
              throw closed(kind.kind, 'bind')
            if (current.session.closingOrClosed) throw closed(kind.kind, 'bind')
          },
        })
      })
    },
  }
}
