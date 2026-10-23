import { useEffect, useId, useRef, useState } from 'react'
import { SettingsInput, SettingsTextArea } from '../settings-layout.js'
import { Button } from '../ui/button.js'
import { Icon } from '../ui/icon.js'
import { Kbd } from '../ui/kbd.js'
import { useUiText } from '../ui-locale.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import {
  completeAnswers,
  isAnswered,
  otherText,
  type QuestionAnswers,
  type QuestionForm,
  type QuestionItem,
  toggleOption,
  withOtherText,
} from './question.js'

export interface QuestionCardProps {
  surfaceId: string
  form: QuestionForm
  answers: QuestionAnswers
  /** No answer can change: the surface is closed, a submission is in flight or the view is reloading. */
  locked: boolean
  submitting: boolean
  failed: boolean
  /**
   * The card cannot go on as it is: `review` re-reads a changed or closed question, `resend` sends the
   * unconfirmed submission again with its own commandId, `retry` repeats a failure the backend marked
   * safe; `unknown` stays locked; `rejected` may be answered again.
   */
  recovery?: { kind: 'review' | 'resend' | 'retry' | 'unknown' | 'rejected'; message?: string } | undefined
  onRecover?: (() => void) | undefined
  onAnswers(answers: QuestionAnswers): void
  onSubmit(answers: QuestionAnswers): void
  /** For tests; the card otherwise reads the clock itself. */
  now?: number
}

