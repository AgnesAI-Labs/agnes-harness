import { answerPrefix, parseAnswer, type UINode } from '@agnes/protocol'
import type { ToolCardInlinePayload } from '@agnes/protocol/gen/slots'
import type { ClientResourceService, SessionService } from '@agnes/web-client'
import { Button } from '@agnes/web-ui'
import { useEffect, useState } from 'react'

type Question = NonNullable<ToolCardInlinePayload['question']>
type Deliverable = NonNullable<ToolCardInlinePayload['deliverables']>[number]

function QuestionCard({
  question,
  session,
  answered,
}: {
  question: Question
  session?: SessionService | undefined
  answered: boolean
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
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const update = (id: string, value: string | string[]) =>
    setAnswers((previous) => ({ ...previous, [id]: value }))
  return (
    <form
      aria-label="Answer questions"
      onSubmit={(event) => {
        event.preventDefault()
        if (!session || sending || answered) return
        if (!valid) {
          setError('Choose an answer for every question.')
          return
        }
        setSending(true)
        setError(undefined)
        void session.commands
          .prompt([{ type: 'text', text: encoded }])
          .catch(() => setError('Answer could not be submitted. Try again.'))
          .finally(() => setSending(false))
      }}
    >
      {question.questions.map((q) => (
        <fieldset key={q.id} disabled={answered || sending}>
          <legend>{q.question}</legend>
          {q.options?.map((option) => (
            <label key={option}>
              <input
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
              Free text
              <textarea
                aria-label={`${q.question}: free text`}
                maxLength={8192}
                value={freeText[q.id] ?? ''}
                onChange={(e) => setFreeText((previous) => ({ ...previous, [q.id]: e.target.value }))}
              />
            </label>
          )}
        </fieldset>
      ))}
      <Button htmlType="submit" disabled={!session || answered || sending || !valid}>
        {answered ? 'Answered' : sending ? 'Submitting…' : 'Submit answer'}
      </Button>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

function DeliverableCard({
  file,
  resources,
}: {
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
          if (active) setError('File is unavailable')
        })
    return () => {
      active = false
      loaded?.release()
    }
  }, [resources, lane, sha256, size, mime])
  return (
    <article aria-label={`Deliverable: ${file.name}`}>
      <strong>{file.name}</strong>
      {file.description && <p>{file.description}</p>}
      {resource ? (
        <p>
          <a href={resource.url} target="_blank" rel="noopener noreferrer">
            Open
          </a>
          {' · '}
          <a href={resource.url} download={file.name}>
            Download
          </a>
        </p>
      ) : (
        <p role={error ? 'alert' : 'status'}>{error ?? 'Loading file…'}</p>
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
}: {
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
        if (payload.question)
          return (
            <QuestionCard
              key={`question:${payload.question.id}`}
              question={payload.question}
              {...(session ? { session } : {})}
              answered={answered.has(payload.question.id)}
            />
          )
        if (payload.deliverables)
          return payload.deliverables.map((file) => (
            <DeliverableCard
              key={`${fill.extId}:${file.ref.sha256}:${file.name}`}
              file={file}
              {...(resources ? { resources } : {})}
            />
          ))
        return null
      })}
    </>
  )
}
