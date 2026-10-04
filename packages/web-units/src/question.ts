import {
  type QuestionAnswer,
  type QuestionAnswerPolicy,
  type QuestionRequest,
  validateQuestionAnswer,
  validateQuestionRequest,
} from '@agnes/protocol'
import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  createElement as h,
  type KeyboardEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export interface QuestionProps {
  interactionId: string
  request: QuestionRequest
  policy: QuestionAnswerPolicy
  disabled?: boolean
  onAnswer(answer: QuestionAnswer): Promise<void>
  onCancel(): Promise<void>
}
type Draft = { selected: string[]; custom: string; skipped: boolean }
const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const card: CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: 16,
  minWidth: 0,
  color: 'var(--agnes-text-primary)',
  background: 'var(--agnes-bg-card)',
  border: '1px solid var(--agnes-line-primary)',
  borderRadius: 'var(--radius-md)',
}
const detailStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  maxHeight: '32vh',
  overflow: 'auto',
  font: 'inherit',
  margin: 0,
}

/** Presentation only: request identity retires local drafts and in-flight UI updates. */
export function Question(props: QuestionProps) {
  const checked = validateQuestionRequest(props.request)
  if (!checked.ok) return h('p', { role: 'alert' }, '提问格式无效，无法提交。')
  return h(QuestionFlow, {
    ...props,
    key: JSON.stringify([props.interactionId, props.request, props.policy]),
  })
}

