import type { ClientContext } from '@agnes/web-client'
import { record, text } from './model.js'
import type { DeveloperPort } from './ports.js'
import { profileServices } from './profile-services.js'

/** The generic managed facade uses scoped services and the ordinary native approval journal. */
export function nativeDeveloper(ctx: ClientContext): DeveloperPort {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const services = profileServices(ctx.profile.services)
  const effect = async (name: string, input: import('@agnes/protocol').JsonValue) => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(300000)])
    let receipt = await services.effect(name, input, { operationId: crypto.randomUUID(), signal })
    while (receipt.state === 'approval-required' || receipt.state === 'running') {
      signal.throwIfAborted()
      await new Promise((resolve) => setTimeout(resolve, 300))
      receipt = await services.readOperation(receipt.operationId)
    }
    signal.throwIfAborted()
    if (receipt.state !== 'completed') throw new Error(receipt.code)
  }
  return {
    async status(signal) {
      const [rawStatus, rawConfig] = await Promise.all([
        services.query('hub.status', {}, { signal }),
        services.query('hub.configuration', {}, { signal }),
      ])
      const external = record(record(rawConfig).externalHub)
      const connection =
        text(external.address) &&
        record(rawStatus).state === 'ready' &&
        record(await services.query('mhs.connection', {}, { signal }))
      const config = record(record(rawConfig).listenerPorts),
        status = record(rawStatus),
        endpoint = record(record(status.endpoints).device)
      const port = endpoint.port
      return {
        mode: text(external.address) ? 'external' : 'local',
        ...(text(external.address)
          ? {
              address: text(external.address),
              allowlist: Array.isArray(external.allowlist)
                ? external.allowlist.filter((v): v is string => typeof v === 'string')
                : [],
            }
          : {}),
        state:
          connection && connection.state === 'failed'
            ? 'failed'
            : status.state === 'draining' || status.state === 'stopping'
              ? 'stopping'
              : status.state === 'ready'
                ? 'ready'
                : status.state === 'starting'
                  ? 'starting'
                  : status.code === 'shutdown-unconfirmed'
                    ? 'shutdown-unconfirmed'
                    : 'failed',
        ...(config.device === 'auto' || typeof config.device === 'number'
          ? { devicePort: config.device }
          : {}),
        ...(text(status.code) ? { code: text(status.code) } : {}),
        ...(!text(external.address) && endpoint.host === '127.0.0.1' && typeof port === 'number'
          ? {
              endpoints: {
                command: `ws://127.0.0.1:${port}/ws/mhs`,
                observation: `ws://127.0.0.1:${port}/ws/nerve`,
              },
            }
          : {}),
      }
    },
    retry: () => effect('hub.retry', {}),
    reconcile: () => effect('hub.reconcile', {}),
    configure: (port = 'auto', external) =>
      effect('hub.configure', {
        listenerPorts: { device: port },
        ...(external ? { externalHub: external } : {}),
      }),
    async check(device, signal) {
      const result = await services.query('hub.check', { device }, { signal })
      if (!Array.isArray(result)) throw new Error('invalid-managed-check')
      return result.map((value) => {
        const row = record(value)
        return {
          name: text(row.name),
          state: row.state === 'passed' ? 'passed' : row.state === 'failed' ? 'failed' : 'unknown',
          ...(text(row.detail) ? { detail: text(row.detail) } : {}),
        }
      })
    },
  }
}
