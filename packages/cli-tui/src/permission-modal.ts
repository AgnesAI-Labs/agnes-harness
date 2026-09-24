import type { PermissionOutcome, PermissionRequest } from '@agnes/sdk'
import { type Component, escapeControl, wrapText } from './component.js'
import { fitLine } from './components/line.js'
import { parseKey } from './keys.js'
import { type Locale, t } from './locale.js'

type Question = {
  request: PermissionRequest
  selected: number
  detailOffset: number
  pageRows: number
  visible: Set<number>
  canSelect: boolean
  finish(outcome: PermissionOutcome): void
}

/** FIFO prompts own input until answered; Enter initially selects rejection. */
export class PermissionModal implements Component {
  private readonly questions: Question[] = []
  private closed = false
  constructor(
    private readonly changed: () => void,
    private readonly options: { maxRows?(): number; locale?: Locale } = {},
  ) {}

  get pending(): boolean {
    return this.questions.length > 0
  }

  ask(request: PermissionRequest, context: { signal: AbortSignal }): Promise<PermissionOutcome> {
    if (this.closed || context.signal.aborted) return Promise.resolve({ verdict: 'rejected' })
    const snapshot = structuredClone(request)
    return new Promise((resolve) => {
      let done = false
      const abort = () => question.finish({ verdict: 'rejected' })
      const question: Question = {
        request: snapshot,
        selected: snapshot.options.findIndex((option) => option.kind === 'reject_once'),
        detailOffset: 0,
        pageRows: 1,
        visible: new Set(),
        canSelect: false,
        finish: (answer) => {
          if (done) return
          done = true
          context.signal.removeEventListener('abort', abort)
          const index = this.questions.indexOf(question)
          if (index >= 0) this.questions.splice(index, 1)
          resolve(context.signal.aborted ? { verdict: 'rejected' } : answer)
          this.changed()
        },
      }
      this.questions.push(question)
      context.signal.addEventListener('abort', abort, { once: true })
      if (context.signal.aborted) abort()
      else this.changed()
    })
  }

  close(): void {
    this.closed = true
    for (const question of [...this.questions]) question.finish({ verdict: 'rejected' })
  }

  handleInput(data: string): boolean {
    const question = this.questions[0]
    if (!question) return false
    const key = parseKey(data, false)
    const options = question.request.options
    if (key.name === 'esc' || key.name === 'ctrl-c') question.finish({ verdict: 'rejected' })
    else if (key.name === 'enter') {
      const option = options[question.selected]
      if (!option || option.kind === 'reject_once' || option.kind === 'reject_always')
        question.finish(option ? { optionId: option.optionId } : { verdict: 'rejected' })
      else if (question.canSelect && question.visible.has(question.selected))
        question.finish({ optionId: option.optionId })
    } else if (key.name === 'char' && /^[1-9]$/.test(key.ch ?? '')) {
      const option = options[Number(key.ch) - 1]
      if (
        option &&
        (option.kind.startsWith('reject_') ||
          (question.canSelect && question.visible.has(Number(key.ch) - 1)))
      )
        question.finish({ optionId: option.optionId })
    } else if (key.name === 'pgup' || key.name === 'pgdn') {
      question.detailOffset = Math.max(
        0,
        question.detailOffset + (key.name === 'pgup' ? -1 : 1) * question.pageRows,
      )
      this.changed()
    } else if (key.name === 'up' || key.name === 'down') {
      question.selected = Math.max(
        0,
        Math.min(options.length - 1, question.selected + (key.name === 'up' ? -1 : 1)),
      )
      this.changed()
    }
    return true
  }

  invalidate(): void {}
  render(width: number): string[] {
    const question = this.questions[0]
    if (!question) return []
    const locale = this.options.locale ?? 'en'
    const title = question.request.toolCall.title
    const heading = `${t('permission.heading', locale)}: ${escapeControl(
      typeof title === 'string' ? title : t('permission.toolRequest', locale),
    )}`
    const details = wrapText(heading, width)
    if (question.request.toolCall.rawInput !== undefined)
      details.push(
        ...wrapText(escapeControl(JSON.stringify(question.request.toolCall.rawInput, null, 2)), width),
      )
    const choices = question.request.options
    const requested = this.options.maxRows?.()
    const rows =
      requested !== undefined && Number.isFinite(requested)
        ? Math.max(1, Math.trunc(requested))
        : details.length + choices.length + 2
    question.visible.clear()
    question.canSelect = rows >= 4
    if (rows < 4) return [fitLine(t('permission.resize', locale), width)]
    const count =
      requested === undefined
        ? choices.length
        : Math.min(choices.length, Math.max(1, Math.floor((rows - 2) / 2)))
    const start = Math.max(0, Math.min(question.selected - count + 1, choices.length - count))
    const choiceLines = choices.slice(start, start + count).map((option, i) => {
      const index = start + i
      question.visible.add(index)
      return fitLine(
        `${index === question.selected ? '>' : ' '} ${index + 1}. ${escapeControl(option.name)}`,
        width,
      )
    })
    question.pageRows = Math.max(1, rows - choiceLines.length - 2)
    question.detailOffset = Math.min(question.detailOffset, Math.max(0, details.length - question.pageRows))
    const page = details
      .slice(question.detailOffset, question.detailOffset + question.pageRows)
      .map((line) => fitLine(line, width))
    return [
      fitLine(heading, width),
      ...page,
      ...choiceLines,
      fitLine(
        t('permission.footer', locale, {
          start: question.detailOffset + 1,
          end: question.detailOffset + page.length,
          total: details.length,
        }),
        width,
      ),
    ]
  }
}
