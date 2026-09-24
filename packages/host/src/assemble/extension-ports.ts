import type { ProjectionRegistry, SessionImpl } from '@agnes/core'
import type { SessionRef } from '@agnes/extension-api'
import type { ExtensionActivationBarrier } from '../ext-host/activation-barrier.js'
import { ExtensionInvocation, type SessionResolver } from '../ext-host/invocation.js'
import type { KernelPorts } from '../ext-host/ports.js'
import { ServiceRegistry } from '../ext-host/services.js'
import type { PublicationDispatch } from '../publication-dispatch.js'

type Context = { session: Parameters<SessionResolver>[0]; signal: AbortSignal }
/** Assemble callback identities from core, never from a selector supplied by an extension. */
export function bindExtensionInvocations(
  ports: Omit<KernelPorts, 'extEvents' | 'projections' | 'services'> & {
    projections: ProjectionRegistry
    services?: ServiceRegistry
  },
  resolve: SessionResolver,
  canonicalSession: (session: SessionImpl) => SessionRef = (session) => ({
    key: session.key,
    lane: session.lane,
    workspaceRoot: session.d.cwd,
  }),
  resolveHook: SessionResolver = resolve,
  readProjections: ProjectionRegistry = ports.projections,
  activationBarrier?: ExtensionActivationBarrier,
  publication?: PublicationDispatch,
): KernelPorts {
  const invocation = new ExtensionInvocation(activationBarrier)
  const services = ports.services ?? new ServiceRegistry()
  const wrap =
    <P, C extends Context, R>(callback: (payload: P, context: C) => R, owner: string) =>
    (payload: P, context: C) => {
      if (!publication)
        return invocation.runFor(
          context.session,
          context.signal,
          resolve,
          () => callback(payload, context),
          owner,
        )
      return publication.ordinary(() => {
        const session = resolve(context.session)
        return () =>
          invocation.runFor(
            context.session,
            context.signal,
            () => session,
            () => callback(payload, context),
            owner,
          )
      })
    }
  const canonicalWrap =
    <P, C extends Context, R>(callback: (payload: P, context: C) => R, owner: string) =>
    (payload: P, context: C) => {
      const invoke = (sessionResolver: SessionResolver) =>
        invocation.runFor(
          context.session,
          context.signal,
          sessionResolver,
          (session) => callback(payload, { ...context, session: canonicalSession(session) }),
          owner,
        )
      if (!publication) return invoke(resolveHook)
      return publication.ordinary(() => {
        const session = resolveHook(context.session)
        return () => invoke(() => session)
      })
    }
  return {
    services,
    tools: {
      add: (def, meta) =>
        ports.tools.add({ ...def, execute: wrap(def.execute.bind(def), meta.source) }, meta),
    },
    hooks: { on: (event, handler, meta) => ports.hooks.on(event, canonicalWrap(handler, meta.source), meta) },
    slots: {
      register: (slot, fill, meta) =>
        ports.slots.register(
          slot,
          (context, signal) => {
            const invoke = (sessionResolver: SessionResolver) =>
              invocation.runFor(
                context.session,
                signal,
                sessionResolver,
                () => fill(context, signal),
                meta.source,
              )
            if (!publication) return invoke(resolve)
            return publication.ordinary(() => {
              const session = resolve(context.session)
              return () => invoke(() => session)
            })
          },
          meta,
        ),
    },
    projections: {
      register: ports.projections.register.bind(ports.projections),
      read: (key, meta, beforeFold) =>
        publication
          ? publication.ordinary(
              () => () => invocation.readProjection(readProjections, key, meta, beforeFold),
            )
          : invocation.readProjection(readProjections, key, meta, beforeFold),
    },
    resources: ports.resources,
    registrations: (owner) => [...ports.registrations(owner), ...services.registrations(owner)].sort(),
    extEvents: { append: invocation.append },
  }
}
