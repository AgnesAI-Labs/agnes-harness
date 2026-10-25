import type { UINode } from '@agnes/protocol'
import { type Component, escapeControl, escapeVisible, wrapText } from '../component.js'
import { keyHints } from '../components/key-hints.js'
import { fitLine } from '../components/line.js'
import { actionFor } from '../keymap.js'
import { parseKey } from '../keys.js'
import { type Locale, type LocaleKey, t } from '../locale.js'
import { type ExtendedKey, tt } from '../locale-extended.js'
import { displayWidth } from '../terminal.js'
import type { ThemedAnsi } from '../theme.js'
import {
  approvalBody,
  approvalHeading,
  approvalHeadline,
  keycap,
  localTime,
  shellOf,
  subjectOf,
  wrapKeep,
} from './approval-body.js'

type ApprovalNode = Extract<UINode, { kind: 'approval' }>

/** The wire's own decide-verdict vocabulary (sdk plan `Client.approval.decide`, `_agnes/v1/approval.decide`). */
export type Verdict =
  | 'allowed-once'
  | 'allowed-session'
  | 'allowed-permanent'
  | 'allow_prefix_session'
  | 'rejected'

const OPTION_LABEL: Partial<Record<string, LocaleKey>> = {
  allow_once: 'approval.allowOnce',
  allow_always: 'approval.allowSession',
  allow_permanent: 'approval.allowPermanent',
  reject_once: 'approval.reject',
}
const OPTION_VERDICT: Partial<Record<string, Verdict>> = {
  allow_once: 'allowed-once',
  allow_always: 'allowed-session',
  allow_permanent: 'allowed-permanent',
  reject_once: 'rejected',
}

type Action = { verdict: Verdict; label: string }

/** The verdicts whose single key (y, a, n) shows beside them. */
const LETTERED: Partial<Record<Verdict, true>> = {
  'allowed-once': true,
  'allowed-session': true,
  rejected: true,
}
/** What the finished line says for each verdict the wire uses; any other token is shown as it came. */
const DID_LABEL: Partial<Record<string, ExtendedKey>> = {
  'allowed-once': 'approval.did.allowedOnce',
  'allowed-session': 'approval.did.allowedSession',
  'allowed-permanent': 'approval.did.allowedPermanent',
  allow_prefix_session: 'approval.did.allowedPrefix',
  rejected: 'approval.did.rejected',
}

/** The most characters of a rejection reason the card collects; Core cuts to the same bound. */
export const REASON_MAX = 500
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are stripped on purpose
const REASON_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
const cleanReason = (text: string): string => text.replace(REASON_CONTROL, ' ')

/**
 * What the card offers, in order: the option kinds it knows (an unknown one from a newer daemon is
 * skipped, never shown unlabelled or answered blind) and, right after "allow once", Core's offered
 * command prefix. The tokens are Core's; the card never derives a prefix of its own.
 */
function actionsOf(n: ApprovalNode, locale: Locale): Action[] {
  const prefix = n.state === 'pending' ? n.prefixGrant : undefined
  return n.options.flatMap((kind): Action[] => {
    const key = OPTION_LABEL[kind]
    const verdict = OPTION_VERDICT[kind]
    if (!key || !verdict) return []
    const own: Action = { verdict, label: t(key, locale) }
    return kind === 'allow_once' && prefix
      ? [
          own,
          {
            verdict: 'allow_prefix_session',
            label: t('approval.allowPrefix', locale, {
              prefix: `\`${escapeVisible(prefix.tokens.join(' '))}\``,
            }),
          },
        ]
      : [own]
  })
}

/** A durable approval view; canonical identity and offered options come from the session projection. */
export class ApprovalCard implements Component {
  private phase: 'pending' | 'deciding' | 'decided' | 'failed'
  /** What the finished line adds after the summary: who decided, the reason, or why it failed. */
  private note = ''
  /** The verdict token that decided this card (the wire's, from the node or from this card's own key). */
  private verdict: string | undefined
  private by: string | undefined
  /** The line's own wording when no verdict says it (a business confirm that full access settled). */
  private custom: string | undefined
  private expired = false
  /** The rejection reason being typed, or null while the card shows its options. */
  private reason: string | null = null

  get pending(): boolean {
    return this.phase === 'pending'
  }

