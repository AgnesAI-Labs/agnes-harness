import { platformView, type SeamImplementations } from '@agnes/core'
import type { Logger, PersistenceMetadataPort, ServiceContext } from '@agnes/extension-api'
import { createNetFetch } from '@agnes/host-infrastructure/adapters/net'
import { rpcError } from '@agnes/protocol'
import { frozenJson } from '../ext-host/frozen-json.js'
import type { ServiceRegistration } from '../ext-host/services.js'
import { ownedStore } from './owned-store.js'

export function profileServiceContext(input: {
  profileId: string
  activationId: string
  entry: ServiceRegistration
  identity: Pick<ServiceContext, 'actor' | 'source' | 'requestId' | 'signal'>
  seams: SeamImplementations
  metadata: PersistenceMetadataPort
  log: Logger
  alive(): void
  writable: boolean
  sessionReads?: readonly string[]
  networkAllow: readonly string[]
  admission?: ServiceContext['admission']
}): ServiceContext {
  const { entry, identity } = input
  const alive = () => {
    identity.signal.throwIfAborted()
    input.alive()
  }
  const refuse = (): never => {
    throw rpcError('CAPABILITY_DENIED')
  }
  return Object.freeze({
    ...identity,
    scope: Object.freeze({
      kind: 'profile' as const,
      profileId: input.profileId,
      activationId: input.activationId,
    }),
    ...(input.admission ? { admission: frozenJson(input.admission) } : {}),
    sessionAccess: Object.freeze({
      async requireRead(sessionId: string) {
        alive()
        if (!input.sessionReads?.includes(sessionId)) refuse()
      },
    }),
    cwd: '',
    timeoutMs: entry.capability.timeoutMs,
    ...(entry.declaredCapabilities?.store === true
      ? {
          store: ownedStore(
            input.metadata.namespace(entry.owner, `profile:${input.profileId}`),
            alive,
            input.writable,
          ),
        }
      : {}),
    exec: refuse,
    fs: Object.freeze({ read: refuse, list: refuse, stat: refuse, write: refuse }),
    artifacts: Object.freeze({ get: refuse, poll: refuse, put: refuse, submitJob: refuse, cancel: refuse }),
    net: Object.freeze({
      fetch: async (url, init) => {
        alive()
        const target = new URL(url)
        const host = target.hostname.toLowerCase(),
          port = target.port || (target.protocol === 'https:' ? '443' : '80')
        const matches = (hosts: readonly string[]) =>
          hosts.some((item) => item.toLowerCase() === host || item.toLowerCase() === `${host}:${port}`)
        if (
          !['http:', 'https:'].includes(target.protocol) ||
          target.username ||
          target.password ||
          !matches(entry.declaredCapabilities?.network ?? []) ||
          !matches(input.networkAllow) ||
          (!input.writable && (!['GET', 'HEAD'].includes(init?.method ?? 'GET') || init?.body !== undefined))
        )
          refuse()
        const response = await createNetFetch({ signal: identity.signal, redirect: 'error' })(url, init)
        alive()
        return response
      },
    } satisfies ServiceContext['net']),
    authorize: async (action, target) => {
      alive()
      const result = await input.seams.principals.authorize(identity.actor, action, target)
      alive()
      return result
    },
    platform: platformView(input.seams.platform),
    log: input.log,
  } satisfies ServiceContext)
}
