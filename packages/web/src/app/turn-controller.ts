import type { UITurn } from '@agnes/protocol'
import type { SessionControlStateResult } from '@agnes/protocol/gen/agnes-v1'
import { sessionLoopSelection } from '@agnes/web-admin/admin/plugins/session-loop'
import type { ApprovalAction } from '@agnes/web-conversation/approval'
import { approvalToolName, liveApprovalCard } from '@agnes/web-conversation/approval-card'
import {
  APPROVAL_SEARCH_PAGES,
  approvalOutsideWindow,
  findApproval,
} from '@agnes/web-conversation/live-projection'
import type { AppSessionContext } from '../app.js'
import { rememberWebComposer } from '../composer-memory.js'
import { sessionTitle } from '../session-title.js'
import { durableApprovalActions, nodeText, type WebView, webView } from '../view.js'
import { type ApprovalNode, answeredApproval, approvalExpiry, pendingApproval } from './pending-approval.js'
import { createSessionBookmarks } from './session-bookmarks.js'

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
    | 'clientModules'
    | 'projection'
    | 'readOnly'
    | 'readOnlyController'
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
  const bookmarks = createSessionBookmarks({
    rows: () => context.sessionRows,
    save: (sessionId, list) => context.client.session.setBookmarks(sessionId, list),
    changed: () => render(),
  })
  let cachedApproval: { session: typeof context.live; ticket: string; node: ApprovalNode } | undefined
  let activeSearch: object | undefined
  const parkedTicket = (): string | undefined => {
    const ref = context.projection?.opState?.parked?.decisionRef
    return ref ? JSON.stringify(ref) : undefined
  }

  function render(): void {
    if (!context.projection) {
      context.topbarRuntime.setStatus(context.t('app.status.newTask'))
      context.clientModules.sidebar?.setRunning([])
      context.tracePanel.render([], [])
      context.renderControls()
      return
    }
    // 会话切换的尾流（旧审批收尾、事件竞态）可能在这时触发渲染，而投影仍属于
    // 上一会话：此时屏幕上保留的正是上一会话画面，任何重绘都会把旧投影的
    // 模型、标题、审批卡写进新会话的控件。等投影换代后再渲染。
    const viewId = context.current?.id ?? context.readOnly?.id
    if (!viewId || context.projection.sessionId !== viewId) return
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
      context.liveApproval.finish({ unanswered: 'detached' })
      return
    }
    const firstInput = context.windowAtStart ? view.nodes.find((node) => node.kind === 'user') : undefined
    const selectedId = viewId
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
    if (context.readOnly) context.topbarRuntime.setStatus(context.t('app.readOnly.label'), 'idle')
    else
      context.topbarRuntime.setStatus(
        context.stopping
          ? context.t('app.status.stoppingWait')
          : context.liveApproval
            ? context.t('app.status.awaitingApproval')
            : view.status,
        context.liveApproval ? 'approval' : view.busy ? 'running' : (receipt?.reason ?? 'idle'),
      )
    context.clientModules.sidebar?.setRunning(
      context.current && view.busy && !context.readOnly ? [context.current.id] : [],
    )
    const meta = transcriptMeta()
    context.renderer.render(view.nodes, context.projection.turns, meta)
    renderTrace(view, context.projection.turns, meta)
    if (approvalOutsideWindow(context.projection)) {
      const ticket = parkedTicket()
      // A different parked approval is looked for afresh.
      if (ticket !== context.approvalSearchTicket) context.approvalSearch = 'idle'
      context.approvalSearchTicket = ticket
      searchApproval(APPROVAL_SEARCH_PAGES)
    } else context.approvalSearch = 'idle'
    renderApproval()
    context.renderControls()
  }

  function renderApproval(): void {
    const known =
      (context.projection ? webView(context.projection, undefined, context.t).approval : undefined) ??
      (cachedApproval?.session === context.live && cachedApproval?.ticket === parkedTicket()
        ? cachedApproval?.node
        : undefined)
    const durable = known?.state === 'pending' ? known : undefined
    // Answered, but the turn has not taken the answer up yet: say so, never that it failed to load.
    const parkedRef = context.projection?.opState?.parked?.decisionRef
    const answered =
      (known?.state === 'decided' ? known : undefined) ??
      (parkedRef
        ? context.projection?.nodes.find(
            (node): node is ApprovalNode =>
              node.kind === 'approval' && node.state === 'decided' && node.decisionRef?.id === parkedRef.id,
          )
        : undefined)
    if (!context.liveApproval && !durable && answered) {
      const stick = context.conversationRuntime.isTranscriptNearBottom()
      const ran = answered.decision?.verdict.startsWith('allowed')
      context.approvalRuntime.render({
        key: `answered:${answered.decisionRef?.id ?? answered.id}`,
        kind: 'answered',
        title: context.t('app.approval.answeredTitle'),
        summary: answered.reconcile
          ? context.t(ran ? 'app.reconcile.answeredRan' : 'app.reconcile.answeredNotRan', {
              tool: answered.reconcile.tool,
            })
          : answered.summary,
        impact: context.t('app.approval.answeredImpact'),
        actions: [],
        disabled: true,
      })
      if (stick) context.renderer.pinToBottom()
      return
    }
    const parked =
      !context.liveApproval && !durable && context.projection ? context.projection.opState?.parked : undefined
    if (parked && context.approvalSearch !== 'idle') {
      const stick = context.conversationRuntime.isTranscriptNearBottom()
      const searching = context.approvalSearch === 'searching'
      // Never infer verdicts from parked state alone. Resolve the current decision or its history.
      context.approvalRuntime.render({
        key: `parked:${parked.decisionRef.id}`,
        title: searching ? context.t('app.approval.searching') : context.t('app.approval.parkedTitle'),
        summary: context.t('app.approval.parkedSummary', {
          expiry: approvalExpiry(parked.expiresAt, context.t),
        }),
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
      : (durable?.decisionRef?.id ?? '')
    // 审批卡是会话区外的流内兄弟：显示/收回都会改变 #transcript 的视口高度。
    // 原本贴底的会话要保持贴底，否则最新过程被压出可视区、贴底跟随也会被破坏。
    const stick = context.conversationRuntime.isTranscriptNearBottom()
    if (!key) {
      context.approvalRuntime.render(undefined)
      if (stick) context.renderer.pinToBottom()
      return
    }

    const liveTitle = context.liveApproval?.request.toolCall.title
    const reconcile = context.liveApproval ? undefined : durable?.reconcile
    const summary =
      typeof liveTitle === 'string'
        ? liveTitle
        : reconcile
          ? context.t('app.reconcile.summary', { tool: reconcile.tool })
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
    const impact = reconcile
      ? context.t('app.reconcile.impact')
      : durable
        ? risks[durable.risk]
        : (card?.impact ?? context.t('app.approval.toolImpact'))
    const rewrite = context.liveApproval ? undefined : durable?.rewrite
    const rewritten = rewrite
      ? rewrite.by.length
        ? context.t('app.approval.rewrittenBy', { source: rewrite.by.join(', '), summary: rewrite.summary })
        : context.t('app.approval.rewritten', { summary: rewrite.summary })
      : undefined
    const actions: ApprovalAction[] = []
    const decisionSession = context.live
    const decide = (id: string, label: string, action: () => Promise<void>): void => {
      actions.push({
        id,
        label,
        onSelect: () =>
          context.run(async () => {
            if (context.live !== decisionSession || context.approvalBusy || context.stopping) return
            context.approvalBusy = true
            renderApproval()
            try {
              await action()
              if (context.live === decisionSession) cachedApproval = undefined
            } finally {
              context.approvalBusy = false
              if (context.live === decisionSession) {
                decisionSession?.refresh()
                renderApproval()
              }
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
    } else if (durable?.decisionRef) {
      const ref = durable.decisionRef
      for (const { label, verdict } of durableApprovalActions(durable, context.t))
        decide(
          `durable:${verdict}`,
          label,
          async () =>
            void (await context.client.approval.decide({
              ...ref,
              commandId: `${ref.id}:${ref.revision}:${verdict}`,
              response: { option: verdict, value: null },
            })),
        )
    }
    // A reconciliation's subject is bookkeeping (ids, turn, step), not something to review.
    const preview = reconcile ? undefined : (card?.preview ?? durable?.subjectText)
    const planApproval = context.liveApproval
      ? approvalToolName(context.liveApproval.request.toolCall) === 'exit_plan_mode'
      : context.projection?.nodes.some(
          (node) =>
            node.kind === 'tool' && node.name === 'exit_plan_mode' && node.status === 'awaiting_approval',
        )
    context.approvalRuntime.render({
      key,
      ...(planApproval ? { kind: 'plan' as const } : {}),
      ...(reconcile ? { kind: 'reconcile' as const } : {}),
      title: context.t(reconcile ? 'app.reconcile.title' : 'app.approval.title'),
      summary,
      ...(rewritten === undefined ? {} : { rewritten }),
      impact: [impact, approvalExpiry(durable?.expiresAt, context.t)].filter(Boolean).join(' · '),
      ...(durable && !reconcile ? { risk: durable.risk } : {}),
      ...(card?.warning === undefined ? {} : { warning: card.warning }),
      ...(preview === undefined ? {} : { preview }),
      actions,
      disabled:
        context.approvalBusy ||
        context.stopping ||
        !context.connected ||
        Boolean(durable?.expiresAt && Date.parse(durable.expiresAt) <= Date.now()),
    })
    if (stick) context.renderer.pinToBottom()
  }

  function transcriptMeta(): {
    hasEarlier: boolean
    loadEarlier?: () => void
    sessionId?: string
    loop?: { id: string; version: string }
    controlFacts?: NonNullable<SessionControlStateResult['facts']>
    bookmarks?: readonly string[]
    setBookmarks?: (next: readonly string[]) => Promise<void>
  } {
    const readOnly = context.readOnly
    if (readOnly)
      return readOnly.hasEarlier
        ? {
            hasEarlier: true,
            loadEarlier: () => void context.readOnlyController.loadEarlier().catch(context.showError),
          }
        : { hasEarlier: false }
    const session = context.live
    const loop =
      sessionLoopSelection(context.projection) ??
      sessionLoopSelection(context.current) ??
      sessionLoopSelection(context.sessionRows.find((row) => row.sessionId === context.current?.id))
    const saved = context.current ? bookmarks.read(context.current.id) : undefined
    const identity = context.current
      ? {
          sessionId: context.current.id,
          ...(loop ? { loop } : {}),
          ...(saved ?? {}),
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
    const ticket = parkedTicket()
    const ref = context.projection?.opState?.parked?.decisionRef
    const search = {}
    let focused = false
    activeSearch = search
    const current = () => context.live === session && parkedTicket() === ticket && activeSearch === search
    context.approvalSearchTicket = ticket
    context.approvalSearch = 'searching'
    renderApproval()
    // The current decision is independent of the transcript window. Do not make the user wait for
    // hundreds of history pages before they can review the request and answer it.
    // Started inside the promise, so a lookup that throws at once still settles the search.
    const lookup = ref
      ? Promise.resolve()
          .then(() => context.client.approval.list(ref.sessionId))
          .then(({ decisions }) => {
            if (!current()) return
            const node = pendingApproval(decisions, ref) ?? answeredApproval(decisions, ref)
            cachedApproval = node ? { session, ticket: JSON.stringify(ref), node } : undefined
            renderApproval()
            if (node?.state === 'pending' && limit === undefined) {
              context.approvalRuntime.focus()
              focused = true
            }
          })
      : Promise.resolve()
    const history = findApproval(session, () => (current() ? context.projection : undefined), limit)
    void Promise.allSettled([lookup, history]).then(([decision, found]) => {
      if (!current()) return
      context.approvalSearch = found.status === 'fulfilled' && found.value ? 'idle' : 'not-found'
      renderApproval()
      if (limit === undefined && !focused) context.approvalRuntime.focus()
      for (const result of [decision, found])
        if (result.status === 'rejected') context.showError(result.reason)
    })
  }

  function paintTrace(): void {
    const pending = context.tracePending
    context.tracePending = undefined
    const viewId = context.current?.id ?? context.readOnly?.id
    if (!pending || !viewId || pending.sessionId !== viewId) return
    context.tracePaintedAt = Date.now()
    context.tracePanel.render(pending.view.nodes, pending.turns, pending.meta)
  }

  function renderTrace(
    view: WebView,
    turns: readonly UITurn[] | undefined,
    meta: ReturnType<typeof transcriptMeta>,
  ): void {
    const viewId = context.current?.id ?? context.readOnly?.id
    if (!viewId) return
    context.tracePending = { sessionId: viewId, view, turns, meta }
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
