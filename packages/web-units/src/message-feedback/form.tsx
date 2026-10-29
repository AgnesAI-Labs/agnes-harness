import type { FeedbackItem, FeedbackTarget } from '@agnes/protocol/gen/app-server'
import { Button, Popover, reportSuccess, SettingsCheckbox, SettingsTextArea } from '@agnes/web-ui'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import {
  FeedbackRequestError,
  feedbackRequest,
  invalidateSessionFeedback,
  loadSessionFeedback,
  subscribeSessionFeedback,
} from './api.js'
import { feedbackReasons, useFeedbackText } from './feedback-locale.js'

type Rating = FeedbackItem['rating']
type Category = FeedbackItem['category']
type Draft = { category: Category; note: string }
/** What the row says at its right: a draft in progress, its result, or a failure to retry. */
type Phase = '' | 'drafting' | 'drafted' | 'saveFailed' | 'draftFailed' | 'needsLocalModel' | 'loadFailed'

/** The server drafts from a thumbs-down, or from a thumbs-up marked «do this again». */
const draftable = (rating: Rating, category: Category) => rating === 'down' || category === 'do-again'

const POPOVER_CLASS = 'agnes-feedback-popover'
const NO_MOTION = { motionName: '' }
/** Flip above when there is no room below, and slide sideways to stay inside a narrow window. */
const OVERFLOW = { adjustX: 1, adjustY: 1, shiftX: true, shiftY: true } as unknown as {
  adjustX: 1
  adjustY: 1
}

/**
 * One click records the rating and opens a small popover for an optional reason and note; closing
 * it (Done, Escape or a click elsewhere) saves them. Clicking the pressed rating again withdraws it.
 */
