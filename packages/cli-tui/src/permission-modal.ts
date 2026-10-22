import type { PermissionOutcome, PermissionRequest } from '@agnes/sdk'
import { createAnsi } from './ansi.js'
import { type Component, escapeControl, wrapText } from './component.js'
import { columns, fitLine } from './components/line.js'
import { parseKey } from './keys.js'
import { type Locale, t } from './locale.js'
import { tt } from './locale-extended.js'
import { displayWidth } from './terminal.js'
import { paintsColour, type ThemedAnsi, TuiTheme } from './theme.js'
import { approvalBody, approvalHeadline } from './views/approval-body.js'

type Question = {
  request: PermissionRequest
  selected: number
  detailOffset: number
  pageRows: number
  /** How many options the last paint had room for; 0 until there was one. */
  count: number
  canSelect: boolean
  finish(outcome: PermissionOutcome): void
}

// The window of options on screen: it follows the selection, so scrolling reaches every option.
const windowStart = (selected: number, count: number, total: number): number =>
  Math.max(0, Math.min(selected - count + 1, total - count))

/** What an option says: the kind's own words, with the scope an ACP grant has; unknown kinds keep their name. */
function optionLabel(option: PermissionRequest['options'][number], locale: Locale): string {
  if (option.kind === 'allow_once') return t('approval.allowOnce', locale)
  if (option.kind === 'allow_always') return tt('approval.allowAlways', locale)
  if (option.kind === 'reject_once') return t('approval.reject', locale)
  return escapeControl(option.name)
}

/** FIFO prompts own input until answered; Enter initially selects rejection. */
export class PermissionModal implements Component {
  private readonly questions: Question[] = []
  private closed = false
  constructor(
    private readonly changed: () => void,
    private readonly options: { maxRows?(): number; locale?: Locale; ansi?: ThemedAnsi } = {},
  ) {}

  get count(): number {
    return this.questions.length
  }

  get pending(): boolean {
    return this.questions.length > 0
  }

