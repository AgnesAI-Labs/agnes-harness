import type { SystemInput, UINode } from '@agnes/protocol'
import type { UiActionReceipt, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import {
  draftAnswers,
  type QuestionAnswers,
  QuestionAnswersReceipt,
  QuestionCard,
  questionForm,
  UiLocaleProvider,
} from '@agnes/web-ui'
import { type ReactNode, useSyncExternalStore } from 'react'
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

/**
 * «你的回答» where the answer landed in the transcript. Labels come from the closed question surface;
 * an interaction surface (`card-…`) that is no longer listed falls back to the question ids.
 */
export function QuestionAnswersNode({
  submission,
  native,
}: {
  submission: NonNullable<ReturnType<typeof questionSubmission>>
  native: ReactNode
}) {
  const { binding, client } = useIntelligentBinding()
  const record = client?.record(submission.surfaceId)
  const form = record ? questionForm(record.surface) : undefined
  if (record ? !form : !submission.surfaceId.startsWith('card-')) return native
  const values = submission.answers as QuestionAnswers
  const known = form?.questions ?? []
  const items = [
    ...known.map((question) => ({
      id: question.id,
      label: question.label,
      question: question.question,
      value: values[question.id],
    })),
    ...Object.keys(values)
      .filter((key) => !known.some((question) => question.id === key))
      .map((key) => ({ id: key, label: key, value: values[key] })),
  ].flatMap((item) =>
    typeof item.value === 'string' ||
    (Array.isArray(item.value) && item.value.every((value) => typeof value === 'string'))
      ? [{ ...item, value: item.value }]
      : [],
  )
  if (!items.length) return native
  const receipt = <QuestionAnswersReceipt items={items} />
  return binding ? <UiLocaleProvider source={binding.locale}>{receipt}</UiLocaleProvider> : receipt
}