export function MessageFeedback({
  sessionId,
  target,
  openEvidence,
  openReview,
}: {
  sessionId: string
  target: FeedbackTarget
  openEvidence(candidateId: string): void
  /** Opens Plugins → Pending review, where a drafted suggestion waits for review. */
  openReview?(): void
}) {
  const { t } = useFeedbackText()
  const [item, setItem] = useState<FeedbackItem>()
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(0)
  const [open, setOpen] = useState<Rating>()
  const [draft, setDraft] = useState<Draft>({ category: '', note: '' })
  const [generate, setGenerate] = useState(false)
  const [phase, setPhase] = useState<Phase>('')
  /** The rating a click asked for (null: withdrawn), shown until the server answers. */
  const [intent, setIntent] = useState<{ rating: Rating | null; token: number }>()
  const intentToken = useRef(0)
  const current = useRef<FeedbackItem | undefined>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const retry = useRef<(() => void) | undefined>(undefined)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const fieldset = useRef<HTMLFieldSetElement>(null)
  const triggers = useRef<Partial<Record<Rating, HTMLButtonElement | null>>>({})
  const popoverId = useId()
  const { messageSeq, turn } = target
  const active = item && !item.withdrawn ? item : undefined
  const pressed = intent ? intent.rating : active?.rating

  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    current.current = undefined
    setItem(undefined)
    setLoading(true)
    setOpen(undefined)
    setPhase('')
    const load = () =>
      loadSessionFeedback(sessionId)
        .then((result) => {
          if (abort.signal.aborted) return
          const found = result.items.find(
            (value) => value.target.messageSeq === messageSeq && value.target.turn === turn,
          )
          current.current = found
          setItem(found)
          setPhase((value) => (value === 'loadFailed' ? '' : value))
        })
        .catch(() => {
          if (abort.signal.aborted) return
          retry.current = () => invalidateSessionFeedback(sessionId)
          setPhase('loadFailed')
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false)
        })
    const off = subscribeSessionFeedback(sessionId, () => void load())
    void load()
    return () => {
      abort.abort()
      off()
    }
  }, [sessionId, messageSeq, turn])

  /** Requests run one after another so each carries the revision the previous one produced. */
  function enqueue(run: (signal: AbortSignal | undefined) => Promise<void>): Promise<void> {
    const signal = lifetime.current?.signal
    setPending((count) => count + 1)
    const next = queue.current.then(() => (signal?.aborted ? undefined : run(signal)))
    queue.current = next.catch(() => {})
    return next.finally(() => {
      if (!signal?.aborted) setPending((count) => count - 1)
    })
  }

  async function request(
    signal: AbortSignal | undefined,
    action: 'put' | 'withdraw' | 'generate',
    fields?: { rating: Rating } & Draft,
  ) {
    const before = current.current
    const result = await feedbackRequest(
      {
        action,
        sessionId,
        target,
        ...(before ? { id: before.id } : {}),
        expectedRevision: before?.revision ?? null,
        ...(fields ?? {}),
      },
      signal,
    )
    if (signal?.aborted) return
    const found = result.items.find(
      (value) => value.target.messageSeq === messageSeq && value.target.turn === turn,
    )
    current.current = found
    setItem(found)
  }

  function save(fields: { rating: Rating } & Draft): Promise<void> {
    const attempt = () =>
      enqueue(async (signal) => {
        try {
          await request(signal, 'put', fields)
          if (signal?.aborted) return
          reportSuccess('message-feedback', t('saved'))
          setPhase('')
        } catch (error) {
          if (signal?.aborted) return
          retry.current = () => void attempt()
          setPhase('saveFailed')
          throw error
        }
      })
    return attempt()
  }

  function draftSuggestion() {
    const attempt = () =>
      enqueue(async (signal) => {
        setPhase('drafting')
        try {
          await request(signal, 'generate')
          setPhase('drafted')
        } catch (error) {
          if (signal?.aborted) return
          retry.current = attempt
          // Drafting runs on a local model; without one a retry cannot help, so none is offered.
          const local =
            error instanceof FeedbackRequestError && error.reason === 'FEEDBACK_LOCAL_MODEL_REQUIRED'
          setPhase(local ? 'needsLocalModel' : 'draftFailed')
        }
      })
    void attempt()
  }

  function rate(value: Rating) {
    if (loading || phase === 'loadFailed') return
    // Safari leaves focus on the page after a click; the popover returns focus to what held it.
    triggers.current[value]?.focus({ preventScroll: true })
    const saved = current.current && !current.current.withdrawn ? current.current : undefined
    // A click right after another acts on what the row shows, not on the answer still on its way.
    const withdraw = pressed === value
    if (open) setOpen(undefined)
    setGenerate(false)
    const token = ++intentToken.current
    const settle = () => setIntent((shown) => (shown?.token === token ? undefined : shown))
    setIntent({ rating: withdraw ? null : value, token })
    if (withdraw) {
      // The pressed rating again takes it back; whatever was typed in its popover goes with it.
      setPhase('')
      const attempt = () =>
        enqueue(async (signal) => {
          try {
            await request(signal, 'withdraw')
            if (!signal?.aborted) reportSuccess('message-feedback', t('withdrawnNotice'))
          } catch {
            if (signal?.aborted) return
            retry.current = attempt
            setPhase('saveFailed')
          }
        })
      void attempt().finally(settle)
      return
    }
    // A reason that the other rating does not offer does not carry over.
    const offered: readonly Category[] = feedbackReasons[value]
    const keep = (category: Category) => (offered.includes(category) ? category : '')
    const base = open ? draft : { category: saved?.category ?? '', note: saved?.note ?? '' }
    const next = { category: keep(base.category), note: base.note }
    setDraft(next)
    setPhase('')
    setOpen(value)
    void save({ rating: value, ...next })
      .catch(() => setOpen(undefined))
      .finally(settle)
  }

  /** Escape and Done hand focus back to the rating; a click elsewhere leaves it where it went. */
  function close(returnFocus: boolean) {
    const rating = open
    if (!rating) return
    setOpen(undefined)
    if (returnFocus) triggers.current[rating]?.focus({ preventScroll: true })
    const saved = current.current && !current.current.withdrawn ? current.current : undefined
    const changed = !saved || saved.category !== draft.category || saved.note !== draft.note
    const drafting = generate && messageSeq !== null && draftable(rating, draft.category)
    setGenerate(false)
    // The row says at once that a draft is coming; a failed save replaces it with a retry.
    if (drafting) setPhase('drafting')
    const saving = changed ? save({ rating, ...draft }) : Promise.resolve()
    if (drafting) void saving.then(draftSuggestion, () => {})
  }

  // A click anywhere outside the popover and the rating buttons closes it and saves.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const node = event.target instanceof Element ? event.target : null
      if (node?.closest(`.${POPOVER_CLASS}`) || (node && fieldset.current?.contains(node))) return
      close(false)
    }
    // Escape inside the popover is handled there; this catches it when focus sits on the page.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) close(true)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', onEscape)
    }
  })

  const disabled = loading || phase === 'loadFailed'
  const status = statusLine(phase, t, () => retry.current?.(), openReview)
  return (
    <section
      className="agnes-message-feedback"
      aria-label={t(messageSeq === null ? 'session' : 'title')}
      data-testid={messageSeq === null ? 'session-feedback' : 'message-feedback'}
    >
      <fieldset ref={fieldset} className="agnes-settings-actions feedback-actions" aria-label={t('title')}>
        {(['up', 'down'] as const).map((value) => (
          <Popover
            key={value}
            open={open === value}
            trigger={[]}
            placement="bottomLeft"
            arrow={false}
            destroyOnHidden={true}
            motion={NO_MOTION}
            autoAdjustOverflow={OVERFLOW}
            rootClassName={POPOVER_CLASS}
            onOpenChange={(next) => {
              if (!next) close(true)
            }}
            content={
              <FeedbackPopover
                id={`${popoverId}-${value}`}
                rating={value}
                draft={draft}
                generate={generate}
                canGenerate={messageSeq !== null && draftable(value, draft.category)}
                onDraft={setDraft}
                onGenerate={setGenerate}
                onDone={() => close(true)}
              />
            }
          >
            <Button
              ref={(node) => {
                triggers.current[value] = node
              }}
              size="small"
              type="text"
              aria-label={t(value)}
              title={t(value)}
              data-testid={`feedback-${value}`}
              aria-pressed={pressed === value}
              aria-expanded={open === value}
              aria-controls={open === value ? `${popoverId}-${value}` : undefined}
              disabled={disabled}
              aria-busy={pending > 0 || undefined}
              onClick={() => rate(value)}
            >
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  transform={value === 'down' ? 'rotate(180 12 12)' : undefined}
                  d="M7 10v11H3V10ZM7 10l5-7c2 0 2 2 2 3l-1 4h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7"
                />
              </svg>
            </Button>
          </Popover>
        ))}
      </fieldset>
      <span className="feedback-status" data-tone={status?.tone} role="status" data-testid="feedback-status">
        {status?.content ??
          (item?.candidateId && (
            <Button
              size="small"
              appearance="link"
              className="feedback-link"
              data-testid="feedback-evidence"
              onClick={() => openEvidence(item.candidateId ?? '')}
            >
              {t('evidence')}
            </Button>
          ))}
      </span>
    </section>
  )
}