/** True while the asking tool still waits; flips once at the deadline without a running clock. */
function useWaiting(deadline: number, now?: number): boolean {
  const [clock, setClock] = useState(() => now ?? Date.now())
  const at = now ?? clock
  useEffect(() => {
    if (now !== undefined || deadline <= clock) return
    const timer = setTimeout(() => setClock(Date.now()), Math.min(deadline - clock + 50, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [deadline, clock, now])
  return deadline > at
}

/**
 * ask_user_question as a step card docked above the composer: one question at a time, number keys
 * to choose, Enter for the next question, Shift+Enter to go back, and one submit for all answers.
 */
export function QuestionCard(props: QuestionCardProps) {
  const { form, answers } = props
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const count = form.questions.length
  const answered = form.questions.filter((question) => isAnswered(answers[question.id])).length
  const [step, setStep] = useState(() =>
    Math.max(
      0,
      form.questions.findIndex((question) => !isAnswered(answers[question.id])),
    ),
  )
  const [collapsed, setCollapsed] = useState(false)
  const waiting = useWaiting(form.deadline, props.now)
  const body = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  const titleId = useId()
  const current = form.questions[Math.min(step, count - 1)]!
  const last = step >= count - 1
  const complete = completeAnswers(form, answers)
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus follows the step the person moved to.
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    const target =
      body.current?.querySelector<HTMLElement>('input:checked') ??
      body.current?.querySelector<HTMLElement>('input, textarea')
    target?.focus()
  }, [step])
  const go = (next: number) => {
    if (next < 0 || next >= count) return
    moved.current = !!body.current?.closest('section')?.contains(document.activeElement)
    setStep(next)
  }
  const set = (question: QuestionItem, value: string | string[]) =>
    props.onAnswers({ ...answers, [question.id]: value })
  const submit = () => {
    if (complete && !props.locked) props.onSubmit(complete)
  }
  const forward = () => (last ? submit() : go(step + 1))
  const onKeyDown = (event: KeyboardEvent) => {
    if (props.locked || collapsed || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
      return
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    const typing =
      target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type === 'text')
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      forward()
    } else if (event.key === 'Enter' && event.shiftKey && !(target instanceof HTMLTextAreaElement)) {
      event.preventDefault()
      go(step - 1)
    } else if (!typing && /^[1-9]$/.test(event.key)) {
      const option = current.options[Number(event.key) - 1]
      if (option === undefined) return
      event.preventDefault()
      set(current, toggleOption(current, answers[current.id], option))
    }
  }
  const section = useRef<HTMLElement>(null)
  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  // With nothing focused the keys reach the first open card; the composer and other fields keep theirs.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.target !== document.body || event.defaultPrevented) return
      if (document.querySelector('[data-testid="question-card"]') !== section.current) return
      keys.current(event)
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])
  const heading = collapsed
    ? t('ui.question.headingProgress', { answered, count })
    : t(count === 1 ? 'ui.question.headingOne' : 'ui.question.heading', { count })
  const status = (
    <span className="agnes-question-status" data-testid="question-status" data-waiting={waiting || undefined}>
      {t(waiting ? 'ui.question.waiting' : 'ui.question.continuing')}
    </span>
  )
  return (
    <section
      className="agnes-question-card"
      data-testid="question-card"
      data-surface-id={props.surfaceId}
      data-collapsed={collapsed || undefined}
      aria-labelledby={titleId}
      ref={section}
      onKeyDown={(event) => onKeyDown(event.nativeEvent)}
    >
      <header className="agnes-question-head">
        <h3 id={titleId}>{heading}</h3>
        {status}
        <Button
          htmlType="button"
          appearance="ghost"
          size="small"
          className="agnes-question-toggle"
          data-testid="question-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {t(collapsed ? 'ui.question.expand' : 'ui.question.collapse')}
        </Button>
      </header>
      {!collapsed && (
        <>
          {count > 1 && (
            <ol className="agnes-question-steps" aria-label={t('ui.question.steps')}>
              {form.questions.map((question, index) => {
                const state =
                  index === step ? 'current' : isAnswered(answers[question.id]) ? 'done' : 'pending'
                return (
                  <li key={question.id}>
                    <Button
                      htmlType="button"
                      appearance="ghost"
                      size="small"
                      className="agnes-question-step"
                      data-testid={`question-step-${index}`}
                      data-state={state}
                      aria-current={index === step ? 'step' : undefined}
                      title={question.question}
                      onClick={() => go(index)}
                    >
                      <span className="agnes-question-step-mark" aria-hidden="true">
                        {state === 'done' ? <Icon name="check" /> : index + 1}
                      </span>
                      <span className="agnes-question-step-label">{question.label}</span>
                      {state === 'done' && (
                        <span className="agh-visually-hidden">{t('ui.question.stepDone')}</span>
                      )}
                    </Button>
                  </li>
                )
              })}
            </ol>
          )}
          <div className="agnes-question-body" ref={body}>
            <QuestionStep
              key={current.id}
              question={current}
              index={step}
              count={count}
              value={answers[current.id]}
              disabled={props.locked}
              onChange={(value) => set(current, value)}
            />
          </div>
          <footer className="agnes-question-foot">
            <span className="agnes-question-hint" aria-live="polite">
              {props.recovery && props.recovery.kind !== 'rejected' ? (
                <span className="agnes-question-error" role="alert" data-testid="question-recovery">
                  {t(`ui.question.recover.${props.recovery.kind}`)}
                </span>
              ) : props.failed ? (
                <span className="agnes-question-error" role="alert">
                  {props.recovery?.message ?? t('ui.question.failed')}
                </span>
              ) : current.multiple && Array.isArray(answers[current.id]) && answers[current.id]!.length ? (
                t('ui.question.selected', { count: answers[current.id]!.length })
              ) : current.options.length ? (
                <>
                  <Kbd>1–{Math.min(9, current.options.length)}</Kbd> {t('ui.question.hintChoose')} ·{' '}
                  <Kbd keys={['enter']} /> {t(last ? 'ui.question.hintSubmit' : 'ui.question.hintNext')}
                </>
              ) : (
                <>
                  <Kbd keys={['enter']} /> {t(last ? 'ui.question.hintSubmit' : 'ui.question.hintNext')}
                </>
              )}
            </span>
            {props.recovery && ['review', 'resend', 'retry'].includes(props.recovery.kind) && (
              <Button htmlType="button" size="small" data-testid="question-recover" onClick={props.onRecover}>
                {t(`ui.question.recover.${props.recovery.kind}Action`)}
              </Button>
            )}
            {step > 0 && (
              <Button
                htmlType="button"
                appearance="ghost"
                size="small"
                data-testid="question-back"
                onClick={() => go(step - 1)}
              >
                {t('ui.question.back')}
              </Button>
            )}
            {last ? (
              <Button
                htmlType="button"
                appearance="primary"
                size="small"
                data-testid="question-submit"
                loading={props.submitting}
                disabled={!complete || props.locked}
                {...(complete ? {} : { disabledReason: t('ui.question.incomplete') })}
                onClick={submit}
              >
                {t(count === 1 ? 'ui.question.submitOne' : 'ui.question.submit', { count })}
              </Button>
            ) : (
              <Button
                htmlType="button"
                appearance="primary"
                size="small"
                data-testid="question-next"
                onClick={() => go(step + 1)}
              >
                {t('ui.question.next')}
              </Button>
            )}
          </footer>
        </>
      )}
    </section>
  )
}

