import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { Host } from '@agnes/host'
import {
  createPluginStreamBroker,
  createPluginStreamGateway,
  createRosterStreamAuthorizer,
  type StreamPrincipal,
} from '@agnes/plugin-streams'
import type { ClientModuleRosterRow } from '@agnes/protocol'
import { validateActor } from '@agnes/protocol'

const endpoints = new WeakMap<Host, Map<string, Promise<{ host: string; port: number; proof: string }>>>()
/** Private loopback transport for the launcher. Neither its proof nor endpoint goes to the browser. */
export function profileStreamEndpoint(host: Host, origin: string) {
  let entries = endpoints.get(host)
  if (!entries) {
    entries = new Map()
    endpoints.set(host, entries)
  }
  const existing = entries.get(origin)
  if (existing) return existing
  if (entries.size >= 4) throw new Error('stream-endpoint-limit')
  const opening = start(host, origin)
  entries.set(origin, opening)
  void opening.catch(() => entries?.delete(origin))
  return opening
}
async function start(host: Host, origin: string) {
  const proof = randomBytes(32).toString('hex'),
    lifetime = new AbortController()
  const rows = new WeakMap<StreamPrincipal, ClientModuleRosterRow>()
  const registrations = new Map<
    string,
    { activationId: string; release(): void; assert(): void; abort: AbortController }
  >()
  const runtime = () => {
    const current = host.profileServices,
      streams = current?.streams
    if (!current || !streams) throw new Error('streams-unavailable')
    return { ...current, streams }
  }
  const broker = createPluginStreamBroker({
    async resolveRegistration(_principal, request) {
      const entry = runtime().streams.describe(request.owner, request.name)
      const key = `${request.owner}/${request.name}`,
        old = registrations.get(key)
      if (old?.activationId === entry.activationId) {
        old.assert()
        return
      }
      old?.abort.abort()
      old?.release()
      const abort = new AbortController()
      const release = broker.register({
        ...entry,
        signal: AbortSignal.any([entry.signal, abort.signal, lifetime.signal]),
      })
      registrations.set(key, {
        activationId: entry.activationId,
        release,
        assert: entry.assertCurrent,
        abort,
      })
    },
    authorize: createRosterStreamAuthorizer({
      async resolve(principal, request, registration) {
        const row = rows.get(principal)
        const entry = runtime().streams.describe(request.owner, request.name)
        const controlService = registration.declaration.controlService
        const admitted = controlService
          ? await runtime().authorizeControl(
              {
                extension: request.owner,
                service: controlService,
                operationId: request.controlOperationId ?? '',
              },
              {
                kind: 'surface-service',
                source: 'client-web',
                subjectCredential: { kind: 'local' },
                grants: [{ extension: request.owner, name: controlService, range: '*' }],
              },
            )
          : undefined
        if (admitted && JSON.stringify(admitted.actor) !== JSON.stringify(principal.actor))
          throw new Error('actor-mismatch')
        return {
          current: () => row,
          backendActivationId: () => runtime().streams.describe(request.owner, request.name).activationId,
          signal: entry.signal,
          assertScope() {
            entry.assertCurrent()
            if (request.scope.kind !== 'profile') throw new Error('scope-refused')
          },
          ...(admitted ? { control: { grantId: admitted.grantId, expiresAt: admitted.expiresAt } } : {}),
        }
      },
    }),
  })
  const authenticate = async (request: IncomingMessage): Promise<StreamPrincipal | null> => {
    const value = request.headers['x-agnes-stream-proof']
    if (
      typeof value !== 'string' ||
      value.length !== proof.length ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(proof))
    )
      return null
    const actor = await host.resolveActor({ kind: 'local' }, 'service')
    if (!validateActor(actor).ok) return null
    const principal: StreamPrincipal = {
      subject: actor.id,
      actor,
      source: 'client-web',
      connectionId: 'local-web',
      profileId: host.profile.name,
      signal: lifetime.signal,
    }
    const attestation = request.headers['x-agnes-stream-row']
    if (typeof attestation === 'string') {
      const row = JSON.parse(Buffer.from(attestation, 'base64url').toString('utf8')) as ClientModuleRosterRow
      rows.set(principal, row)
    }
    return principal
  }
  const gateway = createPluginStreamGateway({ origin, broker, authenticate })
  const server = createServer((req, res) => {
    void gateway
      .handleHttp(req, res)
      .then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
      .catch(() => res.writeHead(403).end())
  })
  server.on('upgrade', (req, socket, head) => {
    void gateway.handleUpgrade(req, socket, head).catch(() => socket.destroy())
  })
  server.on('error', () => {
    lifetime.abort()
    gateway.close()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  const timer = setInterval(() => {
    for (const [key, entry] of registrations)
      try {
        entry.assert()
      } catch {
        entry.abort.abort()
        entry.release()
        registrations.delete(key)
      }
  }, 100)
  timer.unref()
  const close = () => {
    lifetime.abort()
    gateway.close()
    clearInterval(timer)
    server.closeAllConnections()
    server.close()
    endpoints.get(host)?.delete(origin)
  }
  const signal = runtime().signal
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) {
    close()
    throw new Error('streams-unavailable')
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('stream-endpoint-unavailable')
  return { host: '127.0.0.1', port: address.port, proof }
}
