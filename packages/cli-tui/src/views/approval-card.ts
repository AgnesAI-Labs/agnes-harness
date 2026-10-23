import type { UINode } from '@agnes/protocol'
import { type Component, escapeControl, wrapText } from '../component.js'
import { fitLine } from '../components/line.js'
import { actionFor } from '../keymap.js'
import { parseKey } from '../keys.js'
import { type Locale, type LocaleKey, t } from '../locale.js'
import { tt } from '../locale-extended.js'
import { paintsColour, type ThemedAnsi } from '../theme.js'
import { approvalBody, approvalHeadline, subjectOf } from './approval-body.js'
import { diffInput } from './diff.js'

type ApprovalNode = Extract<UINode, { kind: 'approval' }>
type ApprovalOption = ApprovalNode['options'][number]

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
              prefix: `\`${escapeControl(prefix.tokens.join(' '))}\``,
            }),
          },
        ]
      : [own]
  })
}

/** A durable approval view; canonical identity and offered options come from the session projection. */
export class ApprovalCard implements Component {
  private phase: 'pending' | 'deciding' | 'decided' | 'failed'
  private note = ''
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
      const by = n.decision?.byLabel ? ` by ${n.decision.byLabel}` : ''
      this.note =
        n.purpose === 'business.confirm' && n.decision?.reason === 'full-access'
          ? `${t('approval.fullAccessBusiness', o.locale ?? 'en')}${n.decision.byLabel ? ` · ${n.decision.byLabel}` : ''}`
          : `${n.decision?.verdict ?? 'decided'}${by}`
    } else if (n.state === 'expired') {
      this.phase = 'failed'
      this.note = n.decision?.reason ?? n.decision?.verdict ?? 'expired'
    } else {
      this.phase = 'pending'
    }
  }

  invalidate(): void {}

  /**
   * `settled`: the card had sat untouched long enough before this key. Until then no key decides
   * and text falls through to the prompt's draft, so typing already under way never lands here.
   * y, a and n are shortcuts for the numbered decisions, and only while the prompt is empty: `a`
   * takes the session scope and does nothing when the card does not list it. A permanent grant is
   * never one letter; it takes its number.
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
    if (!/^[1-9]$/.test(data)) return false
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
    this.phase = 'deciding'
    void (reason === undefined ? this.o.onDecide(ref, verdict) : this.o.onDecide(ref, verdict, reason)).then(
      () => {
        this.phase = 'decided'
        this.note = verdict
        this.o.changed?.()
      },
      (e) => {
        this.phase = 'failed'
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

  private lines(width: number): string[] {
    const n = this.n
    const ansi = this.o.ansi
    const presentation = n.presentation?.[this.o.locale ?? 'en'] ?? n.presentation?.en
    const subject = subjectOf(n)
    const summary = escapeControl(approvalHeadline(presentation?.title ?? n.summary, subject.args))
    const resolved = (tone: 'success' | 'danger', glyph: string) => [
      fitLine(
        `${ansi.fg(tone, glyph)} ${summary} ${ansi.fg('faint', '->')} ${ansi.fg(tone, escapeControl(this.note))}`,
        width,
      ),
    ]
    if (this.phase === 'decided') return resolved('success', '✓')
    if (this.phase === 'failed') return resolved('danger', '✗')
    if (!n.decisionRef) return [fitLine(`${ansi.fg('warning', '▲')} ${summary}`, width)]
    const locale = this.o.locale ?? 'en'
    // A key chip needs a background to read as one; without colour the brackets carry it.
    const lit = this.o.settled?.() ?? true
    const chip = !lit
      ? (key: string) => `[${key}]`
      : paintsColour(ansi)
        ? (key: string) => ansi.bg('accent', ansi.fg('onAccent', ` ${key} `))
        : (key: string) => ansi.bold(`[${key}]`)
    // The single-key shortcut rides after the label: y, a and n on once, session and reject.
    const actions = actionsOf(n, locale)
    const letterOf = (action: Action): string =>
      action.verdict === 'allowed-session'
        ? 'a'
        : action.verdict === 'allowed-once'
          ? 'y'
          : action.verdict === 'rejected'
            ? 'n'
            : ''
    const keys = [
      ...actions.map(
        (action, i) =>
          `${chip(String(i + 1))} ${action.label}${letterOf(action) ? ` (${letterOf(action)})` : ''}`,
      ),
      ...(n.options.includes('reject_once') ? [`${chip('r')} ${t('approval.rejectReason', locale)}`] : []),
    ].join('  ')
    const rail = ansi.fg('warning', '│ ')
    const origin = [
      n.origin?.package && t('approval.from', locale, { value: escapeControl(n.origin.package) }),
      n.origin?.role && t('approval.role', locale, { value: escapeControl(n.origin.role) }),
      n.origin?.mcpServer && t('approval.mcp', locale, { value: escapeControl(n.origin.mcpServer) }),
    ].filter(Boolean)
    const stores = n.grantScopes?.length
      ? wrapText(
          t('approval.stores', locale, { value: n.grantScopes.map(escapeControl).join(', ') }),
          width - 2,
        )
      : []
    return [
      fitLine(
        `${ansi.bold(ansi.fg('warning', `▲ ${t('approval.waiting', locale)}:`))} ${ansi.bold(summary)}`,
        width,
      ),
      fitLine(
        `${rail}${ansi.fg(
          'faint',
          `decision ${escapeControl(n.decisionRef.id).slice(0, 8)}… · expires ${escapeControl(n.expiresAt ?? 'unknown')}`,
        )}`,
        width,
      ),
      ...(origin.length ? [fitLine(`${rail}${ansi.fg('faint', origin.join(' · '))}`, width)] : []),
      ...(presentation?.fields.flatMap((field) =>
        wrapText(
          escapeControl(`${field.label}: ${field.value}${field.href ? ` (${field.href})` : ''}`),
          width - 2,
        ).map((line) => fitLine(`${rail}${line}`, width)),
      ) ?? []),
      ...approvalBody(subject, width - 2, ansi, locale).map((line) => fitLine(`${rail}${line}`, width)),
      // The diff is a reading aid, not the record: the raw subject is what is being approved, so it
      // always stays on the card, set apart under its own heading when a diff came first.
      ...(n.subjectText && subject.tool && diffInput(subject.tool, subject.args)
        ? [fitLine(`${rail}${ansi.fg('faint', `── ${tt('approval.details', locale)} ──`)}`, width)]
        : []),
      ...(n.subjectText
        ? wrapText(escapeControl(n.subjectText), width - 2).map((line) => fitLine(`${rail}${line}`, width))
        : []),
      ...(n.prefixGrant?.runsProjectCode
        ? wrapText(t('approval.projectCode', locale), width - 2).map((line) =>
            fitLine(`${rail}${ansi.fg('faint', line)}`, width),
          )
        : []),
      ...stores.map((line) => fitLine(`${rail}${ansi.fg('faint', line)}`, width)),
      this.reason !== null
        ? fitLine(
            `${rail}${ansi.fg('faint', `${t('approval.reasonPrompt', locale)}: `)}${this.reason}▏`,
            width,
          )
        : fitLine(`${rail}${this.phase === 'deciding' ? '…' : lit ? keys : ansi.dim(keys)}`, width),
    ]
  }
}
