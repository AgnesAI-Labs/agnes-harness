import type { RuntimeRecord } from '@agnes/jev-runtime'
import type { EventEnvelope, RuntimeIdentity } from '@agnes/protocol'
import type { Translate } from './jev-locale.js'

export type JevStatsEvidence = {
  runtime?: RuntimeIdentity | undefined
  events: readonly EventEnvelope[]
  complete: boolean
}

/** Match DSH's accepted decision → direct route → intent → dispatch definition. */
export function jevDirectCount(events: readonly EventEnvelope[]): number {
  let count = 0
  const scopes = new Map<
    string,
    { requests: Map<string, string>; decisions: Set<string>; intents: Set<string> }
  >()
  const ordered = [...new Map(events.map((event) => [event.seq, event])).values()].sort(
    (a, b) => a.seq - b.seq,
  )
  for (const event of ordered) {
    if (event.type !== 'runtime/record' || event.origin !== 'system' || event.trust !== 'trusted') continue
    const { runtime, record } = event.data as unknown as {
      runtime?: RuntimeIdentity
      record?: RuntimeRecord
    }
    if (runtime?.id !== 'jevloop' || runtime.version !== '1' || record?.version !== 1) continue
    const key = JSON.stringify([event.lane, record.turn, record.step])
    let scope = scopes.get(key)
    if (!scope) {
      scope = { requests: new Map(), decisions: new Set(), intents: new Set() }
      scopes.set(key, scope)
    }
    switch (record.kind) {
      case 'decision.selected':
        if (record.source !== 'llm_arbitration') scope.requests.set(record.requested, record.id)
        break
      case 'resource.observed': {
        const route = record.resource
        if (
          route === null ||
          typeof route !== 'object' ||
          Array.isArray(route) ||
          route.kind !== 'jev.candidate.route.v1' ||
          route.route !== 'direct'
        )
          break
        const decision =
          typeof route.decisionRecordId === 'string'
            ? route.decisionRecordId
            : typeof route.requested === 'string'
              ? scope.requests.get(route.requested)
              : undefined
        if (decision !== undefined && [...scope.requests.values()].includes(decision))
          scope.decisions.add(decision)
        break
      }
      case 'action.intended':
        if (scope.decisions.has(record.decision)) scope.intents.add(record.intent.id)
        break
      case 'action.dispatching':
        if (scope.intents.delete(record.intentId)) count++
        break
      case 'action.settled':
        scope.intents.delete(record.intentId)
        break
    }
  }
  return count
}

/** The caller supplies a complete root-session ledger or a committed comparison replay prefix. */
export function createJevDirectStats(
  host: HTMLElement,
  scope: 'session' | 'comparison' = 'session',
  t: Translate,
) {
  const reading = document.createElement('span')
  reading.className = 'jev-direct-stats'
  reading.dataset.jevDirectCount = ''
  reading.dataset.jevDirectScope = scope
  reading.title = t('stats.reading.title', {
    scope: t(scope === 'session' ? 'stats.scope.session' : 'stats.scope.comparison'),
  })
  reading.hidden = true
  host.append(reading)
  return {
    update({ runtime, events, complete }: JevStatsEvidence) {
      reading.hidden =
        runtime?.id !== 'jevloop' || runtime.version !== '1' || (scope === 'session' && !complete)
      reading.textContent = reading.hidden
        ? ''
        : complete
          ? t('stats.reading.count', { count: jevDirectCount(events) })
          : t('stats.reading.pending')
    },
  }
}
