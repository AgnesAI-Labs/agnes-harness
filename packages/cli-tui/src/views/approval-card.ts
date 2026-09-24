import type { UINode } from '@agnes/protocol'
import type { Ansi } from '../ansi.js'
import { type Component, escapeControl } from '../component.js'
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

/**
 * The *persisted projection* of an approval node -- distinct from `PermissionModal` (Task 18), a
 * live, connection-scoped dialog answered in place off `session.onPermissionRequest` while the
 * request is in flight. This card renders whatever `session.projectUI()` currently reports for the
 * node, so it survives detach/reattach and shows up in session history long after the modal that
 * first asked (if any) is gone.
 *
 * Real `UINode` (kind: 'approval') fields are flat on the node -- `ticket` / `expiresAt` / `state` /
 * `decision.verdict` -- not the nested `approval.pending` / `approval.decided` shape an earlier
 * illustrative plan draft assumed (protocol/gen/ts/agnes-v1.ts is authoritative here).
 *
 * Renders through one of three branches, chosen from `n.state` and the presence of `n.ticket`:
 *  - `state: 'decided'` -> a single "already decided" line, whoever/whatever decided it (this
 *    card, the synchronous modal, or a channel surface elsewhere all fold into the same node).
 *  - `state: 'pending'` with a `ticket` -> the parked path: a three-line card (heading, ticket +
 *    expiry, numbered options) where the numbering follows `n.options` itself (converted from ACP
 *    option kinds with `fromAcpOptionKind`), decided by calling back into `onDecide` with the
 *    ticket.
 *  - `state: 'pending'` with no `ticket`, or `state: 'expired'` -> a single, non-interactive line:
 *    the synchronous path's dialog belongs to `PermissionModal`, so this card only echoes the
 *    summary; an expired ticket is shown as a terminal line with no further action possible.
 * A decide call that rejects (typically `-32009 APPROVAL_REJECTED` -- an invalid/expired ticket or
 * a self-approval attempt) flips the card into a fourth, error-carrying line built from the real
 * `JsonRpcError` shape (`.data.reason` / `.data.code`), never a synthetic message.
 */
export class ApprovalCard implements Component {
  private phase: 'pending' | 'deciding' | 'decided' | 'failed'
  private note = ''

  constructor(
    private readonly n: ApprovalNode,
    private readonly o: {
      ansi: Ansi
      locale?: Locale
      onDecide(ticket: string, verdict: Verdict): Promise<void>
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
      this.note = 'expired'
    } else {
      this.phase = 'pending'
    }
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    if (this.phase !== 'pending' || !this.n.ticket || !/^[1-9]$/.test(data)) return false
    const kind = this.n.options[Number(data) - 1]
    if (!kind) return false
    // Persisted approval cards use Agnes' four-option vocabulary. The live PermissionModal remains
    // ACP-only and therefore never maps `allow_always` to this profile-scoped permanent decision.
    const verdict = OPTION_VERDICT[kind]
    const ticket = this.n.ticket
    this.phase = 'deciding'
    void this.o.onDecide(ticket, verdict).then(
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
    // a parked ticket still waits on a keypress.
    if (this.phase === 'decided')
      return [fitLine(`${ansi.fg(78, '✓')} ${summary} -> ${escapeControl(this.note)}`, width)]
    if (this.phase === 'failed')
      return [fitLine(`${ansi.fg(203, '✗')} ${summary} -> ${escapeControl(this.note)}`, width)]
    if (!n.ticket) return [fitLine(`${ansi.fg(178, '⚠')} ${summary}`, width)]
    const locale = this.o.locale ?? 'en'
    const keys = n.options.map((kind, i) => `[${i + 1}] ${t(OPTION_LABEL[kind], locale)}`).join('  ')
    return [
      fitLine(ansi.bold(`${ansi.fg(178, '⚠')} ${t('approval.waiting', locale)}: ${summary}`), width),
      fitLine(
        `ticket ${escapeControl(n.ticket).slice(0, 8)}… · expires ${escapeControl(n.expiresAt ?? 'unknown')}`,
        width,
      ),
      fitLine(this.phase === 'deciding' ? '…' : keys, width),
    ]
  }
}
