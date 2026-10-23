import type { UINode, UITurn } from '@agnes/protocol'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Disclosure } from '../../ui/disclosure.js'
import { Bubble } from '../../x/index.js'
import { interactionToolPresentation } from '../interaction-result.js'
import { useInteractionSnapshot } from '../markdown-snapshot.js'
import { TurnErrorRow } from '../turn-error-row.js'
import { turnVerificationStatus } from '../turn-status.js'
import { ActivityIcon, ActivityRow, type ActivityState } from './activity-row.js'
import type { AssistantNode, ConversationMessagesProps, ToolNode } from './context.js'
import { markdownState } from './markdown-state.js'
import { isEmptyStreamingAssistant, isSystemInput, Message } from './message.js'
import { ProcessStep } from './process-step.js'
import { Thinking } from './thinking.js'
import { toolOutcome } from './tool-card.js'
import { type ActivityKind, activitySummary, thoughtLine, toolStep } from './tool-step.js'
import { UserMessageActions, userMessageText } from './user-message.js'

export const TURN_STATUS_KEYS: Record<UITurn['status'], string> = {
  running: 'turn.status.running',
  waiting: 'turn.status.waiting',
  completed: 'turn.status.completed',
  failed: 'turn.status.failed',
  cancelled: 'turn.status.cancelled',
}

type Group = { key: string; members: Step[] }
/** A one-line member of an activity group: a tool call, a decided approval or a thought. */
type Step = { key: string; node: UINode; thought: boolean; group: Group }
type Entry =
  | { type: 'group'; group: Group }
  | { type: 'step'; step: Step }
  // Prose and cards stand on their own between groups; `quiet` keeps an empty node mounted unseen.
  | { type: 'narration' | 'final' | 'attention' | 'block'; node: UINode; quiet?: boolean }

