import type { FactChainAnchor, FactChainNode, FactChainResult } from '@agnes/protocol'
import { validateMethod } from '@agnes/protocol'
import type { UiExtensionContext } from '@agnes/web-client'
import { Button, SettingsState } from '@agnes/web-ui'
import { FeedbackProvenance } from '@agnes/web-units/message-feedback'
import { useEffect, useState } from 'react'
import { panelContext } from './context.js'
import { ReviewEvidence } from './review-evidence.js'

function anchorFor(node: FactChainNode): FactChainAnchor | undefined {
  if (node.kind === 'request') return { kind: 'request', callId: node.callId }
  if (node.kind === 'invocation') return { kind: 'tool', toolUseId: node.toolUseId }
  if (node.kind === 'artifact') return { kind: 'artifact', seq: node.seq, ref: node.ref }
  if (node.kind === 'authoring') return { kind: 'authoring', candidateId: node.candidateId }
  return undefined
}
export function FactChainPanel({ context }: { context: UiExtensionContext }) {
  const { session, factChain: target } = panelContext(context)
  const { t } = context
  const [trail, setTrail] = useState<{ root: string | undefined; anchors: FactChainAnchor[] }>({
    root: undefined,
    anchors: [],
  })
  const [record, setRecord] = useState<{ key: string; result: FactChainResult }>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const targetKey = JSON.stringify(target)
  const history = trail.root === targetKey ? trail.anchors : []
  const setHistory = (update: (value: FactChainAnchor[]) => FactChainAnchor[]) =>
    setTrail((value) => ({ root: targetKey, anchors: update(value.root === targetKey ? value.anchors : []) }))
  const anchor = history.at(-1) ?? target?.anchor
  const key = JSON.stringify([session?.id, target?.laneId, anchor, retry])
  useEffect(() => {
    let active = true
    const abort = new AbortController()
    setError('')
    if (!session || !anchor || target?.sessionId !== session.id) return
    const read =
      anchor.kind === 'authoring'
        ? fetch('/admin/api/fact-chain', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: session.id, laneId: target.laneId, anchor }),
            signal: abort.signal,
          }).then(async (response) => {
            const value: unknown = await response.json()
            if (!response.ok || !validateMethod('_agnes/v1/session.factChain', 'result', value).ok)
              throw new Error('Unavailable')
            return value as FactChainResult
          })
        : session.factChain(anchor, target.laneId, { timeoutMs: 10_000 })
    void read
      .then((result) => {
        if (active) setRecord({ key, result })
      })
      .catch(() => {
        if (active) setError(t('facts.error'))
      })
    return () => {
      active = false
      abort.abort()
    }
  }, [session, key, anchor, target?.sessionId, target?.laneId, t])
  if (!target || !anchor || target.sessionId !== session?.id)
    return <SettingsState>{t('facts.empty')}</SettingsState>
  const result = record?.key === key ? record.result : undefined
  return (
    <section className="fact-chain" aria-label={t('facts.title')} data-testid="fact-chain">
      {history.length > 0 && (
        <Button size="small" onClick={() => setHistory((value) => value.slice(0, -1))}>
          {t('facts.back')}
        </Button>
      )}
      <p>{t('facts.readOnly')}</p>
      <FeedbackProvenance
        sessionId={session.id}
        {...(anchor.kind === 'authoring' ? { candidateId: anchor.candidateId } : {})}
      />
      {error ? (
        <SettingsState tone="error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setRetry((value) => value + 1)}>{t('facts.retry')}</Button>
        </SettingsState>
      ) : !result ? (
        <SettingsState tone="loading" role="status">
          {t('facts.loading')}
        </SettingsState>
      ) : (
        <>
          <ol className="fact-chain-nodes">
            {result.nodes.map((node) => (
              <li key={node.id} data-fact-kind={node.kind}>
                <strong>{t(`facts.${node.kind}`)}</strong>
                {node.kind === 'composition' && <p>{t('facts.bundles', { count: node.bundles.length })}</p>}
                {node.kind === 'generation' && (
                  <ul>
                    {node.packages.map((pkg) => {
                      const key = `row.name.${pkg.packageId}`
                      const name = t(key)
                      return (
                        <li key={pkg.snapshotId}>
                          {name === key ? pkg.packageId.split('/').at(-1) : name} · {pkg.version}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {node.kind === 'plugin-fact' && (
                  <p data-testid="ui-fact-chain-node">
                    {node.label} · {t('facts.uiRevision', { revision: node.revision })} ·{' '}
                    {t(`facts.ui.${node.event}`)}
                  </p>
                )}
                {node.kind === 'request' && <p>{node.model}</p>}
                {node.kind === 'invocation' && (
                  <p>
                    {t(`facts.tool.${node.name}`) === `facts.tool.${node.name}`
                      ? node.name
                      : t(`facts.tool.${node.name}`)}
                  </p>
                )}
                {node.kind === 'invocation' && node.review && (
                  <ReviewEvidence name={node.name} review={node.review} t={t} />
                )}
                {node.kind === 'attempt' && (
                  <p>
                    {t('facts.attemptNumber', { number: node.index + 1 })} · {t(`facts.${node.status}`)}
                  </p>
                )}
                {node.kind === 'receipt' && (
                  <>
                    <p>
                      {t(
                        node.resultKind === 'deferred-accepted'
                          ? 'facts.deferred'
                          : node.outcome === 'error'
                            ? 'facts.errorResult'
                            : `facts.${node.outcome}`,
                      )}
                    </p>
                    {node.partial && <p>{t('facts.partial')}</p>}
                    {node.resultKind === 'synthetic' && <p>{t('facts.synthetic')}</p>}
                    <p>{t('facts.external')}</p>
                  </>
                )}
                {node.kind === 'artifact' && (
                  <p>
                    {t(`facts.${node.relation}`)} · {node.ref.mime}
                  </p>
                )}
                {node.kind === 'authoring' && (
                  <>
                    <p>
                      {node.packageId} {node.version} · {t(`facts.${node.state}`)}
                    </p>
                    <p>
                      {t(
                        node.testsState === 'passed'
                          ? 'facts.testPassed'
                          : node.testsState === 'failed'
                            ? 'facts.testFailed'
                            : 'facts.testUnknown',
                        { count: node.testsCount },
                      )}
                    </p>
                    <p>{t(node.reviewed ? 'facts.reviewed' : 'facts.unreviewed')}</p>
                  </>
                )}
                {anchorFor(node) && JSON.stringify(anchorFor(node)) !== JSON.stringify(anchor) && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => setHistory((value) => [...value, anchorFor(node)!])}
                  >
                    {t('facts.inspect')}
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {result.gaps.length > 0 && (
            <section aria-label={t('facts.gaps')}>
              <strong>{t('facts.gaps')}</strong>
              <ul>
                {[...new Set(result.gaps.map((gap) => gap.reason))].map((reason) => (
                  <li key={reason}>{t(`facts.${reason}`)}</li>
                ))}
              </ul>
            </section>
          )}
          <details>
            <summary>{t('facts.details')}</summary>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  )
}
