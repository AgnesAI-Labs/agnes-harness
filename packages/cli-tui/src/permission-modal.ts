import type { PermissionOutcome, PermissionRequest } from '@agnes/sdk'
import { createAnsi } from './ansi.js'
import { type Component, escapeVisible, wrapText } from './component.js'
import { keyHints } from './components/key-hints.js'
import { columns, fitLine } from './components/line.js'
import { actionFor } from './keymap.js'
import { parseKey } from './keys.js'
import { type Locale, t } from './locale.js'
import { tt } from './locale-extended.js'
import { displayWidth } from './terminal.js'
import { paintsColour, type ThemedAnsi, TuiTheme } from './theme.js'
import { approvalBody, approvalHeading, approvalHeadline, keycap, wrapKeep } from './views/approval-body.js'

type Question = {
  id: number
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
  if (option.kind === 'allow_always') return t('approval.allowSession', locale)
  if (option.kind === 'reject_once') return t('approval.reject', locale)
  if (option.kind === 'reject_always') return tt('approval.rejectAlways', locale)
  return escapeVisible(option.name)
}

/** FIFO prompts own input until answered; Enter initially selects rejection. */
export class PermissionModal implements Component {
  private readonly questions: Question[] = []
  private closed = false
  private asked = 0
  constructor(
    private readonly changed: () => void,
    private readonly options: {
      maxRows?(): number
      locale?: Locale
      ansi?: ThemedAnsi
      /** Whether single keys would count now; the key hints on the options dim until they do. */
      settled?(): boolean
      /** Whether y, a and n may decide: not while the prompt holds a draft, where they are text. */
      letters?(): boolean
    } = {},
  ) {}

  /** Identifies the question in front, so a new one restarts the misclick guard. */
  get head(): string | undefined {
    const id = this.questions[0]?.id
    return id === undefined ? undefined : `ask:${id}`
  }

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
        id: this.asked++,
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

