import type { SessionImpl } from '@agnes/core'
import type { SessionRef } from '@agnes/extension-api'
import { HostError } from '../errors.js'
import type { SessionResolver } from './invocation.js'

type Port = SessionImpl['hooks']
type Binding<T extends Port> = { session: SessionImpl; ref: SessionRef; port?: T }

const REF_KEYS = new Set([
  'key',
  'lane',
  'workspaceRoot',
  'turn',
  'step',
  'telemetryConsent',
  'telemetryConsentPendingAudit',
])
const CONSENTS = new Set(['DISABLED', 'LOCAL', 'ANON', 'FULL'])

function validCanonicalRef(ref: SessionRef, session: SessionImpl): boolean {
  try {
    if (Object.getPrototypeOf(ref) !== Object.prototype || !Object.isFrozen(ref)) return false
    if (Object.getOwnPropertySymbols(ref).length > 0) return false
    const descriptors = Object.getOwnPropertyDescriptors(ref)
    if (Object.keys(descriptors).some((key) => !REF_KEYS.has(key))) return false
    if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return false
    const value = (key: string): unknown => descriptors[key]?.value
    if (
      value('key') !== session.key ||
      value('lane') !== session.lane ||
      value('workspaceRoot') !== session.d.cwd
    )
      return false
    for (const key of ['turn', 'step']) {
      const item = value(key)
      if (item !== undefined && (!Number.isSafeInteger(item) || (item as number) < 0)) return false
    }
    const consent = value('telemetryConsent')
    if (consent !== undefined && !CONSENTS.has(consent as string)) return false
    const pending = value('telemetryConsentPendingAudit')
    return pending === undefined || typeof pending === 'boolean'
  } catch {
    return false
  }
}

/** Factory-owned sessions include startup; public Kernel sessions are published later. */
export class ExtensionSessions<T extends Port> {
  private readonly byRef = new WeakMap<SessionRef, Binding<T>>()
  private readonly opening = new WeakMap<SessionRef, SessionImpl>()
  private readonly bySession = new WeakMap<SessionImpl, SessionRef>()
  private readonly active = new Set<Binding<T>>()
  private readonly used = new WeakSet<Port>()

  resolve: SessionResolver = (ref) => this.byRef.get(ref)?.session

  owns(ref: SessionRef): boolean {
    return this.byRef.has(ref)
  }

  ref(session: SessionImpl): SessionRef | undefined {
    return this.bySession.get(session)
  }

  isOpening(ref: SessionRef): boolean {
    return this.opening.has(ref)
  }

  entries(): Array<{ session: SessionImpl; port: T; ref: SessionRef }> {
    return [...this.active].flatMap((entry) =>
      entry.port ? [{ session: entry.session, port: entry.port, ref: entry.ref }] : [],
    )
  }

  factory(create: (session: SessionImpl) => T): (session: SessionImpl) => T
  factory<A extends unknown[]>(
    reference: (session: SessionImpl) => SessionRef,
    create: (session: SessionImpl, ref: SessionRef, ...args: A) => T,
  ): (session: SessionImpl, ...args: A) => T
  factory<A extends unknown[]>(
    referenceOrCreate: ((session: SessionImpl) => SessionRef) | ((session: SessionImpl) => T),
    createWithRef?: (session: SessionImpl, ref: SessionRef, ...args: A) => T,
  ): (session: SessionImpl, ...args: A) => T {
    const reference = createWithRef
      ? (referenceOrCreate as (session: SessionImpl) => SessionRef)
      : (session: SessionImpl): SessionRef =>
          Object.freeze({ key: session.key, lane: session.lane, workspaceRoot: session.d.cwd })
    const create = createWithRef
      ? createWithRef
      : (session: SessionImpl) => (referenceOrCreate as (session: SessionImpl) => T)(session)
    return (session: SessionImpl, ...args: A): T => {
      const ref = reference(session)
      if (!ref || !validCanonicalRef(ref, session))
        throw new HostError('E_EXT_LOAD', 'invalid canonical session reference')
      const binding: Binding<T> = { session, ref }
      this.byRef.set(ref, binding)
      this.opening.set(ref, session)
      this.bySession.set(session, ref)
      let port: T
      try {
        port = create(session, ref, ...args)
        if (
          !port ||
          !['beforeStep', 'toolCall', 'turnStopping', 'context', 'beforeRequest'].every(
            (name) => typeof (port as unknown as Record<string, unknown>)[name] === 'function',
          )
        )
          throw new HostError('E_EXT_LOAD', 'invalid session hook port')
        if (this.used.has(port)) throw new HostError('E_EXT_LOAD', 'session hook port reused')
        this.used.add(port)
      } catch (error) {
        this.opening.delete(ref)
        this.byRef.delete(ref)
        this.bySession.delete(session)
        throw error
      }
      const releaseOpening = (): void => {
        this.opening.delete(ref)
      }
      const release = (): void => {
        releaseOpening()
        this.byRef.delete(ref)
        this.bySession.delete(session)
        this.active.delete(binding)
      }
      const sessionStart = async (...startArgs: unknown[]) => {
        try {
          if (port.sessionStart) await Reflect.apply(port.sessionStart, port, startArgs)
        } finally {
          releaseOpening()
        }
      }
      const shutdown = async (...shutdownArgs: unknown[]) => {
        try {
          if (port.shutdown) await Reflect.apply(port.shutdown, port, shutdownArgs)
        } finally {
          release()
        }
      }
      const bound = new Proxy(Object.create(port) as T, {
        get(_target, key) {
          if (key === 'sessionStart') return sessionStart
          if (key === 'shutdown') return shutdown
          const value = Reflect.get(port, key, port) as unknown
          return typeof value === 'function' ? value.bind(port) : value
        },
      })
      binding.port = bound
      this.active.add(binding)
      return bound
    }
  }
}
