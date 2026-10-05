import type { QuestionAnswer, QuestionInteraction, QuestionResolution } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { Question } from '@agnes/web-units'
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'

/** Live owner queries are the only source of actionable questions; ledger history is never authority. */
export function createQuestionController(
  host: HTMLElement,
  client: Pick<Client, 'questions'> & Partial<Pick<Client, 'on'>>,
) {
  host.style.maxHeight = '50vh'
  host.style.overflowY = 'auto'
  host.style.flexShrink = '0'
  const root = createRoot(host)
  let sessionId: string | undefined
  let epoch = 0
  let disposed = false
  let active = true
  let online = true
  let interactions: QuestionInteraction[] = []
  // Comparison supplies its committed prefix. Live owner queries only authorize matching rows.
  let projected: readonly QuestionInteraction[] | undefined
  let error: string | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let reading: number | undefined
  let again = false
  const settled = new Set<string>()
  const key = (item: QuestionInteraction) =>
    JSON.stringify([
      item.sessionId,
      item.interactionId,
      item.writerRunId,
      item.generation,
      item.requestedSeq,
      item.request,
      item.policy,
    ])
  const valid = (ticket: number, id: string) =>
    !disposed && active && online && ticket === epoch && sessionId === id

  function draw() {
    const visible = projected ?? interactions
    host.hidden =
      projected === undefined
        ? !active || !sessionId || (!interactions.length && !error)
        : !visible.length && !(active && error)
    if (disposed) return
    root.render(
      h(
        'div',
        { 'aria-label': '当前会话提问' },
        active && error ? h('p', { role: 'alert' }, error) : null,
        ...visible.map((item) => {
          const actionable =
            active && online && !error && interactions.some((current) => key(current) === key(item))
          if (projected !== undefined && !actionable)
            return h(
              'section',
              { key: key(item), 'aria-label': '已记录提问（只读）' },
              h('p', null, '已记录提问 · 此截面只读，不能提交回答。'),
              ...item.request.questions.map((question) =>
                h(
                  'section',
                  { key: question.id },
                  h('h3', null, question.question),
                  question.detail ? h('pre', { style: { whiteSpace: 'pre-wrap' } }, question.detail) : null,
                  h(
                    'ul',
                    null,
                    ...(question.options ?? []).map((option) =>
                      h(
                        'li',
                        { key: option.label },
                        option.label,
                        option.description ? `：${option.description}` : '',
                      ),
                    ),
                  ),
                ),
              ),
            )
          return h(Question, {
            key: key(item),
            interactionId: item.interactionId,
            request: item.request,
            policy: item.policy,
            disabled: !actionable,
            onAnswer: (answer: QuestionAnswer) => resolve(item, answer),
            onCancel: () => resolve(item),
          })
        }),
      ),
    )
  }
  async function resolve(item: QuestionInteraction, answer?: QuestionAnswer) {
    const ticket = epoch
    const id = sessionId
    if (
      !id ||
      !valid(ticket, id) ||
      !interactions.some((current) => key(current) === key(item)) ||
      (projected !== undefined && !projected.some((current) => key(current) === key(item)))
    )
      throw new Error('此问题已不属于当前可回答会话。')
    let result: QuestionResolution
    try {
      result =
        answer === undefined
          ? await client.questions.cancel({ sessionId: id, interactionId: item.interactionId })
          : await client.questions.answer({ sessionId: id, interactionId: item.interactionId, answer })
    } catch {
      throw new Error('提交未确认，请保留回答并重试或核对当前问题。')
    }
    if (!valid(ticket, id)) throw new Error('提问所属连接已变化，请核对当前问题后重试。')
    if (
      result.sessionId !== id ||
      result.interactionId !== item.interactionId ||
      !Number.isSafeInteger(result.settledSeq) ||
      result.settledSeq < 1 ||
      !['answered', 'cancelled', 'aborted'].includes(result.status)
    )
      throw new Error('未收到匹配的持久化提问回执，请重试核对。')
    settled.add(key(item))
    interactions = interactions.filter((current) => key(current) !== key(item))
    draw()
    void refresh()
  }
  async function refresh() {
    const id = sessionId
    const ticket = epoch
    if (!id || !valid(ticket, id)) return
    if (reading === ticket) {
      again = true
      return
    }
    reading = ticket
    try {
      const result = await client.questions.pending(id)
      if (!valid(ticket, id)) return
      if (result.sessionId !== id || result.interactions.some((item) => item.sessionId !== id))
        throw new Error('Mismatched question owner')
      interactions = result.interactions.filter((item) => !settled.has(key(item)))
      error = undefined
    } catch {
      if (!valid(ticket, id)) return
      error = '当前提问状态未确认，暂不可回答；正在重新连接。'
    } finally {
      if (reading === ticket) reading = undefined
      if (valid(ticket, id)) {
        draw()
        if (again) {
          again = false
          void refresh()
        }
      }
    }
  }
  function reset() {
    epoch++
    if (timer) clearInterval(timer)
    timer = undefined
    reading = undefined
    again = false
    interactions = []
    settled.clear()
    error = undefined
    draw()
    if (!disposed && active && online && sessionId) {
      void refresh()
      timer = setInterval(() => {
        void refresh()
      }, 2000)
    }
  }
  const offline = () => {
    if (disposed || !online) return
    online = false
    epoch++
    if (timer) clearInterval(timer)
    timer = undefined
    reading = undefined
    again = false
    draw()
  }
  const off = [
    client.on?.('reconnecting', offline),
    client.on?.('closed', offline),
    client.on?.('generationChanged', (payload) => {
      if (!disposed && (payload as { sessionId?: unknown } | undefined)?.sessionId === sessionId) reset()
    }),
    client.on?.('reconnected', () => {
      if (disposed) return
      online = true
      if (active && sessionId) {
        error = '正在核对当前提问，请稍候。'
        draw()
        void refresh()
        if (!timer)
          timer = setInterval(() => {
            void refresh()
          }, 2000)
      }
    }),
  ]
  draw()
  return {
    project(value: readonly QuestionInteraction[]) {
      if (disposed) return
      projected = value
      draw()
    },
    select(id?: string) {
      if (disposed || sessionId === id) return
      sessionId = id
      reset()
    },
    enabled(value: boolean) {
      if (disposed || active === value) return
      active = value
      reset()
    },
    refresh,
    event(event: { type: string }) {
      if (event.type === 'question/requested' || event.type === 'question/settled') void refresh()
    },
    dispose() {
      if (disposed) return
      disposed = true
      epoch++
      if (timer) clearInterval(timer)
      for (const unsubscribe of off) unsubscribe?.()
      root.unmount()
      host.hidden = true
    },
  }
}
