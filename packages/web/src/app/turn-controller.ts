import type { UITurn } from '@agnes/protocol'
import type { SessionControlStateResult } from '@agnes/protocol/gen/agnes-v1'
import { sessionLoopSelection } from '@agnes/web-admin/admin/plugins/session-loop'
import type { ApprovalAction } from '@agnes/web-conversation/approval'
import {
  approvalIsDelegated,
  approvalIsPermission,
  approvalToolName,
  liveApprovalCard,
} from '@agnes/web-conversation/approval-card'
import {
  APPROVAL_SEARCH_PAGES,
  approvalOutsideWindow,
  findApproval,
} from '@agnes/web-conversation/live-projection'
import { approvalSummary, decisionPresentation } from '@agnes/web-ui'
import type { ApprovalView } from '@agnes/web-units/shell'
import type { AppSessionContext } from '../app.js'
import { rememberWebComposer } from '../composer-memory.js'
import { openSessionMode, sessionPermissionLevel } from '../session-permission.js'
import { sessionTitle } from '../session-title.js'
import {
  type DurableApprovalAction,
  durableApprovalActions,
  nodeText,
  type WebView,
  webView,
} from '../view.js'
import { type ApprovalNode, answeredApproval, approvalExpiry, pendingApproval } from './pending-approval.js'
import { createSessionBookmarks } from './session-bookmarks.js'

