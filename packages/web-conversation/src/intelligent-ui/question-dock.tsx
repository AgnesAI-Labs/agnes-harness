import type { SystemInput, UINode } from '@agnes/protocol'
import type { UiActionReceipt, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import {
  AnsweredBadge,
  draftAnswers,
  type QuestionAnswers,
  QuestionAnswersReceipt,
  QuestionCard,
  questionForm,
  UiLocaleProvider,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useSyncExternalStore } from 'react'
import type { IntelligentUiClient } from './client.js'
import { useIntelligentBinding } from './turn-views.js'

const inFlight = (receipt: UiActionReceipt) =>
  ['received', 'pending-approval', 'executing'].includes(receipt.status) ||
  receipt.failure?.outcomeUnknown === true

/** An open ask_user_question surface is a question card above the composer, never a conversation card. */
export function isQuestionSurface(record: UiSurfaceRecord): boolean {
  return !!questionForm(record.surface)
}

/** The open question cards of the current session, oldest first, docked directly above the composer. */
export function QuestionDock() {
  const { binding, client } = useIntelligentBinding()
  if (!binding || !client) return null
  return (
    <UiLocaleProvider source={binding.locale}>
      <OpenQuestions key={client.sessionId} client={client} />
    </UiLocaleProvider>
  )
}

function OpenQuestions({ client }: { client: IntelligentUiClient }) {
  useSyncExternalStore(client.subscribe, client.getVersion)
  const open = client
    .getSnapshot()
    .surfaces.filter((record) => record.status === 'open' && isQuestionSurface(record))
    .sort((a, b) => a.createdSeq - b.createdSeq)
  return (
    <>
      {open.map((record) => (
        <BoundQuestion
          key={`${record.surface.id}:${record.surface.revision}`}
          client={client}
          record={record}
        />
      ))}
    </>
  )
}

/**
 * How a question card recovers, the same way any surface does: a stale or changed question is read
 * again before it can be answered; a submission whose delivery is unconfirmed is sent again with its
 * own commandId; only a failure the backend marks safe to retry makes a new command; an unknown
 * outcome stays locked.
 */
export function questionRecovery(
  client: Pick<IntelligentUiClient, 'needsReview' | 'pendingCommands' | 'receipts'>,
  id: string,
):
  | { kind: 'review' }
  | { kind: 'resend' }
  | { kind: 'retry'; receipt: UiActionReceipt }
  | { kind: 'unknown' }
  | { kind: 'rejected'; message?: string }
  | undefined {
  const receipts = client.receipts(id)
  if (client.needsReview(id)) return { kind: 'review' }
  if (
    client
      .pendingCommands(id)
      .some((command) => !receipts.some((receipt) => receipt.commandId === command.commandId))
  )
    return { kind: 'resend' }
  const latest = receipts.at(-1)
  if (latest?.failure?.outcomeUnknown) return { kind: 'unknown' }
  if (latest?.status === 'failed' && latest.failure?.retryable) return { kind: 'retry', receipt: latest }
  if (latest?.status === 'failed' || latest?.status === 'rejected')
    return { kind: 'rejected', ...(latest.refusal?.message ? { message: latest.refusal.message } : {}) }
  return undefined
}

function BoundQuestion({ client, record }: { client: IntelligentUiClient; record: UiSurfaceRecord }) {
  const form = questionForm(record.surface)!
  const id = record.surface.id
  const answers = draftAnswers(form, client.draft(id).input[form.componentId])
  const receipts = client.receipts(id)
  const recovery = questionRecovery(client, id)
  const submitting = !recovery && (client.pendingCommands(id).length > 0 || receipts.some(inFlight))
  const recover = () => {
    if (recovery?.kind === 'review') void client.review(id)
    else if (recovery?.kind === 'resend') void client.resend(id)
    else if (recovery?.kind === 'retry') {
      // retry() only stages a command the backend marked safe to repeat; the card is its confirmation.
      client.retry(recovery.receipt)
      if (client.confirmation(id)) void client.confirm(id)
    }
  }
  return (
    <QuestionCard
      surfaceId={id}
      form={form}
      answers={answers}
      locked={client.locked(id)}
      submitting={submitting}
      failed={recovery?.kind === 'rejected'}
      {...(recovery
        ? {
            recovery: {
              kind: recovery.kind,
              ...('message' in recovery && recovery.message ? { message: recovery.message } : {}),
            },
          }
        : {})}
      onRecover={recover}
      onAnswers={(next) => client.setInput(id, form.componentId, next)}
      onSubmit={(complete) => {
        const action = record.surface.actions.find((item) => item.id === form.actionId)
        if (!action) return
        // The same authenticated ui.action → ui_submit path as any form; the card is its confirmation.
        client.setInput(id, form.componentId, complete)
        client.choose(id, action)
        void client.confirm(id)
      }}
    />
  )
}

/** A submitted ask_user_question answer as delivered to the session: the surface and its answers. */
export function questionSubmission(
  node: UINode,
): { surfaceId: string; answers: Readonly<Record<string, unknown>> } | undefined {
  if (node.kind !== 'user' || node.origin !== 'system' || !node.system) return undefined
  const system: SystemInput = node.system
  if (system.source !== 'agnes/intelligent-ui' || system.type !== 'action-result') return undefined
  const data = system.data as Record<string, unknown> | undefined
  const submitted = data?.submitted as Record<string, unknown> | undefined
  if (
    data?.status !== 'succeeded' ||
    !submitted ||
    typeof submitted.surfaceId !== 'string' ||
    !submitted.answers ||
    typeof submitted.answers !== 'object' ||
    Array.isArray(submitted.answers)
  )
    return undefined
  return { surfaceId: submitted.surfaceId, answers: submitted.answers as Record<string, unknown> }
}

type Submission = NonNullable<ReturnType<typeof questionSubmission>>
type AnswerItem = { id: string; label?: string; question?: string; value: string | string[] }

/** Each question's short label → answer, in asking order. A question id is never a label. */
function answerItems(submission: Submission, record: UiSurfaceRecord | undefined): AnswerItem[] {
  const form = record ? questionForm(record.surface) : undefined
  const values = submission.answers as QuestionAnswers
  const asked = form?.questions ?? []
  return [
    ...asked.map((question) => ({
      id: question.id,
      label: question.label,
      question: question.question,
      value: values[question.id],
    })),
    ...Object.keys(values)
      .filter((key) => !asked.some((question) => question.id === key))
      // Without the question, the answer stands alone.
      .map((key) => ({ id: key, value: values[key] })),
  ].flatMap((item) =>
    typeof item.value === 'string' ||
    (Array.isArray(item.value) && item.value.every((value) => typeof value === 'string'))
      ? [{ ...item, value: item.value }]
      : [],
  )
}

/** Labels come from the question surface: listed, remembered after it closed, or read back by id. */
function useQuestionRecords(ids: readonly string[]) {
  const { binding, client } = useIntelligentBinding()
  const records = ids.map((id) => client?.knownRecord(id))
  const missing = ids.filter((id, index) => !records[index] && id.startsWith('card-')).join('\n')
  useEffect(() => {
    if (client && missing) for (const id of missing.split('\n')) void client.lookup(id)
  }, [client, missing])
  return { binding, records }
}

/** «✓ Answered N items» on the answer that asked, with each question's label → answer on hover or focus. */
export function AnsweredQuestions({ answered }: { answered: readonly { submission: Submission }[] }) {
  const { binding, records } = useQuestionRecords(answered.map((item) => item.submission.surfaceId))
  const items = answered.flatMap(({ submission }, index) =>
    answerItems(submission, records[index]).map((item) =>
      answered.length > 1 ? { ...item, id: `${submission.surfaceId}-${item.id}` } : item,
    ),
  )
  if (!items.length) return null
  const badge = <AnsweredBadge items={items} />
  return binding ? <UiLocaleProvider source={binding.locale}>{badge}</UiLocaleProvider> : badge
}

/**
 * «Your answers» where the answer landed, for an answer whose asking turn is not in view. Labels come
 * from the question surface; without it the answers stand alone.
 */
export function QuestionAnswersNode({ submission, native }: { submission: Submission; native: ReactNode }) {
  const { binding, records } = useQuestionRecords([submission.surfaceId])
  const record = records[0]
  if (record ? !questionForm(record.surface) : !submission.surfaceId.startsWith('card-')) return native
  const items = answerItems(submission, record)
  if (!items.length) return native
  const receipt = <QuestionAnswersReceipt items={items} />
  return binding ? <UiLocaleProvider source={binding.locale}>{receipt}</UiLocaleProvider> : receipt
}
