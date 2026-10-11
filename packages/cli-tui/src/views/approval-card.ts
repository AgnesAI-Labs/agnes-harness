import type { UINode } from '@agnes/protocol'
import type { Ansi } from '../ansi.js'
import { type Component, escapeControl, wrapText } from '../component.js'
import { fitLine } from '../components/line.js'
import { type Locale, type LocaleKey, t } from '../locale.js'

type ApprovalNode = Extract<UINode, { kind: 'approval' }>
type ApprovalOption = ApprovalNode['options'][number]

/** The wire's own decide-verdict vocabulary (sdk plan `Client.approval.decide`, `_agnes/v1/approval.decide`). */
export type Verdict = 'allowed-once' | 'allowed-session' | 'allowed-permanent' | 'rejected'

const OPTION_LABEL: Record<ApprovalOption, LocaleKey> = {
  allow_once: 'approval.allowOnce',
  allow_always: 'approval.allowSession',
  allow_permanent: 'approval.allowPermanent',
  reject_once: 'approval.reject',
}
const OPTION_VERDICT: Record<ApprovalOption, Verdict> = {
  allow_once: 'allowed-once',
  allow_always: 'allowed-session',
  allow_permanent: 'allowed-permanent',
  reject_once: 'rejected',
}

/** A durable approval view; canonical identity and offered options come from the session projection. */
export class ApprovalCard implements Component {
  private phase: 'pending' | 'deciding' | 'decided' | 'failed'
  private note = ''

  constructor(
    private readonly n: ApprovalNode,
    private readonly o: {
      ansi: Ansi
      locale?: Locale
      onDecide(ref: NonNullable<ApprovalNode['decisionRef']>, verdict: Verdict): Promise<void>
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
      this.note = `${n.decision?.verdict ?? 'decided'}${by}`
    } else if (n.state === 'expired') {
      this.phase = 'failed'
      this.note = n.decision?.reason ?? n.decision?.verdict ?? 'expired'
    } else {
      this.phase = 'pending'
    }
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (this.phase !== 'pending' || !this.n.decisionRef || !/^[1-9]$/.test(data)) return false
    const kind = this.n.options[Number(data) - 1]
    if (!kind) return false
    // Persisted approval cards use Agnes' four-option vocabulary. The live PermissionModal remains
    // ACP-only and therefore never maps `allow_always` to this profile-scoped permanent decision.
    const verdict = OPTION_VERDICT[kind]
    const ref = this.n.decisionRef
    this.phase = 'deciding'
    void this.o.onDecide(ref, verdict).then(
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

  render(width: number): string[] {
    const n = this.n
    const ansi = this.o.ansi
    const summary = escapeControl(n.summary)
    // Verdict glyph coloured by outcome: green once decided, red on failure/expiry, yellow while
    // a durable request still waits on a keypress.
    if (this.phase === 'decided')
      return [fitLine(`${ansi.fg(78, '✓')} ${summary} -> ${escapeControl(this.note)}`, width)]
    if (this.phase === 'failed')
      return [fitLine(`${ansi.fg(203, '✗')} ${summary} -> ${escapeControl(this.note)}`, width)]
    if (!n.decisionRef) return [fitLine(`${ansi.fg(178, '⚠')} ${summary}`, width)]
    const locale = this.o.locale ?? 'en'
    const keys = n.options.map((kind, i) => `[${i + 1}] ${t(OPTION_LABEL[kind], locale)}`).join('  ')
    return [
      fitLine(ansi.bold(`${ansi.fg(178, '⚠')} ${t('approval.waiting', locale)}: ${summary}`), width),
      fitLine(
        `decision ${escapeControl(n.decisionRef.id).slice(0, 8)}… · expires ${escapeControl(n.expiresAt ?? 'unknown')}`,
        width,
      ),
      ...(n.subjectText
        ? wrapText(escapeControl(n.subjectText), width).map((line) => fitLine(line, width))
        : []),
      fitLine(this.phase === 'deciding' ? '…' : keys, width),
    ]
  }
}