export function createTurnController(
  context: Pick<
    AppSessionContext,
    | 'submissions'
    | 'TRACE_THROTTLE_MS'
    | 'approvalBusy'
    | 'approvalRuntime'
    | 'approvalSearch'
    | 'approvalSearchTicket'
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
    | 'runtimeCatalog'
    | 'sessionControls'
    | 'sessionBinding'
    | 'sessionRows'
    | 'sessionPending'
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
  let approvalBinding = context.sessionBinding.capture()
  const syncApprovalScope = () => {
    const next = context.sessionBinding.capture()
    if (next === approvalBinding) return
    approvalBinding = next
    cachedApproval = undefined
    activeSearch = undefined
    context.approvalBusy = false
    context.approvalSearch = 'idle'
    context.approvalSearchTicket = undefined
  }
  const parkedTicket = (): string | undefined => {
    const ref = context.projection?.opState?.parked?.decisionRef
    return ref ? JSON.stringify(ref) : undefined
  }

  function render(): void {
    if (!context.projection) {
      context.topbarRuntime.setStatus(context.t('app.status.newTask'), 'idle')
      context.clientModules.sidebar?.setRunning([])
      context.tracePanel.render([], [])
      renderApproval()
      context.renderControls()
      return
    }
    // 会话切换的尾流（旧审批收尾、事件竞态）可能在这时触发渲染，而投影仍属于
    // 上一会话：此时屏幕上保留的正是上一会话画面，任何重绘都会把旧投影的
    // 模型、标题、审批卡写进新会话的控件。等投影换代后再渲染。
    const viewId = context.current?.id ?? context.readOnly?.id
    if (!viewId || context.projection.sessionId !== viewId) {
      renderApproval()
      return
    }
    if (
      typeof context.projection.yolo === 'boolean' &&
      !context.readOnly &&
      !context.sessionPending &&
      !context.permissionChangePending &&
      !context.permissionRefreshPending &&
      context.projection.upto >= context.permissionSelectionSeq
    ) {
      context.sessionYoloEnabled = context.projection.yolo
      if (context.initialPermissionPending === undefined)
        context.permissionMode = openSessionMode(
          sessionPermissionLevel(
            context.sessionRows.find((row) => row.sessionId === viewId),
            context.runtimeCatalog,
          ),
          context.projection.yolo,
          context.permissionMode,
        )
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
      !approvalIsDelegated(context.liveApproval.request.toolCall) &&
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
    if (view.busy) context.submissions.promptStarted()
    if (!view.busy && receipt?.reason && receipt.endSeq > context.stopAfterSeq) context.stopping = false
    const awaitingApproval = Boolean(
      context.liveApproval ||
        view.approval ||
        context.projection.opState?.parked ||
        (!view.busy && receipt?.reason === 'parked'),
    )
    const turn =
      context.projection.turns.find((candidate) => candidate.turn === context.projection?.opState?.turn) ??
      context.projection.turns.at(-1)
    if (context.readOnly) context.topbarRuntime.setStatus(context.t('app.readOnly.label'), 'idle')
    else
      context.topbarRuntime.setStatus(
        context.stopping
          ? context.t('app.status.stoppingWait')
          : awaitingApproval
            ? context.t('app.status.awaitingApproval')
            : view.status,
        context.stopping
          ? 'stopping'
          : awaitingApproval
            ? 'approval'
            : view.busy
              ? 'running'
              : (view.statusState ?? receipt?.reason ?? 'idle'),
        {
          sessionId: viewId,
          startedAt: turn?.startedAt,
          accessibleLabel: !context.stopping && !awaitingApproval && view.busy ? view.statusLabel : undefined,
        },
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
    syncApprovalScope()
    if (
      context.readOnly ||
      context.sessionPending ||
      !context.current ||
      (context.projection && context.projection.sessionId !== context.current.id) ||
      (context.liveApproval && context.liveApproval.request.sessionId !== context.current.id)
    ) {
      context.approvalRuntime.render(undefined)
      return
    }
    const known =
      (context.projection ? webView(context.projection, undefined, context.t).approval : undefined) ??
      (cachedApproval?.session === context.live && cachedApproval?.ticket === parkedTicket()
        ? cachedApproval?.node
        : undefined)
    const durable = known?.state === 'pending' ? known : undefined
    const fullAccess =
      context.sessionRows.find((row) => row.sessionId === context.current?.id)?.permission === 'full-access'
    const live = context.liveApproval
    // A new live question takes precedence over an older durable permission projection.
    if (
      (!live && known?.decision?.reason === 'full-access') ||
      (fullAccess &&
        (live
          ? approvalIsPermission(live.request.toolCall)
          : !known?.reconcile && known?.purpose !== 'plan.exit' && known?.category === 'permission'))
    ) {
      context.approvalRuntime.render(undefined)
      return
    }
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
      const ran = answered.decision?.verdict.startsWith('allow')
      context.approvalRuntime.render({
        key: `answered:${answered.decisionRef?.id ?? answered.id}`,
        kind: 'answered',
        title: context.t('app.approval.answeredTitle'),
        summary: answered.reconcile
          ? context.t(ran ? 'app.reconcile.answeredRan' : 'app.reconcile.answeredNotRan', {
              tool: answered.reconcile.tool,
            })
          : approvalSummary(answered, context.t),
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

    const card = context.liveApproval
      ? liveApprovalCard(context.liveApproval.request.toolCall, context.t)
      : undefined
    const liveTitle = card?.summary ?? context.liveApproval?.request.toolCall.title
    const presentation = context.liveApproval ? undefined : decisionPresentation(durable?.presentation)
    const reconcile = context.liveApproval ? undefined : durable?.reconcile
    const summary =
      typeof liveTitle === 'string'
        ? liveTitle
        : reconcile
          ? context.t('app.reconcile.summary', { tool: reconcile.tool })
          : (presentation?.title ??
            (durable ? approvalSummary(durable, context.t) : context.t('app.approval.defaultSummary')))
    const risks = {
      destructive: context.t('app.risk.destructive'),
      always: context.t('app.risk.always'),
      budget: context.t('app.risk.budget'),
      unknown: context.t('app.risk.unknown'),
    }
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
    const binding = context.sessionBinding.capture()
    const current = () => context.sessionBinding.isCurrent(binding) && context.live === decisionSession
    const guarded = (action: () => Promise<void>): (() => void) => {
      return () =>
        context.run(async () => {
          if (
            !current() ||
            context.approvalBusy ||
            context.stopping ||
            context.sessionPending ||
            context.readOnly
          )
            return
          context.approvalBusy = true
          renderApproval()
          try {
            await action()
            if (current()) cachedApproval = undefined
          } catch (error) {
            if (current()) throw error
          } finally {
            if (current()) {
              context.approvalBusy = false
              decisionSession?.refresh()
              renderApproval()
            }
          }
        })
    }
    const decide = (id: string, label: string, action: () => Promise<void>): void => {
      actions.push({ id, label, onSelect: guarded(action) })
    }
    let rejectWithReason: ApprovalView['rejectWithReason']
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
      const send = (verdict: DurableApprovalAction['verdict'], value: string | null) => async () =>
        void (await context.client.approval.decide({
          ...ref,
          commandId: `${ref.id}:${ref.revision}:${verdict}`,
          response: { option: verdict, value },
        }))
      const offered = durableApprovalActions(durable, context.t)
      for (const { label, verdict } of offered)
        decide(`durable:${verdict}`, label, send(verdict, presentation?.responseValue ?? null))
      // A reason replaces the response value, so it is offered only where that value is unused.
      if (
        !durable.reconcile &&
        presentation?.responseValue == null &&
        offered.some(({ verdict }) => verdict === 'rejected')
      )
        rejectWithReason = {
          label: context.t('app.approval.rejectReason'),
          inputLabel: context.t('app.approval.reasonLabel'),
          submitLabel: context.t('app.approval.reasonSubmit'),
          cancelLabel: context.t('app.approval.reasonCancel'),
          maxLength: 500,
          // An empty reason is a plain rejection.
          onSubmit: (reason: string) => guarded(send('rejected', reason === '' ? null : reason))(),
        }
    }
    // Plain text only: who asked, and what «always allow» would keep (first three, the rest on hover).
    const origin = reconcile
      ? undefined
      : [
          durable?.origin?.package && context.t('app.approval.from', { value: durable.origin.package }),
          durable?.origin?.role && context.t('app.approval.role', { value: durable.origin.role }),
          durable?.origin?.mcpServer && context.t('app.approval.mcp', { value: durable.origin.mcpServer }),
        ]
          .filter(Boolean)
          .join(' · ') || undefined
    const scopes = reconcile || context.liveApproval ? [] : (durable?.grantScopes ?? [])
    const stores = scopes.length
      ? {
          text: context.t('app.approval.stores', {
            value: scopes.slice(0, 3).join(', ') + (scopes.length > 3 ? ` +${scopes.length - 3}` : ''),
          }),
          ...(scopes.length > 3 ? { title: scopes.join(', ') } : {}),
        }
      : undefined
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
      ...(presentation ? { presentation } : {}),
      ...(rewritten === undefined ? {} : { rewritten }),
      impact: [
        context.approvalBusy ? context.t('session.integrity.verifying') : impact,
        approvalExpiry(durable?.expiresAt, context.t),
      ]
        .filter(Boolean)
        .join(' · '),
      ...(durable && !reconcile ? { risk: durable.risk } : {}),
      ...((card?.warning || durable?.prefixGrant?.runsProjectCode) && !reconcile
        ? {
            warning: [
              card?.warning,
              durable?.prefixGrant?.runsProjectCode ? context.t('timeline.decision.projectCode') : undefined,
            ]
              .filter(Boolean)
              .join(' '),
          }
        : {}),
      ...(preview === undefined ? {} : { preview }),
      actions,
      ...(origin === undefined ? {} : { origin }),
      ...(stores === undefined ? {} : { stores }),
      ...(rejectWithReason ? { rejectWithReason } : {}),
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
    syncApprovalScope()
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
    const binding = context.sessionBinding.capture()
    const current = () =>
      context.sessionBinding.isCurrent(binding) &&
      context.live === session &&
      parkedTicket() === ticket &&
      activeSearch === search
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