  /**
   * `settled` is whether the card had sat untouched long enough before this key (approval-settle.ts);
   * left out, the guard is asked now, which is how the root's own dispatch to its children sees it.
   * Until then only Esc, scrolling and moving the selection work; text falls through to the prompt's
   * draft and Enter does nothing.
   */
  handleInput(data: string, settled = this.options.settled?.() ?? true): boolean {
    const question = this.questions[0]
    if (!question) return false
    const key = parseKey(data, false)
    const options = question.request.options
    const action = actionFor('approval', key.name === 'char' ? (key.ch ?? '') : key.name)
    if (!settled && action !== 'approval-dismiss') {
      if (key.name === 'char' || key.name === 'paste') return false
      if (!action?.match(/^approval-(up|down|page-up|page-down)$/)) return true
    }
    if (key.name === 'char' && /^[a-z]$/.test(key.ch ?? '') && !(this.options.letters?.() ?? true))
      return false
    if (action === 'approval-dismiss') question.finish({ unanswered: 'detached' })
    // `a` decides nothing here: the scope of an agent's "always allow" is the agent's, so it takes its number.
    else if (action === 'approval-allow-always') return true
    else if (action === 'approval-allow-once' || action === 'approval-reject') {
      const kind = action === 'approval-reject' ? 'reject_once' : 'allow_once'
      const index = options.findIndex((option) => option.kind === kind)
      const option = options[index]
      if (option && (kind === 'reject_once' || this.shown(question, index)))
        question.finish({ optionId: option.optionId })
    } else if (action === 'approval-confirm') {
      const option = options[question.selected]
      if (!option || option.kind === 'reject_once' || option.kind === 'reject_always')
        question.finish(option ? { optionId: option.optionId } : { unanswered: 'detached' })
      else if (this.shown(question, question.selected)) question.finish({ optionId: option.optionId })
    } else if (key.name === 'char' && /^[1-9]$/.test(key.ch ?? '')) {
      const option = options[Number(key.ch) - 1]
      if (option && (option.kind.startsWith('reject_') || this.shown(question, Number(key.ch) - 1)))
        question.finish({ optionId: option.optionId })
    } else if (action === 'approval-page-up' || action === 'approval-page-down') {
      question.detailOffset = Math.max(
        0,
        question.detailOffset + (action === 'approval-page-up' ? -1 : 1) * question.pageRows,
      )
      this.changed()
    } else if (action === 'approval-up' || action === 'approval-down') {
      question.selected = Math.max(
        0,
        Math.min(options.length - 1, question.selected + (action === 'approval-up' ? -1 : 1)),
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
    const name = escapeVisible(headline || t('permission.toolRequest', locale))
    const heading = approvalHeading(name, undefined, ansi, locale)
    const headingWidth = displayWidth(`▲ ${tt('approval.needs', locale)} · ${name}`)
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
    const details = framed && hasInput && headingWidth <= inner ? [] : wrapText(name, inner)
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
        ...wrapKeep(escapeVisible(JSON.stringify(question.request.toolCall.rawInput, null, 2)), inner),
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
    // The single-key shortcut of the option each belongs to; `a` is deliberately absent (see handleInput).
    const showLetters = this.options.letters?.() ?? true
    const letters = new Map<number, string>(
      [
        ['allow_once', 'y'],
        ['reject_once', 'n'],
      ].map(([kind, letter]) => [choices.findIndex((option) => option.kind === kind), letter as string]),
    )
    const lit = this.options.settled?.() ?? true
    const chip = keycap(ansi, lit)
    const labels = choices.map((option) => optionLabel(option, locale))
    const column = Math.max(
      0,
      ...choices.map((_, i) => (letters.has(i) ? displayWidth(labels[i] as string) : 0)),
    )
    const choiceLines = choices.slice(start, start + count).map((_, i) => {
      const index = start + i
      const letter = showLetters ? letters.get(index) : undefined
      const label = labels[index] as string
      const gap = letter
        ? `${' '.repeat(Math.max(0, column - displayWidth(label)))}  ${ansi.fg('faint', letter)}`
        : ''
      if (index !== question.selected) return row(`  ${chip(String(index + 1))} ${label}${gap}`)
      const tail = fitLine(
        ` ${ansi.bold(label)}${gap}`,
        Math.max(0, inner - 2 - displayWidth(chip(String(index + 1)))),
      )
      const mark = `${ansi.fg('accent', '❯')} `
      return row(
        paintsColour(ansi)
          ? `${ansi.bg('selection', mark)}${chip(String(index + 1))}${ansi.bg('selection', tail)}`
          : `${mark}${chip(String(index + 1))}${tail}`,
      )
    })
    question.pageRows = Math.max(1, rows - choiceLines.length - 2)
    question.detailOffset = Math.min(question.detailOffset, Math.max(0, details.length - question.pageRows))
    const page = details
      .slice(question.detailOffset, question.detailOffset + question.pageRows)
      .map((line, i) => row(question.detailOffset + i < headingRows ? line : ansi.dim(line)))
    const hints = keyHints(
      [
        // Only while something is off the page. First, so a narrow border keeps it beside esc: what is
        // being approved must stay reachable.
        ...(page.length < details.length
          ? [
              {
                key: 'pgup/pgdn',
                label: tt('permission.hint.details', locale, {
                  start: question.detailOffset + 1,
                  end: question.detailOffset + page.length,
                  total: details.length,
                }),
              },
            ]
          : []),
        { key: '↑↓', label: tt('permission.hint.select', locale) },
        { key: '⏎', label: tt('permission.hint.confirm', locale) },
        { key: 'esc', label: tt('permission.hint.close', locale) },
      ],
      ansi,
      width - 4,
    )
    return [bar('╭', heading, '╮'), ...page, ...choiceLines, bar('╰', hints, '╯')]
  }
}