  /** Which decision this card asks for; a different one restarts the misclick guard. */
  get key(): string | undefined {
    const ref = this.n.decisionRef
    return this.phase === 'pending' && ref ? `${ref.id}:${ref.revision}` : undefined
  }

  constructor(
    private readonly n: ApprovalNode,
    private readonly o: {
      ansi: ThemedAnsi
      locale?: Locale
      /** Whether single keys would count now (approval-settle.ts); the key hints dim until they do. */
      settled?(): boolean
      /** Whether y, a, n and r may decide: not while the prompt holds a draft, where they are text. */
      letters?(): boolean
      /** Whether the live dialog is asking now: it takes every key, so a pending card says to answer there. */
      dialog?(): boolean
      onDecide(
        ref: NonNullable<ApprovalNode['decisionRef']>,
        verdict: Verdict,
        reason?: string,
      ): Promise<void>
      /**
       * Called after the decide call settles (success or failure), never before. `handleInput`'s
       * own synchronous return already earns this card its next paint for the "deciding…" line
       * (the renderer repaints once per input that a component consumed) but the settlement
       * itself lands later, off a microtask the input loop is not watching -- without this hook
       * a rejection (no new ledger event ever arrives for it) would flip `phase` to `'failed'`
       * with nothing to ever ask the renderer to look again.
       */
      changed?(): void
    },
  ) {
    if (n.state === 'decided') {
      this.phase = 'decided'
      this.verdict = n.decision?.verdict
      this.by = n.decision?.byLabel
      if (n.purpose === 'business.confirm' && n.decision?.reason === 'full-access')
        this.custom = t('approval.fullAccessBusiness', o.locale ?? 'en')
      else if (n.decision?.reason && /^(reject|den)/.test(this.verdict ?? '')) this.note = n.decision.reason
    } else if (n.state === 'expired') {
      this.phase = 'failed'
      this.expired = true
      const reason = n.decision?.reason
      this.note = reason && reason !== 'expired' ? reason : ''
    } else {
      this.phase = 'pending'
    }
  }

  invalidate(): void {}

  /**
   * `settled`: the card had sat untouched long enough before this key. Until then no key decides
   * and text falls through to the prompt's draft, so typing already under way never lands here.
   * y, a and n are shortcuts for the numbered decisions. Letters and numbers alike count only while
   * the prompt is empty: a digit typed into a draft after a pause is part of the draft, not a grant.
   * `a` takes the session scope and does nothing when the card does not list it. A permanent grant
   * is never one letter; it takes its number.
   */
  handleInput(data: string, settled = this.o.settled?.() ?? true): boolean {
    if (this.phase !== 'pending' || !this.n.decisionRef) return false
    if (this.reason !== null) return this.typeReason(data)
    if (!settled) return false
    const actions = actionsOf(this.n, this.o.locale ?? 'en')
    const letters = this.o.letters?.() ?? true
    const letter = letters ? actionFor('approval', data) : undefined
    if (letter === 'approval-allow-once') return this.decide('allowed-once')
    if (letter === 'approval-allow-always')
      return actions.some((a) => a.verdict === 'allowed-session') ? this.decide('allowed-session') : true
    if (letter === 'approval-reject')
      return this.n.options.includes('reject_once') ? this.decide('rejected') : true
    if (letters && data === 'r' && this.n.options.includes('reject_once')) {
      this.reason = ''
      return true
    }
    if (!letters || !/^[1-9]$/.test(data)) return false
    const action = actions[Number(data) - 1]
    if (!action) return false
    return this.decide(action.verdict)
  }

  /** One line of text for the model: Enter rejects with it (blank is a plain reject), Esc goes back. */
  private typeReason(data: string): boolean {
    const key = parseKey(data, false)
    if (key.name === 'esc') this.reason = null
    else if (key.name === 'enter') return this.decide('rejected', this.reason?.trim() || undefined)
    else if (key.name === 'backspace') this.reason = [...(this.reason ?? '')].slice(0, -1).join('')
    else if (key.name === 'char' || key.name === 'paste') {
      const text = cleanReason(key.ch ?? '')
      // A control key (ctrl-c and the like) is not text: it falls through to its usual owner.
      if (key.name === 'char' && text !== key.ch) return false
      this.reason = [...`${this.reason ?? ''}${text}`].slice(0, REASON_MAX).join('')
    } else return false
    return true
  }