function TurnView({
  turn,
  members,
  attentionIds,
  props,
  latest = false,
}: {
  turn: UITurn
  members: readonly UINode[]
  attentionIds: readonly string[]
  props: Omit<ConversationMessagesProps, 'nodes' | 'turns' | 'visibleNodeIds'>
  /** The newest turn keeps its action bar in view; earlier ones show it on hover or focus. */
  latest?: boolean
}) {
  const preference = useRef<boolean | undefined>(undefined)
  const wasActive = useRef<boolean | undefined>(undefined)
  const active = !turn.endedAt && (turn.status === 'running' || turn.status === 'waiting')
  const processActive = turn.status === 'running' || turn.status === 'waiting'
  const response = useRef<HTMLDivElement>(null)
  const shownProcessActive = useInteractionSnapshot(response, processActive)
  // Workflow Loops may finish with process records and no final assistant answer. Keep
  // that content reachable on history open and when the live turn settles.
  const hasAnswer = members.some(
    (node) =>
      node.id === turn.finalAssistantId &&
      node.kind === 'assistant' &&
      node.text.trim() &&
      !props.processStep?.(node),
  )
  const defaultProcessOpen = processActive || (turn.status === 'completed' && !hasAnswer)
  const [processOpen, setProcessOpen] = useState(defaultProcessOpen)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const clock = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNow(Date.now())
    }, 1000)
    return () => clearInterval(clock)
  }, [active])
  useLayoutEffect(() => {
    if (wasActive.current && !shownProcessActive) preference.current = undefined
    wasActive.current = shownProcessActive
    setProcessOpen(preference.current ?? (shownProcessActive || (turn.status === 'completed' && !hasAnswer)))
  }, [shownProcessActive, hasAnswer, turn.status])

  const t = props.t
  const users = members.filter((node) => node.kind === 'user')
  const argumentFailures = members.filter(
    (node): node is ToolNode => node.kind === 'tool' && !!node.argumentRecovery,
  )
  const unboundFailures = turn.argumentRecovery ?? []
  const recoveryFacts = [
    ...argumentFailures.flatMap((node) => (node.argumentRecovery ? [node.argumentRecovery] : [])),
    ...unboundFailures,
  ]
  const others = members.filter(
    (node) =>
      node.kind !== 'user' && node.kind !== 'cost' && !(node.kind === 'tool' && node.argumentRecovery),
  )
  const attention = (node: UINode) =>
    (node.kind === 'approval' && node.state === 'pending') || attentionIds.includes(node.id)
  const pendingApproval = others.findLast(
    (node): node is Extract<UINode, { kind: 'approval' }> =>
      node.kind === 'approval' && node.state === 'pending',
  )
  const awaitingToolApproval = others.some(
    (node) => node.kind === 'tool' && node.status === 'awaiting_approval',
  )
  const runningTool = others.some((node) => node.kind === 'tool' && node.status === 'running')
  const latestStreaming = others
    .filter((node): node is AssistantNode => node.kind === 'assistant' && node.streaming === true)
    .sort((a, b) => b.seq - a.seq)[0]
  const verificationStatus = turnVerificationStatus(turn)
  const verification = verificationStatus?.verification
  let status = t(verificationStatus?.labelKey ?? TURN_STATUS_KEYS[turn.status])
  if (processActive) {
    if (pendingApproval || awaitingToolApproval) status = t('turn.status.awaitingApproval')
    else if (turn.status === 'waiting') status = t(TURN_STATUS_KEYS.waiting)
    else if (runningTool) status = t('turn.status.runningTool')
    else if (latestStreaming?.text.trim()) status = t('turn.status.replying')
    else if (latestStreaming?.thinking?.trim()) status = t('turn.status.thinking')
    else status = t('turn.status.preparing')
  }
  const startedAt = Date.parse(turn.startedAt)
  const duration =
    active && Number.isFinite(startedAt)
      ? t('turn.duration.s', { n: Math.floor(Math.max(0, now - startedAt) / 1000) })
      : turn.durationMs === undefined
        ? undefined
        : turn.durationMs < 1000
          ? t('turn.duration.ms', { n: turn.durationMs })
          : turn.durationMs < 60_000
            ? t('turn.duration.s', {
                n: (turn.durationMs / 1000).toFixed(turn.durationMs < 10_000 ? 1 : 0),
              })
            : t('turn.duration.minSec', {
                min: Math.floor(turn.durationMs / 60_000),
                sec: Math.round((turn.durationMs % 60_000) / 1000),
              })
  // While it runs the header counts up; once it ends it says how long the whole turn took.
  const statusText = duration
    ? `${status}${t(active ? 'turn.runningSuffix' : 'turn.elapsedSuffix', { duration })}`
    : status
  // A failed turn always states what happened; the process summary then stops repeating it.
  const failed = turn.status === 'failed' && !verification
  const { onRetry, ...errorActions } = props.turnErrorActions ?? {}
  const retryActions = latest && onRetry ? { ...errorActions, onRetry } : errorActions
  const processStatusText =
    failed && duration
      ? `${t('turn.error.processLabel')}${t('turn.elapsedSuffix', { duration })}`
      : failed
        ? t('turn.error.processLabel')
        : statusText
  // A thought a reader is selecting or focused in stays a step until they let go, even when a
  // terminal replacement drops that part of the node.
  const thoughtIds = others
    .flatMap((node) => (node.kind === 'assistant' && node.thinking?.trim() ? [node.id] : []))
    .join('\n')
  const shownThoughts = new Set(useInteractionSnapshot(response, thoughtIds).split('\n'))
  const stepOf = (node: UINode) =>
    node.kind === 'assistant' && !node.streaming ? props.processStep?.(node) : undefined
  const finalNode = members.find((node) => node.id === turn.finalAssistantId)
  // A step record is not an answer: there is nothing of it to copy as the reply.
  const finalText = finalNode?.kind === 'assistant' && !stepOf(finalNode) ? finalNode.text : ''

  // The process is one flat list in the order things happened: prose stands alone, consecutive
  // steps share a group row. Flat, so a node never changes parent as the turn moves on.
  const flow: Entry[] = []
  let group: Group | undefined
  const addStep = (node: UINode, thought: boolean) => {
    if (!group) {
      group = { key: `group:${thought ? 'think:' : ''}${node.id}`, members: [] }
      flow.push({ type: 'group', group })
    }
    const step: Step = { key: thought ? `think:${node.id}` : node.id, node, thought, group }
    group.members.push(step)
    flow.push({ type: 'step', step })
  }
  const ordered = [...others].sort(
    (a, b) => Number(a.id === turn.finalAssistantId) - Number(b.id === turn.finalAssistantId),
  )
  for (const node of ordered) {
    // The decision line points to the primary card; its waiting tool is the same pending action.
    if (processActive && node.kind === 'tool' && node.toolUseId === pendingApproval?.toolUseId) continue
    if (stepOf(node)) addStep(node, false)
    else if (node.kind === 'assistant') {
      if (node.thinking?.trim() || shownThoughts.has(node.id)) addStep(node, true)
      const final = node.id === turn.finalAssistantId
      const written = Boolean(node.text.trim()) || node.lostChars !== undefined
      if (final || written) group = undefined
      flow.push({ type: final ? 'final' : 'narration', node, quiet: !final && !written })
    } else if (attention(node)) {
      group = undefined
      flow.push({ type: 'attention', node })
    } else if (node.kind === 'tool' || node.kind === 'approval') addStep(node, false)
    else {
      group = undefined
      flow.push({ type: 'block', node })
    }
  }
  const processCount = flow.filter(
    (entry) =>
      entry.type === 'step' || entry.type === 'block' || (entry.type === 'narration' && !entry.quiet),
  ).length
  const hasProcess = processCount > 0
  const settled = !processActive && Boolean(turn.finalAssistantId)
  const thinkingNow = (node: AssistantNode) =>
    markdownState(node, turn.status).streaming && node.text.trim() === ''

  const stepKind = (step: Step): ActivityKind =>
    step.thought
      ? 'thinking'
      : step.node.kind === 'tool'
        ? toolStep(step.node, t, interactionToolPresentation(step.node, t)).kind
        : step.node.kind === 'assistant'
          ? 'step'
          : 'approval'
  const groupRow = (current: Group) => {
    const open = openGroups.has(current.key)
    const tools = current.members.flatMap((step) =>
      !step.thought && step.node.kind === 'tool' ? [step.node] : [],
    )
    const failed = tools.filter((node: ToolNode) => node.status === 'failed')
    const running = current.members.findLast((step) =>
      step.thought
        ? step.node.kind === 'assistant' && thinkingNow(step.node)
        : step.node.kind === 'tool' && step.node.status === 'running',
    )
    let state: ActivityState
    let verb = activitySummary(current.members.map(stepKind), t)
    let target = ''
    let note: string | undefined
    if (running && processActive) {
      // A group at work shows the step it is on instead of a tally that would keep changing.
      state = 'running'
      if (running.thought && running.node.kind === 'assistant') {
        verb = t('activity.verb.thinking')
        target = thoughtLine(running.node.thinking ?? '', true)
      } else if (running.node.kind === 'tool') {
        const step = toolStep(running.node, t, interactionToolPresentation(running.node, t))
        verb = step.verb
        target = step.target
      }
    } else if (failed.length > 0) {
      state = 'failed'
      const [only] = failed
      note =
        failed.length === 1 && only
          ? toolOutcome(only, t).label
          : t('activity.failed.many', { n: failed.length })
    } else if (tools.some((node) => node.status === 'awaiting_approval')) state = 'attention'
    return (
      <ActivityRow
        className="turn-activity-toggle"
        testId="turn-activity-toggle"
        icon={<ActivityIcon name="chevron" />}
        verb={verb}
        target={target}
        tooltip={target || undefined}
        state={state}
        note={note}
        expanded={open}
        onToggle={() =>
          setOpenGroups((current_) => {
            const next = new Set(current_)
            if (!next.delete(current.key)) next.add(current.key)
            return next
          })
        }
      />
    )
  }
  const stepResult = (node: UINode) => {
    const result = stepOf(node)
    return result ? (
      <article className="timeline-node process-step" data-node-id={node.id} data-node-kind="process-step">
        <ProcessStep nodeId={node.id} step={result} props={props} />
      </article>
    ) : null
  }
  const process = (
    <>
      <p
        className="turn-status"
        data-agnes-dynamic="turn-process"
        data-active={processActive ? 'true' : undefined}
        // A finished turn with nothing to unfold says how long it took in its action bar only.
        // A failed turn keeps its status line: it is the one place that says the run failed.
        hidden={turn.status === 'completed' || (hasProcess && !failed)}
      >
        {statusText}
      </p>
      {failed && <TurnErrorRow turn={turn} t={t} actions={retryActions} />}
      <Disclosure
        className="turn-process"
        open={processOpen}
        hidden={!hasProcess}
        data-active={processActive ? 'true' : undefined}
        onOpenChange={(open) => {
          preference.current = open
          setProcessOpen(open)
        }}
        summaryProps={{ 'data-testid': 'turn-process-toggle' }}
        summary={
          <span className="process-row">
            <span className="process-label" data-agnes-dynamic="turn-process" data-testid="turn-timing">
              {processStatusText}
            </span>
            <svg className="icon process-chevron" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        }
      />
      {verification && (
        <Disclosure
          variant="plain"
          className="turn-recovery"
          data-testid="turn-verification"
          summary={t(`turn.verification.${verification}`)}
        >
          <p>{t(`turn.verification.${verification}.detail`)}</p>
        </Disclosure>
      )}
      {recoveryFacts.length > 0 && (
        <Disclosure
          className="turn-recovery"
          data-testid="tool-argument-recovery"
          summary={t(
            recoveryFacts.some((fact) => fact.disabled)
              ? recoveryFacts.every((fact) => fact.presentational)
                ? 'turn.recovery.visual'
                : 'turn.recovery.tool'
              : processActive
                ? 'turn.recovery.retrying'
                : 'turn.recovery.continued',
          )}
        >
          {unboundFailures.map((fact) => (
            <div key={fact.seq}>
              <p>{fact.name}</p>
              <pre>{fact.hint}</pre>
            </div>
          ))}
          {argumentFailures.map((node) => (
            <div key={node.id}>
              <p>{node.name}</p>
              <Message node={node} props={props} turnStatus={turn.status} />
            </div>
          ))}
        </Disclosure>
      )}
      <div className="turn-node-flow">
        {flow.map((entry) => {
          if (entry.type === 'group')
            return (
              <div
                key={entry.group.key}
                className="turn-activity"
                data-open={openGroups.has(entry.group.key) ? 'true' : undefined}
                // One step needs no summary: its own line already says everything.
                hidden={!processOpen || entry.group.members.length < 2}
              >
                {entry.group.members.length >= 2 && groupRow(entry.group)}
              </div>
            )
          if (entry.type === 'step') {
            const { step } = entry
            const grouped = step.group.members.length >= 2
            const shown = processOpen && (!grouped || openGroups.has(step.group.key))
            const rail = grouped ? 'true' : undefined
            if (step.thought && step.node.kind === 'assistant') {
              const node = step.node
              const state = markdownState(node, turn.status)
              return (
                <div
                  key={step.key}
                  className="turn-process-body turn-step"
                  data-grouped={rail}
                  hidden={!shown}
                >
                  <Thinking
                    active={thinkingNow(node)}
                    label={t('activity.verb.thinking')}
                    line={thoughtLine(node.thinking ?? '', thinkingNow(node))}
                    autoOpen={false}
                  >
                    {props.renderMarkdown
                      ? props.renderMarkdown(node.thinking ?? '', 'thinking', state)
                      : node.thinking}
                  </Thinking>
                </div>
              )
            }
            return (
              <div key={step.key} className="turn-process-body turn-step" data-grouped={rail} hidden={!shown}>
                {stepResult(step.node) ?? <Message node={step.node} props={props} turnStatus={turn.status} />}
              </div>
            )
          }
          const { node } = entry
          const always =
            entry.type === 'final' ||
            entry.type === 'attention' ||
            (verification === 'blocked' && entry.type === 'narration')
          return (
            <div
              key={node.id}
              className={
                entry.type === 'final'
                  ? 'turn-final'
                  : entry.type === 'attention'
                    ? 'turn-attention'
                    : `turn-process-body turn-${entry.type}`
              }
              hidden={isEmptyStreamingAssistant(node) || entry.quiet || (!always && !processOpen)}
            >
              <Message node={node} props={props} hideThinking turnStatus={turn.status} />
            </div>
          )
        })}
      </div>
    </>
  )
  return (
    <section
      className="conversation-turn"
      data-testid="conversation-turn"
      data-turn-id={turn.id}
      data-status={turn.status}
      data-verification={verification}
      data-inherited={String(turn.inherited)}
      data-latest={latest ? 'true' : undefined}
    >
      <div className="turn-user">
        {users.map((node) =>
          // A system input is a status line of the turn, not something the reader said.
          isSystemInput(node) ? (
            <Message key={node.id} node={node} props={props} />
          ) : (
            <Bubble
              key={node.id}
              rootClassName="agh-bubble agh-bubble-user"
              placement="end"
              variant="filled"
              content={<Message node={node} props={props} />}
              footer={
                node.kind === 'user' ? <UserMessageActions text={userMessageText(node)} t={t} /> : undefined
              }
            />
          ),
        )}
      </div>
      <div ref={response} className="turn-response">
        <Bubble
          rootClassName="agh-bubble agh-bubble-assistant"
          placement="start"
          variant="borderless"
          header={
            <span className="process-identity">
              <span className="process-avatar">
                <span className="agnes-mark process-avatar-mark" aria-hidden="true" />
              </span>
              <span className="process-name">{props.t('brand.harness')}</span>
              {props.renderTurnAttribution?.(turn)}
            </span>
          }
          content={
            <>
              {process}
              {props.renderTurnDeliverables?.(turn)}
            </>
          }
          footer={props.renderTurnActions?.(turn, finalText, settled)}
        />
      </div>
    </section>
  )
}

export const Turn = memo(
  TurnView,
  (before, after) =>
    before.turn === after.turn &&
    before.latest === after.latest &&
    before.props === after.props &&
    before.attentionIds.length === after.attentionIds.length &&
    before.attentionIds.every((id, i) => id === after.attentionIds[i]) &&
    before.members.length === after.members.length &&
    before.members.every((node, i) => node === after.members[i]),
)