  ask(request: PermissionRequest, context: { signal: AbortSignal }): Promise<PermissionOutcome> {
    if (this.closed || context.signal.aborted) return Promise.resolve({ unanswered: 'detached' })
    const snapshot = structuredClone(request)
    return new Promise((resolve) => {
      let done = false
      const abort = () => question.finish({ unanswered: 'detached' })
      const question: Question = {
        request: snapshot,
        selected: snapshot.options.findIndex((option) => option.kind === 'reject_once'),
        detailOffset: 0,
        pageRows: 1,
        count: 0,
        canSelect: false,
        finish: (answer) => {
          if (done) return
          done = true
          context.signal.removeEventListener('abort', abort)
          const index = this.questions.indexOf(question)
          if (index >= 0) this.questions.splice(index, 1)
          resolve(context.signal.aborted ? { unanswered: 'detached' } : answer)
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
    for (const question of [...this.questions]) question.finish({ unanswered: 'detached' })
  }

  /** Whether option `index` is in the window the next paint (or the last one) shows. */
  private shown(question: Question, index: number): boolean {
    const start = windowStart(question.selected, question.count, question.request.options.length)
    return question.canSelect && index >= start && index < start + question.count
  }

  handleInput(data: string): boolean {
    const question = this.questions[0]
    if (!question) return false
    const key = parseKey(data, false)
    const options = question.request.options
    if (key.name === 'esc' || key.name === 'ctrl-c') question.finish({ unanswered: 'detached' })
    else if (key.name === 'enter') {
      const option = options[question.selected]
      if (!option || option.kind === 'reject_once' || option.kind === 'reject_always')
        question.finish(option ? { optionId: option.optionId } : { unanswered: 'detached' })
      else if (this.shown(question, question.selected)) question.finish({ optionId: option.optionId })
    } else if (key.name === 'char' && /^[1-9]$/.test(key.ch ?? '')) {
      const option = options[Number(key.ch) - 1]
      if (option && (option.kind.startsWith('reject_') || this.shown(question, Number(key.ch) - 1)))
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
    width = columns(width)
    const ansi = this.options.ansi ?? new TuiTheme('mono').ansi(createAnsi('none'))
    const locale = this.options.locale ?? 'en'
    const call = question.request.toolCall
    const meta = call._meta as { 'ai.agnes.harness'?: { tool?: unknown } } | undefined
    const input = call.rawInput as { packageId?: unknown; candidateHash?: unknown } | undefined
    const title =
      meta?.['ai.agnes.harness']?.tool === 'plugin_candidate_test' &&
      typeof input?.packageId === 'string' &&
      typeof input.candidateHash === 'string'
        ? t('permission.candidateTest', locale, {
            name: input.packageId,
            hash: input.candidateHash.replace(/^sha256-/, '').slice(0, 12),
          })
        : call.title
    const headline = typeof title === 'string' ? title : approvalHeadline(undefined, call.rawInput)
    const heading = `${t('permission.heading', locale)}: ${escapeControl(headline || t('permission.toolRequest', locale))}`
    // The title and footer ride in the frame's borders, so framing costs columns but no rows.
    const framed = width >= 8
    const inner = framed ? width - 4 : width
    const edge = (s: string) => ansi.fg('borderStrong', s)
    const bar = (left: string, label: string, right: string) => {
      if (!framed) return fitLine(label, width)
      const text = displayWidth(label) <= width - 4 ? label : fitLine(label, width - 4)
      return `${edge(`${left} `)}${text}${edge(` ${'─'.repeat(width - 4 - displayWidth(text))}${right}`)}`
    }
    const row = (line: string) =>
      framed ? `${edge('│')} ${fitLine(line, inner)} ${edge('│')}` : fitLine(line, width)
    // The top border already shows a heading that fits it; repeating it as the first detail row only
    // costs a row. It stays in the body when the border would clip it or there is nothing else to page.
    const hasInput = question.request.toolCall.rawInput !== undefined
    const details = framed && hasInput && displayWidth(heading) <= inner ? [] : wrapText(heading, inner)
    // What the request would do comes first, painted as it is; the raw input follows as quiet details.
    const tool = meta?.['ai.agnes.harness']?.tool
    details.push(
      ...approvalBody(
        { tool: typeof tool === 'string' ? tool : undefined, args: call.rawInput },
        inner,
        ansi,
        locale,
      ),
    )
    if (hasInput && details.length > 0)
      details.push(ansi.fg('faint', `── ${tt('approval.details', locale)} ──`))
    const headingRows = details.length
    if (hasInput)
      details.push(
        ...wrapText(escapeControl(JSON.stringify(question.request.toolCall.rawInput, null, 2)), inner),
      )
    const choices = question.request.options
    const requested = this.options.maxRows?.()
    const rows =
      requested !== undefined && Number.isFinite(requested)
        ? Math.max(1, Math.trunc(requested))
        : details.length + choices.length + 2
    question.canSelect = rows >= 4
    if (rows < 4) return [fitLine(t('permission.resize', locale), width)]
    const count =
      requested === undefined
        ? choices.length
        : Math.min(choices.length, Math.max(1, Math.floor((rows - 2) / 2)))
    question.count = count
    const start = windowStart(question.selected, count, choices.length)
    const choiceLines = choices.slice(start, start + count).map((option, i) => {
      const index = start + i
      const label = `${index + 1}. ${optionLabel(option, locale)}`
      if (index !== question.selected) return row(`  ${label}`)
      const chosen = fitLine(`${ansi.fg('accent', '❯')} ${ansi.bold(label)}`, inner)
      return row(paintsColour(ansi) ? ansi.bg('selection', chosen) : chosen)
    })
    question.pageRows = Math.max(1, rows - choiceLines.length - 2)
    question.detailOffset = Math.min(question.detailOffset, Math.max(0, details.length - question.pageRows))
    const page = details
      .slice(question.detailOffset, question.detailOffset + question.pageRows)
      .map((line, i) => row(question.detailOffset + i < headingRows ? line : ansi.dim(line)))
    const footer = t('permission.footer', locale, {
      start: question.detailOffset + 1,
      end: question.detailOffset + page.length,
      total: details.length,
    })
    return [
      bar('╭', ansi.bold(heading), '╮'),
      ...page,
      ...choiceLines,
      bar('╰', ansi.fg('faint', footer), '╯'),
    ]
  }
}
