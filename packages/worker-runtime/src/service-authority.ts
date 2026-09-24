import type { ServiceAuthority } from '@agnes/host'
import { inspectJsonData, validateSurfaceServiceGrant } from '@agnes/protocol'

const SOURCE = /^[a-z][a-z0-9-]{0,63}$/

/** Validate the supervisor-authenticated authority again at the worker trust boundary. This wire
 * never accepts source secrets; only the already-resolved source id, subject credential and exact
 * deployment grants cross it. */
export function createWorkerServiceAuthority(): ServiceAuthority {
  return {
    async resolve(value) {
      const inspected = inspectJsonData(value, 65_536)
      if (
        !inspected.ok ||
        !inspected.value ||
        typeof inspected.value !== 'object' ||
        Array.isArray(inspected.value)
      )
        throw new Error('invalid service authority')
      const record = inspected.value as Record<string, unknown>
      if (
        !Object.keys(record).every((key) => ['kind', 'source', 'subjectCredential', 'grants'].includes(key))
      )
        throw new Error('invalid service authority')
      if (
        record.kind !== 'surface-service' ||
        typeof record.source !== 'string' ||
        !SOURCE.test(record.source)
      )
        throw new Error('invalid service authority')
      const subject = record.subjectCredential
      if (!subject || typeof subject !== 'object' || Array.isArray(subject))
        throw new Error('invalid service authority')
      const subjectKind = (subject as { kind?: unknown }).kind
      // The loopback Web BFF has already authenticated the browser with its server-owned bearer
      // and Origin/Host checks. It represents the same local principal used by the Unix client, but
      // this narrow source marker prevents an arbitrary surface-service envelope from smuggling a
      // `{ kind: 'local' }` credential across the worker boundary.
      const localWebSubject =
        record.source === 'client-web' &&
        subjectKind === 'local' &&
        Object.keys(subject as Record<string, unknown>).length === 1
      if (subjectKind !== 'jwt' && subjectKind !== 'sso' && !localWebSubject)
        throw new Error('invalid service authority')
      if (!Array.isArray(record.grants) || record.grants.length > 64)
        throw new Error('invalid service authority')
      if (!record.grants.every((grant) => validateSurfaceServiceGrant(grant).ok))
        throw new Error('invalid service authority')
      return Object.freeze({
        source: record.source,
        subjectCredential: structuredClone(subject),
        grants: Object.freeze(
          record.grants.map((grant) => Object.freeze(structuredClone(grant))) as Array<{
            extension: string
            name: string
            range: string
          }>,
        ),
      })
    },
  }
}
