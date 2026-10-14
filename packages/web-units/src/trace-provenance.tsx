import type { FactChainNode, FactChainParams, FactChainResult } from '@agnes/protocol'
import { useEffect, useState } from 'react'
import { type TraceMessageKey, traceText } from './trace-locale.js'

export type ReadFactChain = (params: FactChainParams, signal?: AbortSignal) => Promise<FactChainResult>

type Link = { key: string; label: string; value: string; detail?: readonly string[] }

const ATTEMPT_STATUS: Record<string, TraceMessageKey> = {
  completed: 'trace.status.completed',
  failed: 'trace.status.failed',
  cancelled: 'trace.status.cancelled',
  sent: 'trace.provenance.sent',
  'not-sent': 'trace.provenance.notSent',
}

/**
 * The request's provenance, read in place: model → attempt → session configuration → plugin
 * versions retained when it was sent. Links with nothing recorded are left out, so the chain never
 * shows empty or zero entries.
 */
export function provenanceLinks(result: FactChainResult, callId: string): Link[] {
  const of = <K extends FactChainNode['kind']>(kind: K) =>
    result.nodes.filter((node): node is Extract<FactChainNode, { kind: K }> => node.kind === kind)
  const request = of('request').find((node) => node.callId === callId) ?? of('request')[0]
  const attempts = of('attempt')
    .filter((node) => !request || node.parentCallId === request.callId)
    .sort((a, b) => a.index - b.index)
  const last = attempts.at(-1)
  const bundles = of('composition').flatMap((node) => node.bundles)
  const packages = of('generation').flatMap((node) => node.packages)
  const links: Link[] = []
  if (request?.model)
    links.push({ key: 'model', label: traceText('trace.provenance.model'), value: request.model })
  if (last)
    links.push({
      key: 'attempt',
      label: traceText('trace.provenance.attempt'),
      value: traceText('trace.provenance.attemptValue', {
        n: last.index + 1,
        total: attempts.length,
        status: traceText(ATTEMPT_STATUS[last.status] ?? 'trace.provenance.unknown'),
      }),
    })
  if (bundles.length)
    links.push({
      key: 'composition',
      label: traceText('trace.provenance.composition'),
      value: traceText('trace.provenance.bundles', { n: bundles.length }),
      detail: bundles,
    })
  if (packages.length)
    links.push({
      key: 'packages',
      label: traceText('trace.provenance.packages'),
      value: traceText('trace.provenance.packageCount', { n: packages.length }),
      detail: packages.map((item) => `${item.packageId} · ${item.version}`),
    })
  return links
}

/** Reads the request's fact chain once per request and draws it as a short vertical chain. */
export function TraceProvenance({
  sessionId,
  callId,
  read,
}: {
  sessionId: string
  callId: string
  read: ReadFactChain
}) {
  const [state, setState] = useState<
    { key: string; links: Link[] } | { key: string; error: true } | undefined
  >()
  const key = `${sessionId}:${callId}`
  useEffect(() => {
    const controller = new AbortController()
    read({ sessionId, laneId: 'main', anchor: { kind: 'request', callId } }, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setState({ key, links: provenanceLinks(result, callId) })
      },
      () => {
        if (!controller.signal.aborted) setState({ key, error: true })
      },
    )
    return () => controller.abort()
  }, [read, sessionId, callId, key])
  const current = state?.key === key ? state : undefined
  if (!current)
    return (
      <p className="trace-detail-status" role="status">
        {traceText('trace.provenance.loading')}
      </p>
    )
  if ('error' in current)
    return (
      <p className="trace-detail-status" role="alert">
        {traceText('trace.provenance.failed')}
      </p>
    )
  if (current.links.length === 0)
    return <p className="trace-detail-status">{traceText('trace.provenance.empty')}</p>
  return (
    <ol className="trace-chain" data-testid="trace-provenance">
      {current.links.map((link) => (
        <li key={link.key} className="trace-chain-link" data-link={link.key}>
          <span className="trace-chain-label">{link.label}</span>
          <span className="trace-chain-value">{link.value}</span>
          {link.detail?.length ? (
            <ul className="trace-chain-detail">
              {link.detail.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
