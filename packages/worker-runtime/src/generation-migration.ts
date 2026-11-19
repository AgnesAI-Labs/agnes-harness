import { type Host, HostError } from '@agnes/host'

/** The worker checks recovery and the coordinator's exact target before changing a session pin. */
export function migrateSessionGeneration(
  host: Host | undefined,
  p: Record<string, unknown>,
  resourceRecoveryRequired?: () => boolean,
) {
  if (!host?.migrateSessionGeneration) throw new Error('Session generation migration is unavailable')
  if (typeof p.sessionId !== 'string' || !p.sessionId || p.sessionId.length > 512)
    throw new TypeError('invalid session key')
  if (resourceRecoveryRequired?.())
    throw new HostError(
      'E_GENERATION_EXECUTION_UNSETTLED',
      'generation migration refused: recovery-required',
      {
        detail: { reasons: [{ kind: 'recovery-required', id: p.sessionId, sessionKey: p.sessionId }] },
      },
    )
  return host.migrateSessionGeneration(p.sessionId, {
    ...(typeof p.superagentIntegrity === 'string'
      ? { expectedPackage: { id: '@agnes/superagent', integrity: p.superagentIntegrity } }
      : {}),
    ...(resourceRecoveryRequired === undefined ? {} : { recoveryRequired: resourceRecoveryRequired }),
    ...(Array.isArray(p.repin) && p.repin.every((kind) => typeof kind === 'string')
      ? { repin: p.repin as string[] }
      : {}),
    ...(typeof p.operator === 'string' ? { operator: p.operator } : {}),
  })
}
