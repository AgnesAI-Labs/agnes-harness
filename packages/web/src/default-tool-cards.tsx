import { answerPrefix, parseAnswer, type UINode } from '@agnes/protocol'
import type { ToolCardInlinePayload } from '@agnes/protocol/gen/slots'
import { type ClientResourceService, conversationCards, type SessionService } from '@agnes/web-client'
import { Button, ConversationCardLayout, SettingsInput, SettingsTextArea } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { RegisteredConversationCard } from './conversation-registry.js'
import { toolCardsLocaleCatalog } from './locales/tool-cards.js'
import { WorkflowRunCard } from './workflow-run-card.js'

type Text = (key: string) => string
const englishDictionary: Record<string, string> = toolCardsLocaleCatalog.en
const english: Text = (key) => englishDictionary[key] ?? key

type Question = NonNullable<ToolCardInlinePayload['question']>
type Deliverable = NonNullable<ToolCardInlinePayload['deliverables']>[number]

function QuestionCard({
  question,
  session,
  answered,
  answerValues,
  running,
  t,
}: {
  t: Text
  question: Question
  session?: SessionService | undefined
  answered: boolean
  answerValues?: Record<string, string | string[]> | undefined
  running: boolean
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(answerValues ?? {})
  useEffect(() => {
    if (answerValues) setAnswers(answerValues)
  }, [answerValues])
  const [freeText, setFreeText] = useState<Record<string, string>>({})
  const values = { ...answers }
  for (const q of question.questions) {
    const text = freeText[q.id]?.trim()
    if (text)
      values[q.id] = q.multiple
        ? [...(Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : []), text]
        : text
  }
  const encoded = answerPrefix(question.id) + JSON.stringify(values)
  const valid = !!parseAnswer(question.id, question.questions, encoded)
  const [submitted, setSubmitted] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const update = (id: string, value: string | string[]) =>
    setAnswers((previous) => ({ ...previous, [id]: value }))
  return (
    <ConversationCardLayout
      as="form"
      className="question-card"
      data-testid="question-card"
      data-question-id={question.id}
      aria-label={t('cards.question.title')}
      onSubmit={(event) => {
        event.preventDefault()
        if (!session || sending || answered || submitted) return
        if (!valid) {
          setError('cards.question.invalid')
          return
        }
        setSending(true)
        setError(undefined)
        const send = async () => {
          const projection = await session.projection?.read()
          const value =
            projection && typeof projection === 'object' && 'value' in projection
              ? projection.value
              : undefined
          const busy =
            value && typeof value === 'object' && 'opState' in value ? value.opState != null : running
          if (busy) await session.commands.followUp([{ type: 'text', text: encoded }])
          else await session.commands.prompt([{ type: 'text', text: encoded }])
          setSubmitted(true)
        }
        void send()
          .catch(() => setError('cards.question.failed'))
          .finally(() => setSending(false))
      }}
    >
      {!answered && <p data-testid="question-timing">{t('cards.question.timing')}</p>}
      {question.questions.map((q) => (
        <fieldset
          key={q.id}
          data-testid="question-field"
          data-question-id={q.id}
          disabled={answered || submitted || sending}
        >
          <legend>{q.question}</legend>
          {q.options?.map((option) => (
            <label key={option} htmlFor={`question-${question.id}-${q.id}-${encodeURIComponent(option)}`}>
              <SettingsInput
                data-testid="question-option"
                id={`question-${question.id}-${q.id}-${encodeURIComponent(option)}`}
                type={q.multiple ? 'checkbox' : 'radio'}
                name={q.id}
                value={option}
                checked={
                  q.multiple
                    ? Array.isArray(answers[q.id]) && (answers[q.id] as string[]).includes(option)
                    : answers[q.id] === option
                }
                onChange={(event) => {
                  if (!q.multiple) {
                    update(q.id, option)
                    setFreeText((previous) => ({ ...previous, [q.id]: '' }))
                  } else {
                    const current = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : []
                    update(
                      q.id,
                      event.target.checked ? [...current, option] : current.filter((v) => v !== option),
                    )
                  }
                }}
              />
              {option}
            </label>
          ))}
          {(!q.options || q.allowFreeText) && (
            <label htmlFor={`question-free-${question.id}-${q.id}`}>
              {t('cards.question.freeText')}
              <SettingsTextArea
                data-testid="question-free-text"
                id={`question-free-${question.id}-${q.id}`}
                aria-label={`${q.question}: ${t('cards.question.freeText')}`}
                maxLength={8192}
                value={freeText[q.id] ?? ''}
                onChange={(e) => setFreeText((previous) => ({ ...previous, [q.id]: e.target.value }))}
              />
            </label>
          )}
        </fieldset>
      ))}
      <Button
        data-testid="question-submit"
        htmlType="submit"
        disabled={!session || answered || submitted || sending || !valid}
      >
        {t(
          answered || submitted
            ? 'cards.question.answered'
            : sending
              ? 'cards.question.submitting'
              : 'cards.question.submit',
        )}
      </Button>
      {error && <p role="alert">{t(error)}</p>}
    </ConversationCardLayout>
  )
}

function DeliverableCard({
  file,
  resources,
  t,
}: {
  t: Text
  file: Deliverable
  resources?: ClientResourceService | undefined
}) {
  const { sha256, size, mime } = file.ref
  const lane = file.lane
  const [resource, setResource] = useState<{ url: string; release(): void }>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    let loaded: { url: string; release(): void } | undefined
    setResource(undefined)
    setError(undefined)
    if (resources)
      void resources.files
        .load({
          laneId: lane,
          artifact: { sha256, size, mime: mime ?? 'application/octet-stream' },
        })
        .then((r) => {
          loaded = r
          if (active) setResource(r)
          else r.release()
        })
        .catch(() => {
          if (active) setError('cards.file.unavailable')
        })
    return () => {
      active = false
      loaded?.release()
    }
  }, [resources, lane, sha256, size, mime])
  return (
    <ConversationCardLayout
      className="conversation-native-card deliverable-card"
      data-testid="deliverable-card"
      data-artifact-sha256={sha256}
      aria-label={`${t('cards.file.title')}: ${file.name}`}
    >
      <strong>{file.name}</strong>
      {file.description && <p>{file.description}</p>}
      {resource ? (
        <p>
          <a data-testid="deliverable-open" href={resource.url} target="_blank" rel="noopener noreferrer">
            {t('cards.file.open')}
          </a>
          {' · '}
          <a data-testid="deliverable-download" href={resource.url} download={file.name}>
            {t('cards.file.download')}
          </a>
        </p>
      ) : (
        <p role={error ? 'alert' : 'status'}>{t(error ?? 'cards.file.loading')}</p>
      )}
    </ConversationCardLayout>
  )
}