function QuestionStep({
  question,
  index,
  count,
  value,
  disabled,
  onChange,
}: {
  question: QuestionItem
  index: number
  count: number
  value: string | string[] | undefined
  disabled: boolean
  onChange(value: string | string[]): void
}) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const name = useId()
  const promptId = useId()
  const other = otherText(question, value)
  const selected = (option: string) => (Array.isArray(value) ? value.includes(option) : value === option)
  return (
    <fieldset
      className="agnes-question-step-body"
      disabled={disabled}
      aria-labelledby={promptId}
      data-testid={`question-${question.id}`}
    >
      <p id={promptId} className="agnes-question-prompt">
        <span className="agh-visually-hidden">{t('ui.question.position', { index: index + 1, count })} </span>
        {question.question}
      </p>
      {question.options.length > 0 ? (
        <>
          <p className="agnes-question-kind">
            {t(question.multiple ? 'ui.question.multiple' : 'ui.question.single')}
          </p>
          <div className="agnes-question-options" role={question.multiple ? 'group' : 'radiogroup'}>
            {question.options.map((option, optionIndex) => (
              <label
                key={option}
                htmlFor={`${name}-${optionIndex}`}
                className="agnes-question-option"
                data-selected={selected(option) || undefined}
                data-multiple={question.multiple || undefined}
              >
                <SettingsInput
                  id={`${name}-${optionIndex}`}
                  className="agnes-question-option-input"
                  type={question.multiple ? 'checkbox' : 'radio'}
                  name={name}
                  checked={selected(option)}
                  data-testid={`question-option-${question.id}-${optionIndex}`}
                  onChange={() => onChange(toggleOption(question, value, option))}
                />
                {optionIndex < 9 && (
                  <Kbd className="agnes-question-option-key" aria-hidden="true">
                    {optionIndex + 1}
                  </Kbd>
                )}
                <span className="agnes-question-option-text">{option}</span>
                <span className="agnes-question-option-mark" aria-hidden="true" />
              </label>
            ))}
            {question.freeText && (
              <div className="agnes-question-other" data-filled={other ? true : undefined}>
                <SettingsInput
                  type="text"
                  surface="surface"
                  className="agnes-question-other-input"
                  value={other}
                  maxLength={8192}
                  placeholder={t('ui.question.other')}
                  aria-label={t('ui.question.other')}
                  data-testid={`question-other-${question.id}`}
                  onChange={(event) => onChange(withOtherText(question, value, event.currentTarget.value))}
                />
              </div>
            )}
          </div>
        </>
      ) : (
        <SettingsTextArea
          className="agnes-question-text"
          rows={3}
          maxLength={8192}
          value={typeof value === 'string' ? value : ''}
          placeholder={t('ui.question.textPlaceholder')}
          aria-labelledby={promptId}
          data-testid={`question-text-${question.id}`}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </fieldset>
  )
}

/** The person's answers, shown in the conversation once they are submitted. */
export function QuestionAnswersReceipt({
  items,
}: {
  items: readonly { id: string; label?: string; question?: string; value: string | string[] }[]
}) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  return (
    <section
      className="agnes-question-receipt"
      data-testid="question-answers"
      aria-label={t('ui.question.answers')}
    >
      <header>
        <Icon name="check" aria-hidden="true" />
        <span>{t('ui.question.answers')}</span>
      </header>
      <dl data-unlabelled={items.some((item) => !item.label) || undefined}>
        {items.map((item) => (
          <div key={item.id} data-testid={`question-answer-${item.id}`}>
            {item.label && <dt title={item.question}>{item.label}</dt>}
            <dd>
              {Array.isArray(item.value)
                ? item.value.map((value) => (
                    <span key={value} className="agnes-question-pill">
                      {value}
                    </span>
                  ))
                : item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * «✓ Answered N items» at the front of the asking answer's action row. Pointer hover or keyboard focus
 * shows the answers above it; a touch opens it until a touch elsewhere.
 */
export function AnsweredBadge({
  items,
}: {
  items: readonly { id: string; label?: string; question?: string; value: string | string[] }[]
}) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const [pinned, setPinned] = useState(false)
  // Above the bar by default; below it when the badge sits too near the top of the window.
  const [below, setBelow] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const popId = useId()
  const place = () => {
    const box = root.current?.getBoundingClientRect()
    const pop = root.current?.querySelector<HTMLElement>('.agnes-answered-pop')
    if (box && pop) setBelow(box.top < pop.offsetHeight + 16)
  }
  useEffect(() => {
    if (!pinned) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPinned(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [pinned])
  const separator = t('ui.question.listSeparator')
  return (
    <div
      ref={root}
      className="agnes-answered"
      data-testid="question-answered"
      data-open={pinned || undefined}
      data-below={below || undefined}
    >
      <Button
        htmlType="button"
        appearance="ghost"
        size="small"
        className="agnes-answered-badge"
        data-testid="question-answered-badge"
        aria-describedby={popId}
        aria-expanded={pinned}
        onPointerEnter={place}
        onFocus={place}
        onPointerUp={(event) => {
          if (event.pointerType === 'mouse') return
          place()
          setPinned((value) => !value)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          setPinned(false)
          event.currentTarget.blur()
        }}
      >
        <Icon name="check" aria-hidden="true" />
        {t('ui.question.answeredCount', { count: items.length })}
      </Button>
      <div id={popId} role="tooltip" className="agnes-answered-pop" data-testid="question-answers">
        <p className="agnes-answered-head">{t('ui.question.answers')}</p>
        <dl data-unlabelled={items.some((item) => !item.label) || undefined}>
          {items.map((item) => (
            <div key={item.id} className="agnes-answered-row" data-testid={`question-answer-${item.id}`}>
              {item.label && <dt title={item.question}>{item.label}</dt>}
              <dd>{Array.isArray(item.value) ? item.value.join(separator) : item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
