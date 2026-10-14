import type { FactChainAnchor, FactChainNode, FactChainResult } from '@agnes/protocol'
import { validateMethod } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import type { UiExtensionContext } from '@agnes/web-client'
import { Button, Disclosure, Icon, Segmented, SettingsState } from '@agnes/web-ui'
import { FeedbackProvenance } from '@agnes/web-units/message-feedback'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { toolIconReact } from '../tool-icon.js'
import { ArtifactDownload } from './artifact-download.js'
import { panelContext } from './context.js'
import {
  type ActivityFilter,
  type ActivityRow,
  type ActivityStatus,
  activityTimeline,
  anchorKey,
  changedPath,
  formatDuration,
  matchesFilter,
  receiptStatus,
} from './fact-timeline.js'
import { ReviewEvidence } from './review-evidence.js'

type T = UiExtensionContext['t']

function anchorFor(node: FactChainNode): FactChainAnchor | undefined {
  if (node.kind === 'request') return { kind: 'request', callId: node.callId }
  if (node.kind === 'invocation') return { kind: 'tool', toolUseId: node.toolUseId }
  if (node.kind === 'artifact') return { kind: 'artifact', seq: node.seq, ref: node.ref }
  if (node.kind === 'authoring') return { kind: 'authoring', candidateId: node.candidateId }
  return undefined
}
const toolLabel = (t: T, name: string) => {
  const key = `facts.tool.${name}`
  const label = t(key)
  return label === key ? name : label
}
const number = (value: number) => value.toLocaleString(document.documentElement.lang || undefined)
const tokens = (t: T, value: { input: number; output: number }) =>
  t('facts.tokens', { input: number(value.input), output: number(value.output) })
const clock = (value: string | undefined, seconds = false) =>
  value
    ? new Date(value).toLocaleTimeString(document.documentElement.lang || undefined, {
        hour: '2-digit',
        minute: '2-digit',
        ...(seconds ? { second: '2-digit' } : {}),
      })
    : undefined

export function StatusTag({ status, t }: { status: ActivityStatus | undefined; t: T }) {
  return status ? (
    <span className="workbench-tag" data-tone={status.tone} data-testid="activity-status">
      {t(status.key)}
    </span>
  ) : null
}

/**
 * The session's execution record: a timeline of the current session, newest turn first. Opening a
 * row reads that call's fact chain in place. Records are read-only; a future-call rule is the only
 * thing saved here, and it is an explicit new rule, never an edit of the past.
 */