function QuestionFlow({ request, policy, disabled, onAnswer, onCancel }: QuestionProps) {
  const identity = useId()
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    request.questions.map(() => ({ selected: [], custom: '', skipped: false })),
  )
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [settled, setSettled] = useState(false)
  const [error, setError] = useState<string>()
  const alive = useRef(true)
  const locked = useRef(false)
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const question = request.questions[index]
  const draft = drafts[index]
  if (!question || !draft) return null
  const inactive = disabled === true || busy !== null || settled
  const answered = (value: Draft) => value.selected.length > 0 || value.custom.trim().length > 0
  const complete = (value: Draft) => answered(value) || (policy.allowSkip && value.skipped)
  const last = index === request.questions.length - 1
  const isPlan =
    request.questions.length === 1 &&
    question.intent?.kind === 'plan-review' &&
    !question.multiSelect &&
    (question.options?.length ?? 0) <= 2
  const settle = async (kind: 'answer' | 'cancel', action: () => Promise<void>) => {
    if (inactive || locked.current || !alive.current) return
    locked.current = true
    setBusy(kind)
    setError(undefined)
    try {
      await action()
      if (alive.current) setSettled(true)
    } catch (cause) {
      if (alive.current) {
        locked.current = false
        setBusy(null)
        setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
      }
    }
  }
  const submit = (values: Draft[]) => {
    if (inactive || locked.current) return
    const missing = values.findIndex((value) => !complete(value))
    if (missing >= 0) {
      setIndex(missing)
      setError('请回答每一题，或明确选择跳过。')
      return
    }
    const answer: QuestionAnswer = {
      answers: request.questions.map((item, position) => {
        const value = values[position]!
        return {
          id: item.id,
          selected: value.skipped ? [] : value.selected,
          ...(!value.skipped && value.custom.trim() ? { custom: value.custom } : {}),
        }
      }),
    }
    const checked = validateQuestionAnswer(request, answer, policy)
    if (!checked.ok) {
      setError('回答不完整或与当前问题不匹配，请检查后重试。')
      return
    }
    void settle('answer', () => onAnswer(checked.value))
  }
  const edit = (value: Draft, advance = false) => {
    if (inactive || locked.current) return
    setDrafts(drafts.map((previous, position) => (position === index ? value : previous)))
    setError(undefined)
    if (advance && !last) setIndex(index + 1)
  }
  const proceed = () => {
    if (inactive || locked.current) return
    if (last) submit(drafts)
    else if (complete(draft)) {
      setIndex(index + 1)
      setError(undefined)
    }
  }
  const skip = () => {
    if (!policy.allowSkip || inactive || locked.current) return
    const values = drafts.map((value, position) =>
      position === index ? { selected: [], custom: '', skipped: true } : value,
    )
    setDrafts(values)
    if (last) submit(values)
    else {
      setIndex(index + 1)
      setError(undefined)
    }
  }
  const enter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229)
      return
    event.preventDefault()
    proceed()
  }
  const button = (label: string, action: () => void, extraDisabled = false, description?: string) =>
    h(
      'button',
      {
        type: 'button',
        disabled: inactive || extraDisabled,
        onClick: action,
        ...(description === undefined ? {} : { title: description }),
      },
      label,
    )
  const feedback = h(
    'p',
    { role: error ? 'alert' : 'status', style: { margin: 0, overflowWrap: 'anywhere' } },
    error ?? (settled ? (busy === 'cancel' ? '已取消提问。' : '回答已提交。') : busy ? '正在提交…' : ''),
  )
  return h(
    'section',
    {
      className: 'agnes-question',
      style: card,
      'aria-labelledby': `${identity}-title`,
      'aria-busy': busy !== null && !settled,
    },
    h(
      'header',
      null,
      isPlan ? h('p', { style: { color: 'var(--agnes-text-secondary)' } }, '计划审阅') : null,
      question.header === undefined ? null : h('p', null, question.header),
      h('h3', { id: `${identity}-title`, style: { margin: 0, overflowWrap: 'anywhere' } }, question.question),
    ),
    question.detail === undefined ? null : h('pre', { style: detailStyle }, question.detail),
    isPlan
      ? h(
          'div',
          { style: row },
          button('讨论修改', () => {
            void settle('cancel', onCancel)
          }),
          button(
            question.intent!.approve,
            () => submit([{ selected: [question.intent!.approve], custom: '', skipped: false }]),
            false,
            question.options?.find((option) => option.label === question.intent?.approve)?.description,
          ),
          policy.allowSkip ? button('跳过此题', skip) : null,
        )
      : h(
          'form',
          {
            onSubmit: (event: FormEvent<HTMLFormElement>) => {
              event.preventDefault()
              proceed()
            },
            style: { display: 'grid', gap: 12 },
          },
          h(
            'fieldset',
            {
              disabled: inactive,
              style: { border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 8 },
            },
            h('legend', null, question.multiSelect ? '可选择多项，也可补充回答' : '选择一项或填写回答'),
            ...(question.options ?? []).map((option, optionIndex) =>
              h(
                'label',
                {
                  key: option.label,
                  style: {
                    ...row,
                    alignItems: 'flex-start',
                    flexWrap: 'nowrap',
                    padding: 8,
                    border: '1px solid var(--agnes-line-primary)',
                    borderRadius: 'var(--radius-sm)',
                  },
                },
                h('input', {
                  type: question.multiSelect ? 'checkbox' : 'radio',
                  style: {
                    width: 16,
                    height: 16,
                    minHeight: 0,
                    padding: 0,
                    margin: '3px 0 0',
                    flexShrink: 0,
                  },
                  name: `${identity}-${index}`,
                  value: option.label,
                  checked: draft.selected.includes(option.label),
                  onChange: () =>
                    edit(
                      {
                        skipped: false,
                        custom: question.multiSelect ? draft.custom : '',
                        selected: question.multiSelect
                          ? draft.selected.includes(option.label)
                            ? draft.selected.filter((label) => label !== option.label)
                            : [...draft.selected, option.label]
                          : [option.label],
                      },
                      !question.multiSelect,
                    ),
                }),
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } },
                  h('span', null, `${optionIndex + 1}. ${option.label}`),
                  option.description === undefined
                    ? null
                    : h(
                        'small',
                        { style: { display: 'block', color: 'var(--agnes-text-secondary)' } },
                        option.description,
                      ),
                ),
              ),
            ),
            h('label', { htmlFor: `${identity}-custom` }, question.options?.length ? '其他回答' : '你的回答'),
            h('textarea', {
              id: `${identity}-custom`,
              rows: 3,
              value: draft.custom,
              disabled: inactive,
              style: {
                width: '100%',
                boxSizing: 'border-box',
                resize: 'vertical',
                font: 'inherit',
                color: 'inherit',
                background: 'var(--agnes-bg-app-content)',
              },
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
                edit({
                  selected: question.multiSelect ? draft.selected : [],
                  custom: event.currentTarget.value,
                  skipped: false,
                }),
              onKeyDown: enter,
            }),
          ),
          h(
            'footer',
            { style: { ...row, justifyContent: 'space-between' } },
            h(
              'div',
              { style: row },
              button(
                '上一题',
                () => {
                  setIndex(index - 1)
                  setError(undefined)
                },
                index === 0,
              ),
              h('span', { 'aria-live': 'polite' }, `${index + 1} / ${request.questions.length}`),
              button(
                '下一题',
                () => {
                  setIndex(index + 1)
                  setError(undefined)
                },
                last,
              ),
            ),
            h(
              'div',
              { style: row },
              button('取消提问', () => {
                void settle('cancel', onCancel)
              }),
              policy.allowSkip ? button('跳过此题', skip) : null,
              h(
                'button',
                { type: 'submit', disabled: inactive || !complete(draft) },
                last ? '提交全部回答' : '继续',
              ),
            ),
          ),
        ),
    feedback,
  )
}