type InlineCardData = {
  payload: ToolCardInlinePayload
  extId: string
  node: Extract<UINode, { kind: 'tool' }>
  answered: ReadonlySet<string>
  answerValues?: ReadonlyMap<string, Record<string, string | string[]>> | undefined
}
const dataOf = (data: unknown) => data as InlineCardData
for (const entry of [
  {
    id: 'workflow',
    order: 0,
    matches: (data: InlineCardData) => data.extId === 'agnes/workflow' && !!data.payload.table,
    render: (data: InlineCardData, context: import('@agnes/web-client').UiExtensionContext) => (
      <WorkflowRunCard payload={data.payload} t={context.t} />
    ),
  },
  {
    id: 'question',
    order: 10,
    matches: (data: InlineCardData) => !!data.payload.question,
    render: (data: InlineCardData, context: import('@agnes/web-client').UiExtensionContext) =>
      data.payload.question && (
        <QuestionCard
          question={data.payload.question}
          t={context.t}
          session={context.session}
          answered={data.answered.has(data.payload.question.id)}
          answerValues={data.answerValues?.get(data.payload.question.id)}
          running={data.node.status === 'running'}
        />
      ),
  },
  {
    id: 'deliverable',
    order: 20,
    matches: (data: InlineCardData) => !!data.payload.deliverables?.length,
    render: (data: InlineCardData, context: import('@agnes/web-client').UiExtensionContext) =>
      data.payload.deliverables?.map((file) => (
        <DeliverableCard
          key={`${file.ref.sha256}:${file.name}`}
          file={file}
          t={context.t}
          resources={context.resources}
        />
      )),
  },
  {
    id: 'schedule',
    order: 30,
    matches: (data: InlineCardData) => !!data.payload.table,
    render: (data: InlineCardData, context: import('@agnes/web-client').UiExtensionContext) => {
      const payload = data.payload
      if (!payload.table) return null
      return (
        <ConversationCardLayout
          className="conversation-native-card"
          data-testid="reminder-card"
          aria-label={payload.title}
        >
          <strong>{payload.title}</strong>
          <table>
            <thead>
              <tr>
                {payload.table.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.table.rows.map((row) => (
                <tr key={row.join('\u001f')}>
                  {row.map((cell) => (
                    <td key={cell}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ConversationCardLayout>
      )
    },
  },
]) {
  if (!conversationCards.get(entry.id))
    conversationCards.register({
      id: entry.id,
      order: entry.order,
      matches: (card) => card.kind === 'tool-inline' && entry.matches(dataOf(card.data)),
      component: ({ card, context }) => <>{entry.render(dataOf(card.data), context)}</>,
    })
}

/** Native and installed cards resolve through the same registry, without altering protocol data. */
export function DefaultToolCards({
  node,
  session,
  resources,
  answered,
  answerValues,
  t = english,
}: {
  t?: Text
  node: Extract<UINode, { kind: 'tool' }>
  session?: SessionService | undefined
  resources?: ClientResourceService | undefined
  answered: ReadonlySet<string>
  answerValues?: ReadonlyMap<string, Record<string, string | string[]>> | undefined
}) {
  return (
    <>
      {node.slots?.map((fill) =>
        fill.slot === 'tool.card.inline' ? (
          <RegisteredConversationCard
            key={`${fill.extId}:${(fill.payload as ToolCardInlinePayload).question?.id ?? (fill.payload as ToolCardInlinePayload).deliverables?.map((file) => file.ref.sha256).join(',') ?? (fill.payload as ToolCardInlinePayload).title ?? 'inline'}`}
            card={{
              kind: 'tool-inline',
              data: { node, payload: fill.payload, extId: fill.extId, answered, answerValues },
            }}
            context={{ t, session, resources }}
          />
        ) : null,
      )}
    </>
  )
}