export function FactChainPanel({ context }: { context: UiExtensionContext }) {
  const { session, timeline, factChain: target } = panelContext(context)
  const { t } = context
  const sessionId = session?.id
  const turns = useMemo(() => activityTimeline(timeline), [timeline])
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [selected, setSelected] = useState<string>()
  const [settled, setSettled] = useState<Record<string, ActivityStatus>>({})
  const targetKey = target?.sessionId === sessionId ? JSON.stringify(target) : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session starts with no selection and no read receipts.
  useEffect(() => {
    setSelected(undefined)
    setSettled({})
    setFilter('all')
  }, [sessionId])
  // A link from the conversation, the changes or a deliverable selects its row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized target is the link's identity.
  useEffect(() => {
    if (!target || target.sessionId !== sessionId) return
    setSelected(anchorKey(target.anchor))
    setFilter('all')
  }, [targetKey])
  useEffect(() => {
    if (!selected) return
    const frame = requestAnimationFrame(() =>
      document
        .querySelector(`[data-row-key="${CSS.escape(selected)}"]`)
        ?.scrollIntoView?.({ block: 'nearest' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [selected])
  if (!session) return <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
  const rows = turns.flatMap((turn) => turn.rows)
  const linked =
    target && target.sessionId === session.id && selected === anchorKey(target.anchor) ? target : undefined
  // A record the timeline does not list (an older turn, a drafting candidate) opens on its own.
  const pinned = linked && !rows.some((row) => row.key === selected) ? linked : undefined
  const visible = turns
    .map((turn) => ({
      ...turn,
      rows: turn.rows.filter((row) => matchesFilter(row, filter, settled[row.key])),
    }))
    .filter((turn) => turn.rows.length > 0)
  const count = visible.reduce((total, turn) => total + turn.rows.length, 0)
  const settle = (key: string, status: ActivityStatus | undefined) =>
    status &&
    setSettled((value) =>
      value[key]?.key === status.key && value[key]?.tone === status.tone
        ? value
        : { ...value, [key]: status },
    )
  return (
    <section className="fact-chain" aria-label={t('facts.title')} data-testid="fact-chain">
      {(rows.length > 0 || !pinned) && (
        <div className="workbench-tab-toolbar">
          <Segmented
            label={t('facts.filter')}
            value={filter}
            onChange={(value) => setFilter(value as ActivityFilter)}
            testId="activity-filter"
            options={(['all', 'tools', 'issues'] as const).map((value) => ({
              value,
              label: t(`facts.filter.${value}`),
              testId: `activity-filter-${value}`,
            }))}
          />
          <span className="workbench-tab-summary" data-testid="activity-summary">
            {t('facts.summary', { count })}
          </span>
        </div>
      )}
      <div className="workbench-activity-scroll">
        {pinned && (
          <article className="workbench-activity-pinned" data-testid="activity-pinned">
            <ActivityRecord
              context={context}
              session={session}
              laneId={pinned.laneId}
              anchor={pinned.anchor}
              onSettled={() => undefined}
            />
          </article>
        )}
        {visible.map((turn) => (
          <section
            key={turn.id}
            className="workbench-activity-turn"
            aria-label={t('facts.turn', { turn: turn.turn })}
          >
            <h4 className="workbench-activity-turn-head">
              {[
                t('facts.turn', { turn: turn.turn }),
                clock(turn.startedAt),
                turn.prompt && `「${turn.prompt}」`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </h4>
            <ul className="workbench-activity-list">
              {turn.rows.map((row) => {
                const open = selected === row.key
                return (
                  <li key={row.key} data-row-key={row.key} data-open={open}>
                    <Button
                      type="text"
                      className="workbench-activity-row"
                      data-testid="activity-row"
                      data-kind={row.kind}
                      aria-expanded={open}
                      onClick={() => setSelected(open ? undefined : row.key)}
                    >
                      <span className="workbench-activity-icon" data-kind={row.kind} aria-hidden="true">
                        {row.kind === 'tool' ? (
                          toolIconReact(row.name)
                        ) : (
                          <Icon name={row.kind === 'request' ? 'sparkles' : 'file'} />
                        )}
                      </span>
                      <span className="workbench-activity-text">
                        <strong>{rowTitle(row, t)}</strong>
                        {rowDetail(row, t) && <small>{rowDetail(row, t)}</small>}
                      </span>
                      <span className="workbench-activity-meta">
                        <StatusTag status={settled[row.key] ?? row.status} t={t} />
                        {row.durationMs !== undefined && <span>{formatDuration(row.durationMs)}</span>}
                      </span>
                    </Button>
                    {open && (
                      <div className="workbench-activity-details" data-testid="activity-details">
                        {row.anchor ? (
                          <ActivityRecord
                            context={context}
                            session={session}
                            laneId={
                              linked?.anchor && anchorKey(linked.anchor) === row.key ? linked.laneId : 'main'
                            }
                            anchor={row.anchor}
                            row={row}
                            onSettled={(status) => settle(row.key, status)}
                          />
                        ) : (
                          <KeyFacts row={row} t={t} context={context} sessionId={session.id} />
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {!rows.length && !pinned && <SettingsState tone="empty">{t('facts.empty')}</SettingsState>}
        {rows.length > 0 && !count && <SettingsState tone="empty">{t('facts.filterEmpty')}</SettingsState>}
        <FeedbackProvenance sessionId={session.id} />
      </div>
      <footer className="workbench-tab-footer">
        <Icon name="info" size={16} />
        <p>{t('facts.readOnly')}</p>
      </footer>
    </section>
  )
}

function rowTitle(row: ActivityRow, t: T): string {
  if (row.kind === 'request')
    return row.purpose && row.purpose !== 'inference'
      ? `${t('facts.request')} · ${t(`facts.purpose.${row.purpose}`)}`
      : t('facts.request')
  if (row.kind === 'artifact') return t('facts.artifact')
  return toolLabel(t, row.name)
}
function rowDetail(row: ActivityRow, t: T): string | undefined {
  if (row.kind === 'request')
    return [
      row.name,
      row.tokens && tokens(t, row.tokens),
      row.credits !== undefined && t('facts.credits', { credits: row.credits }),
    ]
      .filter(Boolean)
      .join(' · ')
  if (row.kind === 'artifact') return `${row.name} · ${row.detail}`
  return row.detail
}

/** The few facts a reader needs first; everything else stays under 技术详情. */
function KeyFacts({
  row,
  result,
  t,
  context,
  sessionId,
  laneId = 'main',
}: {
  row?: ActivityRow | undefined
  result?: FactChainResult | undefined
  t: T
  context: UiExtensionContext
  sessionId: string
  laneId?: string
}) {
  const nodes = result?.nodes ?? []
  const invocation = nodes.find((node) => node.kind === 'invocation')
  const review = invocation?.review ?? row?.tool?.review
  const request = nodes.find((node) => node.kind === 'request')
  const receipt = nodes.find((node) => node.kind === 'receipt')
  const artifacts = nodes.filter((node) => node.kind === 'artifact')
  const authoring = nodes.find((node) => node.kind === 'authoring')
  const ui = nodes.filter((node) => node.kind === 'plugin-fact')
  const path = row && changedPath(row)
  const facts: [string, ReactNode][] = []
  if (request || row?.kind === 'request')
    facts.push([
      t('facts.model'),
      [request?.model ?? row?.name, row?.tokens && tokens(t, row.tokens)].filter(Boolean).join(' · '),
    ])
  if (review)
    facts.push([
      t('facts.authorization'),
      `${t(
        review.source === 'human-override'
          ? 'facts.reviewHumanRule'
          : review.decision === 'allow'
            ? 'facts.reviewAllowed'
            : review.decision === 'deny'
              ? 'facts.reviewDenied'
              : 'facts.reviewEscalated',
      )}: ${review.reason}`,
    ])
  else if (row?.tool?.enforcement)
    facts.push([t('facts.authorization'), t(`facts.enforcement.${row.tool.enforcement.level}`)])
  if (receipt)
    facts.push([
      t('facts.result'),
      <>
        {t(
          receipt.resultKind === 'deferred-accepted'
            ? 'facts.deferred'
            : receipt.outcome === 'error'
              ? 'facts.errorResult'
              : `facts.${receipt.outcome}`,
        )}
        {receipt.partial && ` · ${t('facts.partial')}`}
        {receipt.resultKind === 'synthetic' && ` · ${t('facts.synthetic')}`}
      </>,
    ])
  else if (row?.tool?.resultPreview)
    facts.push([t('facts.result'), row.tool.resultPreview.split('\n')[0]?.slice(0, 160)])
  if (path)
    facts.push([
      t('facts.affects'),
      <Button
        key="affects"
        type="link"
        size="small"
        data-testid="activity-affects"
        disabled={!context.openPanel}
        onClick={() => context.openPanel?.('changed-files', { sessionId, path })}
      >
        {t('facts.affectsChange', { path })}
      </Button>,
    ])
  for (const artifact of artifacts)
    facts.push([
      t('facts.artifact'),
      <span key={artifact.id} className="workbench-activity-artifact">
        {t(`facts.${artifact.relation}`)} · {artifact.ref.mime}
        <ArtifactDownload artifact={artifact.ref} laneId={laneId} sessionId={sessionId} context={context} />
      </span>,
    ])
  if (authoring)
    facts.push([
      t('facts.authoring'),
      [
        `${authoring.packageId} ${authoring.version} · ${t(`facts.${authoring.state}`)}`,
        t(
          authoring.testsState === 'passed'
            ? 'facts.testPassed'
            : authoring.testsState === 'failed'
              ? 'facts.testFailed'
              : 'facts.testUnknown',
          { count: authoring.testsCount },
        ),
        t(authoring.reviewed ? 'facts.reviewed' : 'facts.unreviewed'),
      ].join(' · '),
    ])
  for (const node of ui)
    facts.push([
      t('facts.plugin-fact'),
      <span key={node.id} data-testid="ui-fact-chain-node">
        {node.label} · {t('facts.uiRevision', { revision: node.revision })} · {t(`facts.ui.${node.event}`)}
      </span>,
    ])
  const time = clock(row?.startedAt, true)
  if (time) facts.push([t('facts.time'), time])
  return (
    <>
      {facts.length > 0 && (
        <dl className="workbench-activity-facts">
          {facts.map(([term, value], index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one render's facts in a fixed order.
            <div key={index}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {invocation?.review && <ReviewEvidence name={invocation.name} review={invocation.review} t={t} />}
    </>
  )
}

/** One call's fact chain, read when its row opens. Related records open in place, with a way back. */
function ActivityRecord({
  context,
  session,
  laneId,
  anchor: root,
  row,
  onSettled,
}: {
  context: UiExtensionContext
  session: Session
  laneId: string
  anchor: FactChainAnchor
  row?: ActivityRow
  onSettled(status: ActivityStatus | undefined): void
}) {
  const { t } = context
  const [trail, setTrail] = useState<FactChainAnchor[]>([])
  const [record, setRecord] = useState<{ key: string; result: FactChainResult }>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const anchor = trail.at(-1) ?? root
  const key = JSON.stringify([session.id, laneId, anchor, retry])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized key names the read.
  useEffect(() => {
    let active = true
    const abort = new AbortController()
    setError('')
    const read =
      anchor.kind === 'authoring'
        ? fetch('/admin/api/fact-chain', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: session.id, laneId, anchor }),
            signal: abort.signal,
          }).then(async (response) => {
            const value: unknown = await response.json()
            if (!response.ok || !validateMethod('_agnes/v1/session.factChain', 'result', value).ok)
              throw new Error('Unavailable')
            return value as FactChainResult
          })
        : session.factChain(anchor, laneId, { timeoutMs: 10_000 })
    void read
      .then((result) => {
        if (!active) return
        setRecord({ key, result })
        if (!trail.length) onSettled(receiptStatus(result))
      })
      .catch(() => {
        if (active) setError(t('facts.error'))
      })
    return () => {
      active = false
      abort.abort()
    }
  }, [key, t])
  const result = record?.key === key ? record.result : undefined
  return (
    <div className="workbench-activity-record">
      {trail.length > 0 && (
        <Button size="small" onClick={() => setTrail((value) => value.slice(0, -1))}>
          <Icon name="arrow-left" />
          {t('facts.back')}
        </Button>
      )}
      {anchor.kind === 'authoring' && (
        <FeedbackProvenance sessionId={session.id} candidateId={anchor.candidateId} />
      )}
      {error ? (
        <SettingsState tone="error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setRetry((value) => value + 1)}>{t('facts.retry')}</Button>
        </SettingsState>
      ) : !result ? (
        <>
          {!trail.length && row && (
            <KeyFacts row={row} t={t} context={context} sessionId={session.id} laneId={laneId} />
          )}
          <SettingsState tone="loading" role="status">
            {t('facts.loading')}
          </SettingsState>
        </>
      ) : (
        <>
          <KeyFacts
            row={trail.length ? undefined : row}
            result={result}
            t={t}
            context={context}
            sessionId={session.id}
            laneId={laneId}
          />
          {result.gaps.length > 0 && (
            <p className="workbench-activity-gaps">
              <strong>{t('facts.gaps')}</strong>{' '}
              {[...new Set(result.gaps.map((gap) => gap.reason))]
                .map((reason) => t(`facts.${reason}`))
                .join(' ')}
            </p>
          )}
          <Disclosure className="workbench-activity-technical" summary={t('facts.details')}>
            <ol className="fact-chain-nodes">
              {result.nodes.map((node) => (
                <li key={node.id} data-fact-kind={node.kind}>
                  <strong>{t(`facts.${node.kind}`)}</strong> <NodeLine node={node} t={t} />
                  {anchorFor(node) && JSON.stringify(anchorFor(node)) !== JSON.stringify(anchor) && (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => setTrail((value) => [...value, anchorFor(node) as FactChainAnchor])}
                    >
                      {t('facts.inspect')}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </Disclosure>
        </>
      )}
    </div>
  )
}

/** The identifiers a reader quotes in a report: sequence numbers, IDs and retained plugin versions. */
function NodeLine({ node, t }: { node: FactChainNode; t: T }) {
  if (node.kind === 'composition') return <>{t('facts.bundles', { count: node.bundles.length })}</>
  if (node.kind === 'generation')
    return (
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
    )
  if (node.kind === 'request') return <>{node.model}</>
  if (node.kind === 'invocation')
    return (
      <>
        {toolLabel(t, node.name)} · {t('facts.toolUseId')} {node.toolUseId} · {t('facts.callSeq')}{' '}
        {node.callSeq}
      </>
    )
  if (node.kind === 'attempt')
    return (
      <>
        {t('facts.attemptNumber', { number: node.index + 1 })} · {t(`facts.${node.status}`)}
      </>
    )
  if (node.kind === 'receipt')
    return (
      <>
        {t('facts.external')}
        {node.resultSeq !== null && ` · ${t('facts.resultSeq')} ${node.resultSeq}`}
      </>
    )
  if (node.kind === 'artifact')
    return (
      <>
        {t(`facts.${node.relation}`)} · {node.ref.mime}
      </>
    )
  if (node.kind === 'authoring')
    return (
      <>
        {node.packageId} {node.version} · {t(`facts.${node.state}`)}
      </>
    )
  if (node.kind === 'plugin-fact')
    return (
      <>
        {node.label} · {t('facts.uiRevision', { revision: node.revision })}
      </>
    )
  return null
}
