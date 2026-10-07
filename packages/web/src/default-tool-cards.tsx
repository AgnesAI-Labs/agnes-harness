import { answerPrefix, parseAnswer, type UINode } from '@agnes/protocol'
import type { ToolCardInlinePayload } from '@agnes/protocol/gen/slots'
import type { ClientResourceService, SessionService } from '@agnes/web-client'
import { Button } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
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
  running,
  t,
}: {
  t: Text
  question: Question
  session?: SessionService | undefined
  answered: boolean
  running: boolean
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
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
    <form
      className="conversation-native-card question-card"
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
            <label key={option}>
              <input
                data-testid="question-option"
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
            <label>
              {t('cards.question.freeText')}
              <textarea
                data-testid="question-free-text"
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
    </form>
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
    <article
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
    </article>
  )
}

/** Native cards use the same public inline payload as installed client modules. */
export function DefaultToolCards({
  node,
  session,
  resources,
  answered,
  t = english,
}: {
  t?: Text
  node: Extract<UINode, { kind: 'tool' }>
  session?: SessionService | undefined
  resources?: ClientResourceService | undefined
  answered: ReadonlySet<string>
}) {
  return (
    <>
      {node.slots?.map((fill) => {
        if (fill.slot !== 'tool.card.inline') return null
        const payload = fill.payload as ToolCardInlinePayload
        if (fill.extId === 'agnes/workflow' && payload.table)
          return <WorkflowRunCard key={fill.extId} payload={payload} t={t} />
        if (payload.question)
          return (
            <QuestionCard
              key={`question:${payload.question.id}`}
              question={payload.question}
              t={t}
              {...(session ? { session } : {})}
              answered={answered.has(payload.question.id)}
              running={node.status === 'running'}
            />
          )
        if (payload.deliverables)
          return payload.deliverables.map((file) => (
            <DeliverableCard
              key={`${fill.extId}:${file.ref.sha256}:${file.name}`}
              file={file}
              t={t}
              {...(resources ? { resources } : {})}
            />
          ))
        return null
      })}
    </>
  )
}