function statusLine(
  phase: Phase,
  t: (key: string) => string,
  retry: () => void,
  openReview: (() => void) | undefined,
): { tone: 'busy' | 'done' | 'error'; content: ReactNode } | undefined {
  const link = (label: string, onClick: () => void, testId: string) => (
    <Button size="small" appearance="link" className="feedback-link" data-testid={testId} onClick={onClick}>
      {label}
    </Button>
  )
  if (phase === 'drafting') return { tone: 'busy', content: t('generating') }
  if (phase === 'drafted')
    return {
      tone: 'done',
      content: (
        <>
          {t('drafted')}
          {openReview && (
            <>
              {' · '}
              {link(t('openReview'), openReview, 'feedback-open-review')}
            </>
          )}
        </>
      ),
    }
  if (phase === 'needsLocalModel') return { tone: 'error', content: t('needsLocalModel') }
  if (phase === 'saveFailed' || phase === 'draftFailed' || phase === 'loadFailed')
    return {
      tone: 'error',
      content: (
        <>
          {t(phase)}
          {' · '}
          {link(t('retry'), retry, 'feedback-retry')}
        </>
      ),
    }
  return undefined
}

function FeedbackPopover({
  id,
  rating,
  draft,
  generate,
  canGenerate,
  onDraft,
  onGenerate,
  onDone,
}: {
  id: string
  rating: Rating
  draft: Draft
  generate: boolean
  canGenerate: boolean
  onDraft(draft: Draft): void
  onGenerate(value: boolean): void
  onDone(): void
}) {
  const { t } = useFeedbackText()
  const first = useRef<HTMLButtonElement>(null)
  // Keyboard users land on the first reason; Tab walks the rest of the popover in order.
  useEffect(() => {
    // The popup attaches after this effect; focus once it is in the document.
    const timer = setTimeout(() => first.current?.focus({ preventScroll: true }))
    return () => clearTimeout(timer)
  }, [])
  return (
    <div id={id} className="feedback-popover" data-testid="feedback-popover" data-rating={rating}>
      <div className="feedback-popover-head">
        <strong>{t(`ask.${rating}`)}</strong>
        <span>{t('optional')}</span>
      </div>
      <fieldset className="feedback-chips" aria-label={t(`ask.${rating}`)}>
        {feedbackReasons[rating].map((category, index) => (
          <Button
            key={category}
            ref={index === 0 ? first : undefined}
            size="small"
            className="feedback-chip"
            data-testid={`feedback-reason-${category}`}
            aria-pressed={draft.category === category}
            onClick={() => onDraft({ ...draft, category: draft.category === category ? '' : category })}
          >
            {t(`reason.${rating}.${category}`)}
          </Button>
        ))}
      </fieldset>
      <SettingsTextArea
        className="feedback-note"
        data-testid="feedback-note"
        aria-label={t('noteLabel')}
        placeholder={t(`placeholder.${rating}`)}
        maxLength={4000}
        rows={2}
        value={draft.note}
        onChange={(event) => onDraft({ ...draft, note: event.target.value })}
      />
      {canGenerate && (
        <div className="feedback-generate">
          <SettingsCheckbox
            data-testid="feedback-generate"
            checked={generate}
            onChange={(event) => onGenerate(event.target.checked)}
            label={
              <>
                {t('generate')}
                <small>{t('generateHelp')}</small>
              </>
            }
          />
        </div>
      )}
      <div className="feedback-popover-foot">
        <span>{t('localOnly')}</span>
        <Button size="small" appearance="primary" data-testid="feedback-done" onClick={onDone}>
          {t('done')}
        </Button>
      </div>
    </div>
  )
}
