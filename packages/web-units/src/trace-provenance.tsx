import type {
  ArtifactRef,
  FactChainAnchor,
  FactChainNode,
  FactChainParams,
  FactChainResult,
} from '@agnes/protocol'
import { Button, Disclosure } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { type TraceMessageKey, traceCatalog, traceText } from './trace-locale.js'
import { TraceReview } from './trace-review.js'

export type ReadFactChain = (params: FactChainParams, signal?: AbortSignal) => Promise<FactChainResult>
/** Loads one ledger artifact through the session's resource service; release frees its object URL. */
export type LoadArtifact = (input: {
  laneId: string
  artifact: ArtifactRef
}) => Promise<{ url: string; release(): void }>

type Link = { key: string; label: string; value: string; detail?: readonly string[] }
type Node<K extends FactChainNode['kind']> = Extract<FactChainNode, { kind: K }>
const of = <K extends FactChainNode['kind']>(result: FactChainResult, kind: K): Node<K>[] =>
  result.nodes.filter((node): node is Node<K> => node.kind === kind)

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
  const request = of(result, 'request').find((node) => node.callId === callId) ?? of(result, 'request')[0]
  const attempts = of(result, 'attempt')
    .filter((node) => !request || node.parentCallId === request.callId)
    .sort((a, b) => a.index - b.index)
  const last = attempts.at(-1)
  const bundles = of(result, 'composition').flatMap((node) => node.bundles)
  const packages = of(result, 'generation').flatMap((node) => node.packages)
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

