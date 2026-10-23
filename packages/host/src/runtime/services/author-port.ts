import type { Context } from '@agnes/cordis'
import {
  type BindableKind,
  type BindableKindToken,
  type DecisionPort,
  EXTENSION_ID_PATTERN,
  type ProjectionReader,
  ProviderError,
  type ServiceInstance,
  type ServicePorts,
  type ServiceProvider,
  type SessionRef,
  unavailableProjections,
} from '@agnes/extension-api'
import { GIT_WORKTREE_OWNER, GIT_WORKTREE_PACKAGE, gitWorktreeKind } from '@agnes/git-worktree-contract'
import type { ProvidersService } from '@agnes/host-common/assemble/provider-registry'
import {
  ServiceBindings,
  type ServiceCall,
  type ServiceDescriptor,
  type ServicePortFactories,
} from '@agnes/host-common/assemble/service-binding'
import type { ExtensionInvocation } from '@agnes/host-extensions/ext-host/invocation'
import type { KernelPorts } from '@agnes/host-extensions/ext-host/ports'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { Actor } from '@agnes/protocol'
import { createSessionAgentInput, createSessionLedger, type SessionLedgerSession } from './session-ports.js'

export interface ServiceAdmission {
  readonly token: object
  readonly owner?: string
  readonly active: boolean
  readonly signal: AbortSignal
  readonly session: SessionLedgerSession &
    Pick<SessionRef, 'key' | 'workspaceRoot'> & {
      decisions?: {
        port(source: {
          owner: string
          sourcePackage: string
          packageVersion: string
          operationId: string
          alive(): void
        }): DecisionPort
      }
    }
}

export interface ExtensionServiceHost {
  readonly sink: { current?: ExtensionInvocation }
  readonly ports: NonNullable<KernelPorts['serviceProviders']>
  install<S extends ServiceInstance, P extends ServicePorts>(
    ctx: Context,
    kind: BindableKind<S, P>,
    descriptor: ServiceDescriptor,
    origins?: RowOriginLookup,
  ): void
  /** Registers on the mounting root. The author port cannot register the git worktree kind. */
  registerOn<S extends ServiceInstance, P extends ServicePorts>(
    ctx: Context,
    kind: BindableKind<S, P>,
    provider: ServiceProvider<S, P>,
    identity: { readonly owner: string; readonly packageId: string },
  ): () => Promise<void>
  bindHost<S extends ServiceInstance, P extends ServicePorts>(
    kind: BindableKind<S, P>,
    call: ServiceCall,
    factories?: ServicePortFactories,
  ): Promise<S>
  attachBinder(providers: ProvidersService): void
  /** Runs after a provider claims its owner. The returned function runs before the claim is released. */
  onRegistered(kind: BindableKindToken, listener: (owner: string, packageId: string) => () => void): void
  packageFor(kind: BindableKindToken, owner: string): string | undefined
}

