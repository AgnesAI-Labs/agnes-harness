import type { AppSessionContext } from '../app.js'
import type { SessionControlStateResult } from '@agnes/protocol/gen/agnes-v1'
import { type UITurn } from '@agnes/protocol'
import { sessionLoopSelection } from '@agnes/web-admin/admin/plugins/session-loop'
import type { ApprovalAction } from '@agnes/web-conversation/approval'
import { approvalToolName, liveApprovalCard } from '@agnes/web-conversation/approval-card'
import {
  APPROVAL_SEARCH_PAGES,
  approvalOutsideWindow,
  findApproval,
} from '@agnes/web-conversation/live-projection'
import { rememberWebComposer } from '../composer-memory.js'
import { sessionTitle } from '../session-title.js'
import { durableApprovalActions, nodeText, type WebView, webView } from '../view.js'

export function createTurnController(
  context: Pick<
    AppSessionContext,
    | 'TRACE_THROTTLE_MS'
    | 'approvalBusy'
    | 'approvalRuntime'
    | 'approvalSearch'
    | 'approvalSearchTicket'
    | 'awaitingPromptStart'
    | 'client'
    | 'connected'
    | 'conversationRuntime'
    | 'current'
    | 'initialModelPending'
    | 'initialPermissionPending'
    | 'knownSessionModel'
    | 'live'
    | 'liveApproval'
    | 'modelChangePending'
    | 'modelSelectionSeq'
    | 'permissionChangePending'
    | 'permissionMode'
    | 'permissionRefreshPending'
    | 'permissionSelectionSeq'
    | 'projection'
    | 'receipts'
    | 'renderControls'
    | 'renderer'
    | 'run'
    | 'sending'
    | 'sessionControls'
    | 'sessionRows'
    | 'sessionTitles'
    | 'sessionYoloEnabled'
    | 'showError'
    | 'stopAfterSeq'
    | 'stopping'
    | 't'
    | 'topbarRuntime'
    | 'tracePaintedAt'
    | 'tracePanel'
    | 'tracePending'
    | 'traceTrailing'
    | 'updateTitle'
    | 'windowAtStart'
  >,
) {
  function render(): void {
    if (!context.projection) {
      context.topbarRuntime.setStatus(context.t('app.status.newTask'))
      context.tracePanel.render([], [])
      context.renderControls()
      return
    }
    // 会话切换的尾流（旧审批收尾、事件竞态）可能在这时触发渲染，而投影仍属于
    // 上一会话：此时屏幕上保留的正是上一会话画面，任何重绘都会把旧投影的
    // 模型、标题、审批卡写进新会话的控件。等投影换代后再渲染。
    if (!context.current || context.projection.sessionId !== context.current.id) return
    if (
      typeof context.projection.yolo === 'boolean' &&
      !context.permissionChangePending &&
      !context.permissionRefreshPending &&
      context.projection.upto >= context.permissionSelectionSeq
    ) {
      context.sessionYoloEnabled = context.projection.yolo
      if (context.initialPermissionPending === undefined)
        context.permissionMode = context.projection.yolo
          ? 'full'
          : context.permissionMode === 'view'
            ? 'view'
            : 'workspace'
    }
    if (
      context.projection.usage?.model &&
      !context.modelChangePending &&
      !context.initialModelPending &&
      context.projection.upto >= context.modelSelectionSeq
    ) {
      context.knownSessionModel = {
        route: context.projection.usage.model.route,
        id: context.projection.usage.model.id,
        settings: context.projection.usage.model.settings ?? {
          contextWindow: context.projection.usage.context.window,
          thinking: context.projection.usage.model.thinking,
        },
      }
      rememberWebComposer({ model: context.knownSessionModel })
    }
    const receipt = context.current ? context.receipts.get(context.current.id) : undefined
    const view = webView(context.projection, receipt, context.t)
    if (
      !view.busy &&
      receipt?.reason &&
      context.liveApproval &&
      receipt.endSeq > context.liveApproval.afterSeq
    ) {
      // A real later terminal invalidates this live request; no cancelled task keeps an approval card.
      context.liveApproval.finish({ verdict: 'rejected' })
      return
    }
    const firstInput = context.windowAtStart ? view.nodes.find((node) => node.kind === 'user') : undefined
    const selectedId = context.current?.id
    const title = sessionTitle(
      selectedId
        ? (context.sessionTitles.get(selectedId) ??
            context.sessionRows.find((row) => row.sessionId === selectedId)?.title)
        : undefined,
      firstInput ? nodeText(firstInput) : undefined,
    )
    context.topbarRuntime.setTaskTitle(title)
    if (firstInput && context.current) {
      context.updateTitle(context.current.id, title)
    }
    if (context.awaitingPromptStart && view.busy) {
      context.awaitingPromptStart = false
      context.sending = false
    }
    if (!view.busy && receipt?.reason && receipt.endSeq > context.stopAfterSeq) context.stopping = false
    context.topbarRuntime.setStatus(
      context.stopping
        ? context.t('app.status.stoppingWait')
        : context.liveApproval
          ? context.t('app.status.awaitingApproval')
          : view.status,
      view.busy ? 'running' : (receipt?.reason ?? 'idle'),
    )
    const meta = transcriptMeta()
    context.renderer.render(view.nodes, context.projection.turns, meta)
    renderTrace(view, context.projection.turns, meta)
    if (approvalOutsideWindow(context.projection)) {
      const ticket = context.projection.opState?.parked?.ticket
      // A different parked approval is looked for afresh.
      if (ticket !== context.approvalSearchTicket && context.approvalSearch !== 'searching')
        context.approvalSearch = 'idle'
      context.approvalSearchTicket = ticket
      searchApproval(APPROVAL_SEARCH_PAGES)
    } else context.approvalSearch = 'idle'
    renderApproval()
    context.renderControls()
  }

  function renderApproval(): void {
    const durable = context.projection
      ? webView(context.projection, undefined, context.t).approval
      : undefined
    const parked =
      !context.liveApproval && !durable && context.projection ? context.projection.opState?.parked : undefined
    if (parked && context.approvalSearch !== 'idle') {
      const stick = context.conversationRuntime.isTranscriptNearBottom()
      const searching = context.approvalSearch === 'searching'
      // The approval's own node, with the options it really offers, is before the loaded window; a
      // verdict can only be given there, so this card only leads to it.
      context.approvalRuntime.render({
        key: `parked:${parked.ticket}`,
        title: searching ? context.t('app.approval.searching') : context.t('app.approval.parkedTitle'),
        summary: context.t('app.approval.parkedSummary', { expiresAt: parked.expiresAt }),
        impact: searching
          ? context.t('app.approval.searchingImpact')
          : context.t('app.approval.locateImpact'),
        actions: searching
          ? []
          : [{ id: 'locate', label: context.t('app.approval.locate'), onSelect: () => searchApproval() }],
        disabled: !context.connected,
      })
      if (stick) context.renderer.pinToBottom()
      return
    }
    const key = context.liveApproval
      ? `live:${context.liveApproval.request.toolCall.toolCallId}`
      : (durable?.ticket ?? '')
    // 审批卡是会话区外的流内兄弟：显示/收回都会改变 #transcript 的视口高度。
    // 原本贴底的会话要保持贴底，否则最新过程被压出可视区、贴底跟随也会被破坏。
    const stick = context.conversationRuntime.isTranscriptNearBottom()
    if (!key) {
      context.approvalRuntime.render(undefined)
      if (stick) context.renderer.pinToBottom()
      return
    }

    const liveTitle = context.liveApproval?.request.toolCall.title
    const summary =
      typeof liveTitle === 'string'
        ? liveTitle
        : (durable?.summary ?? context.t('app.approval.defaultSummary'))
    const risks = {
      destructive: context.t('app.risk.destructive'),
      always: context.t('app.risk.always'),
      budget: context.t('app.risk.budget'),
      unknown: context.t('app.risk.unknown'),
    }
    const card = context.liveApproval
      ? liveApprovalCard(context.liveApproval.request.toolCall, context.t)
      : undefined
    const impact = durable ? risks[durable.risk] : (card?.impact ?? context.t('app.approval.toolImpact'))
    const actions: ApprovalAction[] = []
    const decide = (id: string, label: string, action: () => Promise<void>): void => {
      actions.push({
        id,
        label,
        onSelect: () =>
          context.run(async () => {
            if (context.approvalBusy || context.stopping) return
            context.approvalBusy = true
            renderApproval()
            try {
              await action()
            } finally {
              context.approvalBusy = false
              context.live?.refresh()
              renderApproval()
            }
          }),
      })
    }
    if (context.liveApproval) {
      const request = context.liveApproval
      const labels: Record<string, string> = {
        allow_once: context.t('app.approval.allowOnce'),
        reject_once: context.t('app.approval.rejectOnce'),
        reject_always: context.t('app.approval.rejectAlways'),
        // Absent when the card cannot show the whole call: that choice would also cover later calls.
        ...(card?.sessionLabel === undefined ? {} : { allow_always: card.sessionLabel }),
      }
      for (const option of request.request.options) {
        if (option.name === 'allow_always' && labels.allow_always === undefined) continue
        decide(`live:${option.name}`, labels[option.name] ?? option.name, async () =>
          request.finish({ optionId: option.optionId }),
        )
      }
    } else if (durable?.ticket) {
      const ticket = durable.ticket
      for (const { label, verdict } of durableApprovalActions(durable, context.t))
        decide(
          `durable:${verdict}`,
          label,
          async () => void (await context.client.approval.decide(ticket, verdict, { kind: 'local' })),
        )
    }
    const planApproval = context.liveApproval
      ? approvalToolName(context.liveApproval.request.toolCall) === 'exit_plan_mode'
      : context.projection?.nodes.some(
          (node) =>
            node.kind === 'tool' && node.name === 'exit_plan_mode' && node.status === 'awaiting_approval',
        )
    context.approvalRuntime.render({
      key,
      ...(planApproval ? { kind: 'plan' as const } : {}),
      title: context.t('app.approval.title'),
      summary,
      impact,
      ...(card?.warning === undefined ? {} : { warning: card.warning }),
      ...(card?.preview === undefined ? {} : { preview: card.preview }),
      actions,
      disabled: context.approvalBusy || context.stopping || !context.connected,
    })
    if (stick) context.renderer.pinToBottom()
  }

  function transcriptMeta(): {
    hasEarlier: boolean
    loadEarlier?: () => void
    sessionId?: string
    loop?: { id: string; version: string }
    controlFacts?: NonNullable<SessionControlStateResult['facts']>
  } {
    const session = context.live
    const loop =
      sessionLoopSelection(context.projection) ??
      sessionLoopSelection(context.current) ??
      sessionLoopSelection(context.sessionRows.find((row) => row.sessionId === context.current?.id))
    const identity = context.current
      ? {
          sessionId: context.current.id,
          ...(loop ? { loop } : {}),
          ...(context.sessionControls?.sessionId === context.current.id
            ? { controlFacts: context.sessionControls.value.facts ?? [] }
            : {}),
        }
      : {}
    if (!session?.hasEarlier()) return { hasEarlier: false, ...identity }
    return {
      hasEarlier: true,
      ...identity,
      loadEarlier: () => void session.loadEarlier().catch(context.showError),
    }
  }

  /** Loads earlier pages, `limit` at most, until the parked approval's node is loaded. */
  function searchApproval(limit?: number): void {
    const session = context.live
    if (
      !session ||
      context.approvalSearch === 'searching' ||
      (limit !== undefined && context.approvalSearch !== 'idle')
    )
      return
    context.approvalSearch = 'searching'
    renderApproval()
    void findApproval(session, () => context.projection, limit)
      .then((found) => {
        if (context.live !== session) return
        context.approvalSearch = found ? 'idle' : 'not-found'
        renderApproval()
      })
      .catch(context.showError)
  }

  function paintTrace(): void {
    const pending = context.tracePending
    context.tracePending = undefined
    if (!pending || !context.current || pending.sessionId !== context.current.id) return
    context.tracePaintedAt = Date.now()
    context.tracePanel.render(pending.view.nodes, pending.turns, pending.meta)
  }

  function renderTrace(
    view: WebView,
    turns: readonly UITurn[] | undefined,
    meta: ReturnType<typeof transcriptMeta>,
  ): void {
    if (!context.current) return
    context.tracePending = { sessionId: context.current.id, view, turns, meta }
    const immediate = !view.busy || Date.now() - context.tracePaintedAt >= context.TRACE_THROTTLE_MS
    if (immediate) {
      if (context.traceTrailing !== undefined) clearTimeout(context.traceTrailing)
      context.traceTrailing = undefined
      paintTrace()
      return
    }
    if (context.traceTrailing === undefined)
      context.traceTrailing = setTimeout(() => {
        context.traceTrailing = undefined
        paintTrace()
      }, context.TRACE_THROTTLE_MS)
  }

  return { render, renderApproval, transcriptMeta, searchApproval, paintTrace, renderTrace }
}