/** A tool call's settled facts: its receipt and the business-UI records linked to it. */
export function toolLinks(result: FactChainResult): Link[] {
  const links: Link[] = []
  const receipt = of(result, 'receipt')[0]
  if (receipt)
    links.push({
      key: 'receipt',
      label: traceText('trace.facts.receipt'),
      value: [
        traceText(
          receipt.resultKind === 'deferred-accepted'
            ? 'trace.facts.deferred'
            : (`trace.facts.outcome.${receipt.outcome}` as TraceMessageKey),
        ),
        receipt.partial ? traceText('trace.facts.partial') : '',
        receipt.resultKind === 'synthetic' ? traceText('trace.facts.synthetic') : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })
  else if (of(result, 'invocation').length)
    links.push({
      key: 'receipt',
      label: traceText('trace.facts.receipt'),
      value: traceText('trace.facts.noReceipt'),
    })
  const ui = of(result, 'plugin-fact')
  if (ui.length)
    links.push({
      key: 'ui',
      label: traceText('trace.facts.ui'),
      value: traceText('trace.facts.uiCount', { n: ui.length }),
      detail: ui.map((node) => {
        const key = `trace.ui.${node.event}` as TraceMessageKey
        const event = Object.hasOwn(traceCatalog.en, key) ? traceText(key) : node.event
        return `${event} · ${node.label} · ${traceText('trace.ui.revision', { n: node.revision })}`
      }),
    })
  return links
}

function Chain({ links }: { links: readonly Link[] }) {
  return (
    <ol className="trace-chain" data-testid="trace-provenance">
      {links.map((link) => (
        <li key={link.key} className="trace-chain-link" data-link={link.key}>
          <span className="trace-chain-label">{link.label}</span>
          <span className="trace-chain-value">{link.value}</span>
          {link.detail?.length ? (
            <Disclosure variant="plain" summary={link.label}>
              <ul className="trace-chain-detail">
                {link.detail.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

/** Downloads one artifact the record produced or used, through the existing resource service. */
export function ArtifactDownload({
  artifact,
  laneId,
  load,
}: {
  artifact: Node<'artifact'>
  laneId: string
  load: LoadArtifact | undefined
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const [file, setFile] = useState<{ url: string; release(): void }>()
  const link = useRef<HTMLAnchorElement>(null)
  const mime = artifact.ref.mime
  const name = `${artifact.ref.sha256.slice(0, 12)}.${mime === 'application/pdf' ? 'pdf' : mime.startsWith('text/') ? 'txt' : 'bin'}`
  // The loaded file is handed to the browser through a rendered link, then released shortly after.
  useEffect(() => {
    if (!file) return
    link.current?.click()
    const timer = setTimeout(() => file.release(), 1000)
    return () => {
      clearTimeout(timer)
      file.release()
    }
  }, [file])
  const download = async () => {
    if (!load) return
    setState('busy')
    try {
      setFile(await load({ laneId, artifact: artifact.ref }))
      setState('idle')
    } catch {
      setState('failed')
    }
  }
  return (
    <li className="trace-artifact" data-testid="trace-artifact">
      <span>
        {traceText(`trace.facts.relation.${artifact.relation}` as TraceMessageKey)} · {mime}
      </span>
      <Button
        size="small"
        data-testid="artifact-download"
        disabled={!load || state === 'busy'}
        loading={state === 'busy'}
        onClick={() => void download()}
      >
        {traceText('trace.facts.download')}
      </Button>
      {file ? (
        <a ref={link} href={file.url} download={name} hidden={true}>
          {name}
        </a>
      ) : null}
      {state === 'failed' ? <p role="alert">{traceText('trace.facts.downloadFailed')}</p> : null}
    </li>
  )
}

/** The recorded candidate and its matching evidence; hashes stay behind an explicit disclosure. */
function AuthoringRecord({ node }: { node: Node<'authoring'> }) {
  return (
    <section className="trace-card" data-testid="trace-authoring">
      <h4>
        {node.packageId}
        {node.version ? ` ${node.version}` : ''} · {traceText(`trace.authoring.${node.state}`)}
      </h4>
      <p>
        {node.testsState
          ? traceText(
              node.testsState === 'passed' ? 'trace.authoring.testsPassed' : 'trace.authoring.testsFailed',
              { n: node.testsCount },
            )
          : traceText('trace.authoring.noTests')}
      </p>
      <p>{traceText(node.reviewed ? 'trace.authoring.reviewed' : 'trace.authoring.unreviewed')}</p>
      <Disclosure variant="plain" summary={traceText('trace.authoring.details')}>
        <pre className="trace-pre">
          {JSON.stringify(
            {
              candidateHash: node.candidateHash,
              baseHash: node.baseHash,
              testHash: node.testHash,
              reviewHash: node.reviewHash,
            },
            null,
            2,
          )}
        </pre>
      </Disclosure>
    </section>
  )
}

/**
 * The «Provenance» record, read in place through the fact-chain read: a request's provenance chain, or a
 * tool call's authorization (with future-call rules), receipt, artifacts and business-UI records.
 * Missing evidence is named, and the last line says what a record can and cannot prove.
 */
export function TraceSourceRecord({
  sessionId,
  anchor,
  read,
  loadArtifact,
  laneId = 'main',
  review = true,
}: {
  sessionId: string
  anchor: Extract<FactChainAnchor, { kind: 'request' } | { kind: 'tool' } | { kind: 'authoring' }>
  read: ReadFactChain
  loadArtifact?: LoadArtifact | undefined
  laneId?: string
  /** False when the row already shows its review with the future-call rules. */
  review?: boolean
}) {
  const key = JSON.stringify([sessionId, laneId, anchor])
  const [state, setState] = useState<{ key: string; result?: FactChainResult; error?: true }>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized key names the read.
  useEffect(() => {
    const controller = new AbortController()
    read({ sessionId, laneId, anchor }, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setState({ key, result })
      },
      () => {
        if (!controller.signal.aborted) setState({ key, error: true })
      },
    )
    return () => controller.abort()
  }, [read, key])
  const current = state?.key === key ? state : undefined
  if (!current)
    return (
      <p className="trace-detail-status" role="status">
        {traceText('trace.provenance.loading')}
      </p>
    )
  if (!current.result)
    return (
      <p className="trace-detail-status" role="alert">
        {traceText('trace.provenance.failed')}
      </p>
    )
  const result = current.result
  const links = anchor.kind === 'request' ? provenanceLinks(result, anchor.callId) : toolLinks(result)
  const invocation = of(result, 'invocation')[0]
  const artifacts = of(result, 'artifact')
  const authoring = of(result, 'authoring')
  const gaps = [...new Set(result.gaps.map((gap) => gap.reason))]
  const uncertain = of(result, 'receipt').some((receipt) => receipt.outcome === 'unknown')
  return (
    <div className="trace-source-record">
      {links.length ? (
        <Chain links={links} />
      ) : authoring.length ? null : (
        <p className="trace-detail-status">{traceText('trace.provenance.empty')}</p>
      )}
      {uncertain && <p role="status">{traceText('trace.facts.uncertain')}</p>}
      <Disclosure variant="plain" summary={traceText('trace.facts.technical')}>
        {authoring.map((node) => (
          <AuthoringRecord key={node.id} node={node} />
        ))}
        {review && invocation?.review ? (
          <TraceReview name={invocation.name} review={invocation.review} />
        ) : null}
        {artifacts.length ? (
          <ul className="trace-artifacts" aria-label={traceText('trace.facts.artifact')}>
            {artifacts.map((artifact) => (
              <ArtifactDownload key={artifact.id} artifact={artifact} laneId={laneId} load={loadArtifact} />
            ))}
          </ul>
        ) : null}
        {gaps.length ? (
          <p className="trace-raw-note" data-testid="trace-gaps">
            <strong>{traceText('trace.facts.gaps')}</strong>{' '}
            {gaps.map((reason) => traceText(`trace.facts.gap.${reason}` as TraceMessageKey)).join(' ')}
          </p>
        ) : null}
      </Disclosure>
    </div>
  )
}