  private decide(verdict: Verdict, reason?: string): boolean {
    if (!this.n.decisionRef) return false
    // Persisted approval cards use Agnes' four-option vocabulary. The live PermissionModal remains
    // ACP-only and therefore never maps `allow_always` to this profile-scoped permanent decision.
    const ref = this.n.decisionRef
    this.reason = null
    this.note = ''
    this.phase = 'deciding'
    void (reason === undefined ? this.o.onDecide(ref, verdict) : this.o.onDecide(ref, verdict, reason)).then(
      () => {
        this.phase = 'decided'
        this.verdict = verdict
        this.note = reason ?? ''
        this.o.changed?.()
      },
      (e) => {
        // The daemon node is still pending and the command id is idempotent: stay answerable.
        this.phase = 'pending'
        const data = (e as { data?: { reason?: string; code?: string } } | undefined)?.data
        this.note =
          data?.reason ?? data?.code ?? (e as Error | undefined)?.message ?? 'approval.decide failed'
        this.o.changed?.()
      },
    )
    return true
  }

  /** Inset one column so the card lines up with the tool cards and user messages around it. */
  render(width: number): string[] {
    return this.lines(Math.max(1, width - 1)).map((line) => ` ${line}`)
  }

  /** The finished line: what happened (localized), the request, then who decided and why. */
  private resolvedLine(summary: string, width: number): string {
    const ansi = this.o.ansi
    const locale = this.o.locale ?? 'en'
    const verdict = this.verdict ?? ''
    const known = DID_LABEL[verdict]
    const rejected = /^(reject|den)/.test(verdict)
    const [glyph, tone, label] = this.expired
      ? ['◌', 'faint', tt('approval.did.expired', locale)]
      : this.phase === 'failed'
        ? ['✗', 'danger', tt('approval.did.failed', locale)]
        : [
            rejected ? '✗' : '✓',
            rejected ? 'danger' : 'success',
            this.custom ?? (known ? tt(known, locale) : escapeControl(verdict || 'decided')),
          ]
    const extras = [
      this.by && tt('approval.by', locale, { name: escapeVisible(this.by) }),
      this.note && escapeControl(this.note),
    ].filter(Boolean)
    const dot = ansi.fg('faint', '·')
    return fitLine(
      [
        ansi.fg(tone as 'faint', `${glyph} ${label}`),
        summary,
        ...extras.map((e) => ansi.fg('faint', String(e))),
      ].join(` ${dot} `),
      width,
    )
  }