/** Service tokens are invariant, so a generic kind and a concrete token do not overlap. */
function sameServiceKind(left: object, right: object): boolean {
  return left === right
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
  serviceIdentity?: (owner: string) =>
    | {
        packageId: string
        packageVersion: string
        recheck(required: readonly import('@agnes/extension-api').ServiceCapability[]): void
      }
    | undefined
}): ExtensionServiceHost {
  const sink: { current?: ExtensionInvocation } = {}
  const bindings = new ServiceBindings(() => input.providers())
  const listeners = new Map<string, Array<(owner: string, packageId: string) => () => void>>()
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
    kind: BindableKind<S, P>,
    identity: {
      readonly owner: string
      readonly packageId: string
      readonly packageVersion?: string
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
      session: { key: session.key, lane: session.lane, workspaceRoot: session.workspaceRoot },
      ...(generationId === undefined ? {} : { generationId }),
      ...(kind.instanceScope === 'workspace' ? { workspaceKey: session.workspaceRoot } : {}),
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
      decisions: () => {
        if (!session.decisions || !identity.packageVersion) throw closed(kind.kind, 'decision.bind')
        return session.decisions.port({
          owner: identity.owner,
          sourcePackage: identity.packageId,
          packageVersion: identity.packageVersion,
          operationId: `service:${identity.owner}`,
          alive() {
            identity.recheck()
            if (!call.live()?.active) throw closed(kind.kind, 'decision.call')
          },
        })
      },
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
          identity.owner,
        ),
      }),
      projections: identity.projections,
      lastSeq: () => session.lastSeq,
      now: () => Date.now(),
    })
  }
  const claim = <S extends ServiceInstance, P extends ServicePorts>(
    providers: ProvidersService,
    kind: BindableKind<S, P>,
    provider: ServiceProvider<S, P>,
    identity: { readonly owner: string; readonly packageId: string },
    root?: Context,
  ): (() => Promise<void>) => {
    if (!EXTENSION_ID_PATTERN.test(identity.owner) || identity.packageId.trim() === '')
      throw closed(kind.kind, 'register')
    const dispose =
      kind.authority === 'host' && root
        ? bindings.registerHost(root, kind, provider, identity.packageId)
        : providers.registerHost(kind, identity.packageId, provider)
    const offs: Array<() => void> = []
    let claimed = false
    try {
      bindings.noteOwner(kind.kind, provider.id, provider.version, identity.owner, identity.packageId)
      claimed = true
      for (const listener of listeners.get(kind.kind) ?? [])
        offs.push(listener(identity.owner, identity.packageId))
    } catch (error) {
      for (const off of offs.reverse()) {
        try {
          off()
        } catch {
          // A listener that already returned must not hide the registration failure.
        }
      }
      if (claimed) bindings.forget(kind.kind, provider.id, provider.version)
      void dispose().catch(() => undefined)
      throw error
    }
    let live = true
    return () => {
      if (!live) return Promise.resolve()
      live = false
      for (const off of offs) {
        try {
          off()
        } catch {
          // Continue releasing the other provider listeners.
        }
      }
      bindings.forget(kind.kind, provider.id, provider.version)
      return dispose()
    }
  }
  const ports: NonNullable<KernelPorts['serviceProviders']> = {
    register(kind, provider, identity) {
      if (kind.kind === gitWorktreeKind.kind) throw closed(kind.kind, 'register')
      return claim(input.providers(), kind, provider, identity)
    },
    grants(kind) {
      return bindings.grants(kind.kind)
    },
    bindOwn(kind, identity) {
      return bindAdmitted(kind, identity)
    },
  }
  return {
    sink,
    ports,
    install(ctx, kind, descriptor, origins) {
      bindings.install(
        ctx,
        kind,
        descriptor,
        origins,
        (ownerContext, rowId, packageId, provider, register) => {
          // The row index supplies identity. Provider ids never confer the semantic UI owner.
          const owner = pluginRowSource(rowId)
          const dispose = register()
          const offs: Array<() => void> = []
          let claimed = false
          try {
            bindings.noteOwner(kind.kind, provider.id, provider.version, owner, packageId)
            claimed = true
            for (const listener of listeners.get(kind.kind) ?? []) offs.push(listener(owner, packageId))
          } catch (error) {
            for (const off of offs.reverse()) {
              try {
                off()
              } catch {
                // Preserve the registration failure while unwinding listeners.
              }
            }
            if (claimed) bindings.forget(kind.kind, provider.id, provider.version)
            void dispose().catch(() => undefined)
            throw error
          }
          let live = true
          const release = () => {
            if (!live) return
            live = false
            for (const off of offs.reverse()) {
              try {
                off()
              } catch {
                // Continue releasing the other provider listeners.
              }
            }
            bindings.forget(kind.kind, provider.id, provider.version)
          }
          // Claim cleanup must run even if the provider's asynchronous dispose fails.
          try {
            ownerContext.effect(() => release)
          } catch (error) {
            release()
            void dispose().catch(() => undefined)
            throw error
          }
          return () => {
            release()
            return dispose()
          }
        },
      )
    },
    registerOn(ctx, kind, provider, identity) {
      if (
        kind.kind === gitWorktreeKind.kind &&
        (!sameServiceKind(kind, gitWorktreeKind) ||
          identity.owner !== GIT_WORKTREE_OWNER ||
          identity.packageId !== GIT_WORKTREE_PACKAGE)
      )
        throw closed(kind.kind, 'register')
      return claim(ctx.providers, kind, provider, identity, ctx)
    },
    bindHost(kind, call, factories) {
      return bindings.bind(kind, call, factories ?? {})
    },
    onRegistered(kind, listener) {
      const list = listeners.get(kind.kind) ?? []
      list.push(listener)
      listeners.set(kind.kind, list)
    },
    packageFor(kind, owner) {
      return bindings.claimPackage(kind.kind, owner)
    },
    attachBinder(providers) {
      providers.installServiceBinder((kind) => {
        const admitted = readAdmission()
        if (!admitted?.active || !admitted.owner) throw closed(kind.kind, 'bind')
        const required = bindings.grants(kind.kind)?.services
        const row =
          kind.authority === 'host' && !kind.operations.register && required?.length
            ? input.serviceIdentity?.(admitted.owner)
            : undefined
        const packageId = row?.packageId ?? bindings.claimPackage(kind.kind, admitted.owner)
        row?.recheck(required ?? [])
        if (!packageId) throw closed(kind.kind, 'bind')
        const token = admitted.token
        const owner = admitted.owner
        return bindAdmitted(kind, {
          owner,
          packageId,
          trust: 'trusted',
          ...(row ? { packageVersion: row.packageVersion } : {}),
          projections: unavailableProjections,
          recheck() {
            row?.recheck(required ?? [])
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
