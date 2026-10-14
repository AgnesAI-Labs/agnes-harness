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
import { useIntelligentBinding } from './turn-deliverables.js'

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

function BoundQuestion({ client, record }: { client: IntelligentUiClient; record: UiSurfaceRecord }) {
  const form = questionForm(record.surface)!
  const id = record.surface.id
  const answers = draftAnswers(form, client.draft(id).input[form.componentId])
  const receipts = client.receipts(id)
  const submitting = client.pendingCommands(id).length > 0 || receipts.some(inFlight)
  const latest = receipts.at(-1)
  const failed = !submitting && (latest?.status === 'failed' || latest?.status === 'rejected')
  return (
    <QuestionCard
      surfaceId={id}
      form={form}
      answers={answers}
      locked={client.locked(id)}
      submitting={submitting}
      failed={failed}
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

/** «✓ 已回答 N 项» on the answer that asked, with each question's label → answer on hover or focus. */
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
 * «你的回答» where the answer landed, for an answer whose asking turn is not in view. Labels come
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