  private lines(width: number): string[] {
    const n = this.n
    const ansi = this.o.ansi
    const locale = this.o.locale ?? 'en'
    const presentation = n.presentation?.[locale] ?? n.presentation?.en
    const subject = subjectOf(n)
    const summary = escapeVisible(approvalHeadline(presentation?.title ?? n.summary, subject.args))
    if (this.phase === 'decided' || this.phase === 'failed') return [this.resolvedLine(summary, width)]
    if (!n.decisionRef) return [fitLine(`${ansi.fg('warning', '▲')} ${summary}`, width)]
    const lit = (this.o.settled?.() ?? true) && (this.o.letters?.() ?? true)
    const chip = keycap(ansi, lit)
    const rail = ansi.raw ? '' : ansi.fg('warning', '│ ')
    const inner = width - 2
    const row = (line: string) => fitLine(`${rail}${line}`, width)
    // One option per row: the chip, the label and, where that single key works now, its letter.
    const actions = actionsOf(n, locale)
    const letterOf = (action: Action): string =>
      !(this.o.letters?.() ?? true)
        ? ''
        : action.verdict === 'allowed-session'
          ? 'a'
          : action.verdict === 'allowed-once'
            ? 'y'
            : action.verdict === 'rejected'
              ? 'n'
              : ''
    const lettered = actions.filter((a) => a.verdict in LETTERED)
    const column = Math.max(0, ...lettered.map((a) => displayWidth(a.label)))
    const option = (key: string, label: string, letter = '', pad = 0): string[] => {
      const [first = '', ...rest] = wrapText(label, Math.max(1, inner - 4))
      const gap = letter
        ? `${' '.repeat(Math.max(0, pad - displayWidth(first)))}  ${ansi.fg('faint', letter)}`
        : ''
      const rows = [`${chip(key)} ${first}${rest.length === 0 ? gap : ''}`, ...rest.map((r) => `    ${r}`)]
      return rows.map((r) => row(lit ? r : ansi.dim(r)))
    }
    const options = [
      ...actions.flatMap((action, i) => option(String(i + 1), action.label, letterOf(action), column)),
      ...(n.options.includes('reject_once') ? option('r', t('approval.rejectReason', locale)) : []),
    ]
    const origin = [
      n.origin?.package && t('approval.from', locale, { value: escapeVisible(n.origin.package) }),
      n.origin?.role && t('approval.role', locale, { value: escapeVisible(n.origin.role) }),
      n.origin?.mcpServer && t('approval.mcp', locale, { value: escapeVisible(n.origin.mcpServer) }),
    ].filter(Boolean)
    const stores = n.grantScopes?.length
      ? wrapText(t('approval.stores', locale, { value: n.grantScopes.map(escapeVisible).join(', ') }), inner)
      : []
    // The command already has its own row; a summary that only repeats it would say the same twice.
    const command = shellOf(subject.args)?.command
    const heading = fitLine(approvalHeading(subject.tool, subject.risk ?? n.risk, ansi, locale), width)
    const said = summary && summary !== command?.trim() ? [row(ansi.bold(summary))] : []
    // The dialog shows this request in full and owns the keys; a second copy here only pushes it away.
    if (this.o.dialog?.()) return [heading, ...said, row(ansi.fg('faint', tt('approval.inDialog', locale)))]
    const raw = n.subjectText ? wrapKeep(escapeVisible(n.subjectText), inner) : []
    const expires = localTime(n.expiresAt)
    const reasonRows = (reason: string): string[] => {
      const label = `${tt('approval.reasonLabel', locale)}: `
      // The tail of what was typed stays visible, so the caret never leaves the row.
      let shown = [...escapeControl(reason)]
      while (shown.length > 0 && displayWidth(label + shown.join('')) > inner - 1) shown = shown.slice(1)
      return [
        row(`${ansi.fg('faint', label)}${shown.join('')}▏`),
        row(
          keyHints(
            [
              { key: '⏎', label: tt('approval.hint.reject', locale) },
              { key: 'esc', label: tt('approval.hint.back', locale) },
            ],
            ansi,
            inner,
          ),
        ),
      ]
    }
    // Core puts a content reference in place of input too large or too deep to carry; then nothing
    // on the card shows what would run, and the bold line is the model's own description of it.
    const args = subject.args as Record<string, unknown> | undefined
    const unseen =
      args !== null && typeof args === 'object' && Object.keys(args).length === 1 && 'contentRef' in args
        ? wrapText(tt('approval.argsUnseen', locale), inner).map((line) => row(ansi.fg('danger', line)))
        : []
    return [
      heading,
      ...said,
      ...unseen,
      ...(origin.length ? [row(ansi.fg('faint', origin.join(' · ')))] : []),
      ...approvalBody(subject, inner, ansi, locale).map(row),
      ...(presentation?.fields.flatMap((field) =>
        wrapText(
          escapeVisible(`${field.label}: ${field.value}${field.href ? ` (${field.href})` : ''}`),
          inner,
        ).map(row),
      ) ?? []),
      // The raw subject is what is being approved, so it always stays on the card under its own
      // heading; a diff or a command row above it is only the reading aid.
      ...(raw.length ? [row(ansi.fg('faint', `── ${tt('approval.details', locale)} ──`))] : []),
      ...raw.map((line) => row(ansi.dim(line))),
      ...(n.prefixGrant?.runsProjectCode
        ? wrapText(t('approval.projectCode', locale), inner).map((line) => row(ansi.fg('faint', line)))
        : []),
      ...stores.map((line) => row(ansi.fg('faint', line))),
      ...(this.reason === null && this.note
        ? [row(ansi.fg('danger', `✗ ${tt('approval.did.failed', locale)} · ${escapeControl(this.note)}`))]
        : []),
      ...(this.reason !== null ? reasonRows(this.reason) : this.phase === 'deciding' ? [row('…')] : options),
      ...(this.reason === null && this.phase !== 'deciding' && expires
        ? [row(ansi.fg('faint', tt('approval.expires', locale, { time: expires })))]
        : []),
    ]
  }
}
