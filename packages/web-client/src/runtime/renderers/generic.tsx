// The safe card the Web client shows for a domain view no registered renderer presents. View data is
// rendered as text only, never parsed as HTML or markdown. Command actions submit through the
// renderer context with the view's own action reference; a request id is made once per click and kept
// for the retries of that click, so a retry is answered by the original decision.
import type {
  CommandHandle,
  DataRef,
  DomainView,
  Outcome,
  RendererContext,
  SchemaRef,
  ViewAction,
} from '@agnes/extension-api/client'
import { Button, type StateLight, StateLights } from '@agnes/web-ui'
import { useState } from 'react'
import { type DomainMessageKey, domainText } from '../../locales/domain.js'

// A Map, so a phase naming an Object prototype key finds no tone.
const PHASE_TONES = new Map<string, StateLight['tone']>([
  ['provisional', 'warn'],
  ['finalized', 'ok'],
  ['interrupted', 'bad'],
])

// sha256 of the canonical JSON `{}`.
const EMPTY_DIGEST = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'

/** The card collects no input, so a command that needs some is refused and the refusal is shown. */
const emptyInput = (schema: SchemaRef): DataRef => ({
  kind: 'inline',
  schema,
  value: {},
  digest: EMPTY_DIGEST,
  bytes: 2,
})

type Attempt = Readonly<{
  requestId: string
  state: 'sending' | 'pending' | 'succeeded' | 'failed' | 'refused' | 'unknown'
  message: DomainMessageKey
  vars?: Readonly<Record<string, string | number>>
  /** Whether the next click resends this request id. */
  retry: boolean
}>

/** What one submit or status read means for the card. A thrown call may have arrived, so it retries. */
function settle(requestId: string, outcome: Outcome<CommandHandle> | undefined): Attempt {
  const at = (
    state: Attempt['state'],
    message: DomainMessageKey,
    retry = false,
    vars?: Readonly<Record<string, string | number>>,
  ) => ({
    requestId,
    state,
    message,
    ...(vars ? { vars } : {}),
    retry,
  })
  if (outcome === undefined) return at('refused', 'domain.unconfirmed', true)
  if (!outcome.ok) {
    const { code, message, retryAdvice } = outcome.error
    if (code === 'unknown_effect') return at('unknown', 'domain.unknownOutcome')
    const again = code === 'retryable' || code === 'timeout' || retryAdvice.kind === 'retry_same_action'
    return at('refused', 'domain.refused', again, { message })
  }
  const handle = outcome.value
  switch (handle.status) {
    case 'accepted':
    case 'running':
      return at('pending', 'domain.pending')
    case 'succeeded':
      return at('succeeded', 'domain.done')
    case 'unknown_effect':
      return at('unknown', 'domain.unknownOutcome')
    case 'not-accepted':
      return at('refused', 'domain.notAccepted', true)
    default:
      return handle.status === 'cancelled'
        ? at('failed', 'domain.cancelled')
        : at('failed', 'domain.failed', false, { message: handle.error.message })
  }
}

function ActionControl({
  view,
  action,
  context,
}: {
  view: DomainView
  action: ViewAction
  context: RendererContext
}) {
  const text = (key: DomainMessageKey, vars?: Readonly<Record<string, string | number>>) =>
    domainText(context.locale.locale, key, vars)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  // ponytail: only command actions act here; forms and downloads show their label until the card
  // gets the interaction and artifact flows. A command needing a feature this client did not
  // negotiate is shown, never offered.
  const negotiated = context.capabilities?.features ?? []
  if (
    action.kind !== 'command' ||
    action.availability !== 'enabled' ||
    !action.requiredFeatures.every((feature) => negotiated.includes(feature))
  )
    return (
      <span className="generic-domain-action" data-action-key={action.actionKey}>
        <Button disabled>{action.label}</Button>
        <span>{action.disabledReason ?? text('domain.unavailable')}</span>
      </span>
    )
  const waiting = attempt?.state === 'pending' || attempt?.state === 'unknown'

  const send = async (check: boolean) => {
    const requestId = attempt && (check || attempt.retry) ? attempt.requestId : crypto.randomUUID()
    setAttempt({ requestId, state: 'sending', message: 'domain.sending', retry: false })
    let outcome: Outcome<CommandHandle> | undefined
    try {
      outcome = check
        ? await context.commands.commandStatus(requestId)
        : await context.commands.submit({
            action: { viewId: view.viewId, actionKey: action.actionKey, viewRevision: view.revision },
            commandSchema: action.inputSchema,
            input: emptyInput(action.inputSchema),
            requestId,
            // ponytail: the view carries no domain state revision, so the projection revision it was
            // read at is sent and a moved state comes back as a refusal; the view needs that revision.
            expectedRevision: view.source.projectionRevision,
          })
    } catch {
      outcome = undefined
    }
    setAttempt(settle(requestId, outcome))
  }

  return (
    <span className="generic-domain-action" data-action-key={action.actionKey} data-state={attempt?.state}>
      <Button disabled={attempt?.state === 'sending' || waiting} onClick={() => void send(false)}>
        {attempt?.retry ? text('domain.retry', { label: action.label }) : action.label}
      </Button>
      {waiting ? <Button onClick={() => void send(true)}>{text('domain.checkStatus')}</Button> : null}
      <span role="status">{attempt ? text(attempt.message, attempt.vars) : null}</span>
    </span>
  )
}

export function GenericDomainView({ view, context }: { view: DomainView; context: RendererContext }) {
  const text = (key: DomainMessageKey) => domainText(context.locale.locale, key)
  const tone = PHASE_TONES.get(view.phase)
  const phase: DomainMessageKey = tone ? `domain.phase.${view.phase}` : 'domain.phase.unknown'
  return (
    <article className="generic-domain-view" data-view-id={view.viewId} data-phase={view.phase}>
      <StateLights states={[{ label: text('domain.status'), value: text(phase), tone: tone ?? 'unknown' }]} />
      <p className="generic-domain-text">{view.fallbackText}</p>
      {view.resources.length > 0 ? (
        <ul className="generic-domain-resources" aria-label={text('domain.resources')}>
          {view.resources.map((resource) => (
            <li key={`${resource.artifactId}@${resource.version}`}>
              {resource.title ?? resource.artifactId}
            </li>
          ))}
        </ul>
      ) : null}
      {view.actions.length > 0 ? (
        <div className="generic-domain-actions">
          {view.actions.map((action) => (
            <ActionControl key={action.actionKey} view={view} action={action} context={context} />
          ))}
        </div>
      ) : null}
    </article>
  )
}
