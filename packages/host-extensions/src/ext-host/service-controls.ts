import { createHash, randomUUID } from 'node:crypto'
import type { Actor, ExtensionCallParams, JsonValue } from '@agnes/protocol'
import { jcs, rpcError } from '@agnes/protocol'
import type { ServiceRegistration } from './services.js'

/** Ephemeral authority created only after native journal admission. Restart never revives control. */
export function serviceControls(now = Date.now) {
  const records = new Map<
    string,
    {
      entry: ServiceRegistration
      sessionId: string
      actor: string
      source: string
      input: string
      grantId: string
      expiresAt: number
      expiresTick: number
    }
  >()
  const key = (params: ExtensionCallParams, id: string) =>
    JSON.stringify([params.sessionId, params.extension, params.service, id])
  const fingerprint = (value: JsonValue) => createHash('sha256').update(jcs(value)).digest('hex')
  const prune = () => {
    for (const [key, record] of records)
      if (record.expiresAt <= now() || record.expiresTick <= performance.now() || record.entry.signal.aborted)
        records.delete(key)
  }
  return {
    prepare(entry: ServiceRegistration, params: ExtensionCallParams, actor: Actor, source: string) {
      prune()
      const leaseMs = 'controlLeaseMs' in entry.capability ? entry.capability.controlLeaseMs : undefined
      if (!leaseMs) return undefined
      if (entry.capability.kind !== 'effect' || !params.commandId || records.size >= 1024)
        throw rpcError('CAPABILITY_DENIED')
      const grantId = randomUUID()
      const duration =
        'controlSessionMs' in entry.capability ? (entry.capability.controlSessionMs ?? leaseMs) : leaseMs
      const record = {
        entry,
        sessionId: params.sessionId,
        actor: fingerprint(actor),
        source,
        input: fingerprint(params.input),
        grantId,
        expiresAt: now() + duration,
        expiresTick: performance.now() + duration,
      }
      return {
        grant: Object.freeze({ grantId, expiresAt: record.expiresAt }),
        commit() {
          records.set(key(params, params.commandId!), record)
        },
      }
    },
    authorize(
      entry: ServiceRegistration,
      params: ExtensionCallParams,
      operationId: string,
      actor: Actor,
      source: string,
    ) {
      prune()
      const record = records.get(key(params, operationId))
      if (
        !record ||
        record.entry !== entry ||
        record.source !== source ||
        record.actor !== fingerprint(actor) ||
        record.input !== fingerprint(params.input)
      )
        throw rpcError('CAPABILITY_DENIED')
      return {
        grantId: record.grantId,
        expiresAt:
          now() +
          Math.floor(
            Math.min(
              record.expiresAt - now(),
              record.expiresTick - performance.now(),
              'controlLeaseMs' in entry.capability ? entry.capability.controlLeaseMs! : 0,
            ),
          ),
        actor,
        source,
        integrity: entry.integrity,
        revision: entry.activationRevision ?? '',
      }
    },
  }
}
