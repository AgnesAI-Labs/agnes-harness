import { randomBytes } from 'node:crypto'
import type { StreamHandler } from '@agnes/extension-api'
import {
  type Actor,
  type JsonValue,
  PLUGIN_STREAM_PATH,
  type PluginStreamGrant,
  type PluginStreamOpen,
  type StreamDeclaration,
  validatePluginStreamHello,
  validatePluginStreamOpen,
  validateStreamDeclaration,
} from '@agnes/protocol'
import { type Channel, createStreamChannel, type StreamSocket } from './channel.js'

/** Supplied by the authenticated connection owner, never deserialized from browser input. */
export type StreamPrincipal = Readonly<{
  subject: string
  connectionId: string
  profileId: string
  actor: Actor
  source: string
  signal: AbortSignal
}>
export type StreamAdmission = Readonly<{
  signal: AbortSignal
  /** Synchronous current-activation / roster / scope / grant check, including grant expiry. */
  assertCurrent(): void
  control?: { grantId: string; expiresAt: number }
}>
export type StreamRegistration = Readonly<{
  owner: string
  profileId: string
  activationId: string
  declaration: StreamDeclaration
  handler: StreamHandler
  signal: AbortSignal
  /** Compiled by the manifest owner with its supported JSON Schema implementation. */
  validateInput(value: JsonValue): boolean
}>
export class PluginStreamError extends Error {
  constructor(readonly code: 'REFUSED' | 'OVERLOADED' | 'INVALID') {
    super(code)
  }
}
type Ticket = {
  principal: StreamPrincipal
  request: PluginStreamOpen
  registration: StreamRegistration
  admission: StreamAdmission
  id: number
  expiresAt: number
  expiresTick: number
  controlTick?: number
}
export function createPluginStreamBroker(options: {
  /** Must validate the immutable client allowlist, current owner activation, scope and effect grant. */
  authorize(
    principal: StreamPrincipal,
    request: PluginStreamOpen,
    registration: StreamRegistration,
  ): Promise<StreamAdmission>
  resolveRegistration?(principal: StreamPrincipal, request: PluginStreamOpen): Promise<void>
  now?: () => number
  monotonicNow?: () => number
}) {
  const now = options.now ?? Date.now
  const tick = options.monotonicNow ?? (() => performance.now())
  const registrations = new Map<string, StreamRegistration>()
  const tickets = new Map<string, Ticket>()
  const registrationReleases = new Set<() => void>()
  const connections = new Set<{
    principal: StreamPrincipal
    socket: StreamSocket
    channel?: Channel
    stop(): void
  }>()
  const rates = new Map<string, { start: number; count: number }>()
  const media = new Map<string, { start: number; bytes: number }>()
  let nextId = 1
  let closed = false
  const registrationKey = (profile: string, owner: string, name: string) =>
    JSON.stringify([profile, owner, name])
  const actorKey = (p: StreamPrincipal) => JSON.stringify([p.profileId, p.subject])
  const same = (a: StreamPrincipal, b: StreamPrincipal) =>
    actorKey(a) === actorKey(b) && a.connectionId === b.connectionId && a.source === b.source
  function sweep(): void {
    for (const [key, t] of tickets)
      if (
        t.expiresAt <= now() ||
        t.expiresTick <= tick() ||
        t.principal.signal.aborted ||
        t.registration.signal.aborted ||
        t.admission.signal.aborted
      )
        tickets.delete(key)
    for (const [key, rate] of rates) if (now() - rate.start >= 60000) rates.delete(key)
    for (const [key, rate] of media) if (now() - rate.start >= 1000) media.delete(key)
  }
  function assertTicket(t: Ticket, principal: StreamPrincipal): void {
    const r = t.registration
    if (
      closed ||
      !same(t.principal, principal) ||
      t.request.scope.profileId !== principal.profileId ||
      principal.signal.aborted ||
      t.principal.signal.aborted ||
      r.signal.aborted ||
      t.admission.signal.aborted ||
      registrations.get(registrationKey(r.profileId, r.owner, r.declaration.name)) !== r
    )
      throw new PluginStreamError('REFUSED')
    t.admission.assertCurrent()
    if (
      t.admission.control &&
      (t.admission.control.expiresAt <= now() || t.controlTick === undefined || t.controlTick <= tick())
    )
      throw new PluginStreamError('REFUSED')
  }
  return {
    register(input: StreamRegistration): () => void {
      if (
        closed ||
        input.signal.aborted ||
        !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(input.owner) ||
        !input.profileId ||
        !input.activationId
      )
        throw new PluginStreamError('REFUSED')
      const checked = validateStreamDeclaration(input.declaration)
      if (!checked.ok) throw new PluginStreamError('INVALID')
      const declaration = freezeJson(structuredClone(checked.value))
      Object.freeze(declaration.directions)
      Object.freeze(declaration)
      const registration = Object.freeze({ ...input, declaration })
      const key = registrationKey(input.profileId, input.owner, declaration.name)
      if (registrations.has(key)) throw new PluginStreamError('REFUSED')
      const lifetime = new AbortController()
      const combined = AbortSignal.any([input.signal, lifetime.signal])
      const bound = Object.freeze({ ...registration, signal: combined })
      registrations.set(key, bound)
      const dispose = () => {
        if (registrations.get(key) !== bound) return
        registrations.delete(key)
        input.signal.removeEventListener('abort', dispose)
        registrationReleases.delete(dispose)
        for (const [ticket, value] of tickets) if (value.registration === bound) tickets.delete(ticket)
        lifetime.abort()
      }
      registrationReleases.add(dispose)
      input.signal.addEventListener('abort', dispose, { once: true })
      return dispose
    },
    async open(
      principal: StreamPrincipal,
      value: unknown,
      operationSignal?: AbortSignal,
    ): Promise<PluginStreamGrant> {
      sweep()
      if (closed || principal.signal.aborted) throw new PluginStreamError('REFUSED')
      const checked = validatePluginStreamOpen(value)
      if (!checked.ok) throw new PluginStreamError('INVALID')
      const request = freezeJson(structuredClone(checked.value))
      const key = actorKey(principal)
      const rate = rates.get(key) ?? { start: now(), count: 0 }
      if (rate.count >= 10 || (rates.size >= 1024 && !rates.has(key)) || tickets.size >= 1024)
        throw new PluginStreamError('OVERLOADED')
      rate.count++
      rates.set(key, rate)
      await options.resolveRegistration?.(principal, request)
      const registration = registrations.get(
        registrationKey(principal.profileId, request.owner, request.name),
      )
      if (
        !registration ||
        request.scope.profileId !== principal.profileId ||
        request.scope.kind !== registration.declaration.scope ||
        !registration.validateInput(request.input)
      )
        throw new PluginStreamError('REFUSED')
      const admitted = await options.authorize(principal, request, registration)
      const admission = Object.freeze({
        ...admitted,
        ...(admitted.control ? { control: Object.freeze({ ...admitted.control }) } : {}),
      })
      operationSignal?.throwIfAborted()
      if (tickets.size >= 1024) throw new PluginStreamError('OVERLOADED')
      if (
        registration.declaration.directions.includes('inbound') &&
        !registration.declaration.producer &&
        (!admission.control?.grantId ||
          !Number.isSafeInteger(admission.control.expiresAt) ||
          admission.control.expiresAt <= now())
      )
        throw new PluginStreamError('REFUSED')
      if (nextId > 0xffffffff) nextId = 1
      const t: Ticket = {
        principal,
        request,
        registration,
        admission,
        id: nextId++,
        expiresAt: now() + 10000,
        expiresTick: tick() + 10000,
        ...(admission.control
          ? { controlTick: tick() + Math.min(2147483647, admission.control.expiresAt - now()) }
          : {}),
      }
      assertTicket(t, principal)
      const ticket = randomBytes(32).toString('base64url')
      tickets.set(ticket, t)
      return {
        ticket,
        expiresAt: t.expiresAt,
        path: PLUGIN_STREAM_PATH,
        streamId: t.id,
        lane: registration.declaration.lane,
        ...(registration.declaration.producer
          ? {
              producer: true as const,
              maxFrameBytes: registration.declaration.maxFrameBytes,
              maxBufferedBytes: registration.declaration.maxBufferedBytes,
            }
          : {}),
      }
    },
    connect(principal: StreamPrincipal, socket: StreamSocket) {
      sweep()
      const own = [...connections].filter((c) => actorKey(c.principal) === actorKey(principal)).length
      const profile = [...connections].filter((c) => c.principal.profileId === principal.profileId).length
      if (closed || principal.signal.aborted || own >= 8 || profile >= 32 || connections.size >= 1024) {
        socket.close(1013, 'overloaded')
        throw new PluginStreamError('OVERLOADED')
      }
      let ended = false
      let expiry: ReturnType<typeof setTimeout> | undefined
      const helloTimer = setTimeout(() => stop('expired', 1008), 5000)
      helloTimer.unref?.()
      const connection: {
        principal: StreamPrincipal
        socket: StreamSocket
        channel?: Channel
        stop(): void
      } = {
        principal,
        socket,
        stop: () => stop('closed'),
      }
      function release(): void {
        if (ended) return
        ended = true
        clearTimeout(helloTimer)
        if (expiry) clearTimeout(expiry)
        principal.signal.removeEventListener('abort', revoked)
        connections.delete(connection)
      }
      function stop(reason: string, code = 1000): void {
        if (ended) return
        if (connection.channel) connection.channel.disconnect(reason, code)
        else {
          release()
          socket.close(code, reason)
        }
      }
      function revoked(): void {
        stop('revoked', 1008)
      }
      principal.signal.addEventListener('abort', revoked, { once: true })
      connections.add(connection)
      return {
        receive(bytes: Uint8Array, binary: boolean): void {
          if (ended) return
          if (connection.channel) {
            connection.channel.receive(bytes, binary)
            return
          }
          if (binary || bytes.byteLength > 4096) {
            stop('protocol', binary ? 1008 : 1009)
            return
          }
          let t: Ticket | undefined
          try {
            const hello = validatePluginStreamHello(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
            )
            if (!hello.ok) throw new Error('invalid hello')
            t = tickets.get(hello.value.ticket)
            // Consume before any callback or asynchronous operation; a failed attempt cannot replay it.
            tickets.delete(hello.value.ticket)
            if (!t || t.expiresAt <= now() || t.expiresTick <= tick()) throw new Error('expired ticket')
            assertTicket(t, principal)
          } catch {
            stop('revoked', 1008)
            return
          }
          clearTimeout(helloTimer)
          const ticket = t
          const signal = AbortSignal.any([
            principal.signal,
            ticket.principal.signal,
            ticket.registration.signal,
            ticket.admission.signal,
          ])
          const channel = createStreamChannel({
            id: ticket.id,
            declaration: ticket.registration.declaration,
            socket,
            signal,
            assertCurrent: () => assertTicket(ticket, principal),
            now,
            profileBuffered: () =>
              [...connections]
                .filter((c) => c.principal.profileId === principal.profileId && c.channel)
                .reduce((n, c) => n + c.socket.bufferedAmount, 0),
            mediaBudget(bytes) {
              const rate = media.get(principal.profileId) ?? { start: now(), bytes: 0 }
              if (now() - rate.start >= 1000) {
                rate.start = now()
                rate.bytes = 0
              }
              if (rate.bytes + bytes > 4 * 1024 * 1024) return false
              rate.bytes += bytes
              media.set(principal.profileId, rate)
              return true
            },
            released: release,
          })
          connection.channel = channel
          if (ticket.admission.control) {
            expiry = setTimeout(
              () => stop('expired', 1008),
              Math.max(0, Math.min(2147483647, (ticket.controlTick ?? tick()) - tick())),
            )
            expiry.unref?.()
          }
          try {
            socket.send(JSON.stringify({ ready: true, streamId: ticket.id }), (error) => {
              if (error) stop('unavailable', 1011)
            })
            channel.signal.throwIfAborted()
            const result = ticket.registration.handler(ticket.request.input, {
              scope: ticket.request.scope,
              actor: freezeJson(structuredClone(principal.actor)),
              source: principal.source,
              signal: channel.signal,
              stream: channel.stream,
              ...(ticket.admission.control ? { control: ticket.admission.control } : {}),
            })
            void Promise.resolve(result).catch(() => stop('unavailable', 1011))
          } catch {
            stop('unavailable', 1011)
          }
        },
        disconnect: () => stop('closed'),
      }
    },
    close(): void {
      if (closed) return
      closed = true
      for (const connection of connections) connection.stop()
      tickets.clear()
      for (const dispose of [...registrationReleases]) dispose()
      registrations.clear()
      rates.clear()
      media.clear()
    },
  }
}
export type PluginStreamBroker = ReturnType<typeof createPluginStreamBroker>

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}
