import type {
  ComparisonCreateParams,
  ComparisonJournalEntry,
  ComparisonJournalFact,
  ComparisonLane,
  ComparisonMetricsResult,
  ComparisonRound,
  ComparisonSnapshot,
  EventEnvelope,
  RuntimeDescriptor,
  UITimeline,
  WorkspaceEntry,
} from '@agnes/protocol'
import { type Client, JsonRpcError, type PermissionOutcome, type PermissionRequest } from '@agnes/sdk/browser'
import { Approval, type ApprovalView } from '@agnes/web-units'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createComparisonChildHistory } from './comparison-child-history.js'
import { createComparisonCutLedger } from './comparison-cut-ledger.js'
import {
  clearLatestComparisonEntry,
  forgetComparisonEntry,
  readComparisonEntry,
  writeComparisonEntry,
} from './comparison-entry.js'
import { comparisonCreationMessage } from './comparison-errors.js'
import { createComparisonHistory } from './comparison-history.js'
import { createComparisonJournal } from './comparison-journal.js'
import { createComparisonLedger } from './comparison-ledger.js'
import { createComparisonMetrics } from './comparison-metrics.js'
import {
  COMPARISON_PERMISSION_OPTIONS,
  comparisonPermissionEntry,
  comparisonPermissionLabel,
  comparisonPermissionMode,
  type PermissionCreation,
  type PermissionInput,
} from './comparison-permission.js'
import { createComparisonReplay } from './comparison-replay.js'
import { createComparisonTrace } from './comparison-trace.js'
import { createJevDecisionGraph } from './jev-decision-graph.js'
import { createJevDirectStats } from './jev-stats.js'
import { createPermissionPicker, type PermissionMode } from './permission-picker.js'
import { createQuestionController } from './question-controller.js'
import { SessionPaneController } from './session-pane.js'
import { createTimelineRenderer } from './timeline.js'
import { durableApprovalActions, webView } from './view.js'

type PendingInput = PermissionInput
type ComparisonTimeline = Omit<UITimeline, 'generation'> & { generation?: number }
export type ComparisonDefaults = {
  runtimes: readonly RuntimeDescriptor[]
  workspaces: readonly WorkspaceEntry[]
  cwd?: string
  model?: ComparisonCreateParams['model']
  permissionMode?: PermissionMode
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}
function option(text: string, value: string): HTMLOptionElement {
  const node = element('option', text)
  node.value = value
  return node
}
function button(text: string, action: () => void): HTMLButtonElement {
  const node = element('button', text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}
/** A failed lane may be terminal; an unknown admission or unfinished peer is not. */
function canSubmitRound(snapshot: ComparisonSnapshot | undefined): boolean {
  if (!snapshot || ['preparing', 'running', 'failed'].includes(snapshot.phase)) return false
  if (snapshot.storageState && snapshot.storageState !== 'full') return false
  return roundsSettled(snapshot)
}
function roundsSettled(snapshot: ComparisonSnapshot): boolean {
  return snapshot.rounds.every((round) =>
    (['left', 'right'] as const).every((side) => {
      const receipt = round.acceptances.find((item) => item.side === side)
      return (
        receipt !== undefined &&
        receipt.status !== 'unknown' &&
        (receipt.status === 'rejected' ||
          round.settledSides.includes(side) ||
          round.terminalCauses?.some((item) => item.side === side) === true)
      )
    }),
  )
}

function rejectedBeforeAdmission(error: unknown, id: string, inputId: string): boolean {
  if (!(error instanceof JsonRpcError)) return false
  const data = error.data
  return (
    (data.code === 'COMPARISON_BUSY' || data.code === 'COMPARISON_NOT_READY') &&
    data.id === id &&
    data.inputId === inputId &&
    data.phase === 'pre-admission' &&
    data.inputAccepted === false
  )
}

/** A separate workspace owns both panes; normal chat selection never disposes either lane. */
export function createComparisonWorkspace(
  client: Client,
  defaults: () => ComparisonDefaults,
  navigation: { select?(id: string | undefined): void | Promise<void> } = {},
) {
  const dialog = element('dialog')
  dialog.className = 'comparison-workspace'
  dialog.setAttribute('aria-label', '运行循环对比')
  const heading = element('header')
  const title = element('h2', '运行循环对比')
  const message = element('p')
  message.setAttribute('role', 'status')
  const facts = element('p')
  facts.className = 'comparison-facts'
  const setup = element('form')
  setup.className = 'comparison-setup'
  const cwd = element('select')
  cwd.setAttribute('aria-label', '对比工作区')
  const left = element('select')
  left.setAttribute('aria-label', '左侧运行循环')
  const right = element('select')
  right.setAttribute('aria-label', '右侧运行循环')
  const create = element('button', '创建隔离快照并对比')
  create.type = 'submit'
  setup.append(cwd, left, right, create)
  const permissionControls = element('div')
  permissionControls.className = 'comparison-permission'
  const permissionTrigger = element('button')
  permissionTrigger.type = 'button'
  permissionTrigger.setAttribute('aria-label', '选择双侧下一轮审批模式')
  permissionTrigger.setAttribute('aria-haspopup', 'listbox')
  const permissionText = element('span')
  permissionText.dataset.permissionLabel = ''
  permissionTrigger.append(permissionText)
  const permissionHint = element('span')
  permissionControls.append(element('span', '双侧审批：'), permissionTrigger, permissionHint)
  const panes = element('div')
  panes.className = 'comparison-panes'
  const mobileLanes = element('nav')
  mobileLanes.className = 'comparison-mobile-lanes'
  mobileLanes.setAttribute('aria-label', '窄屏对比会话')
  let mobileSide: ComparisonLane['side'] | undefined
  function selectMobileSide(side: ComparisonLane['side']) {
    mobileSide = side
    for (const section of panes.querySelectorAll<HTMLElement>('.comparison-lane'))
      section.dataset.mobileSelected = String(section.dataset.side === side)
    for (const control of mobileLanes.querySelectorAll<HTMLButtonElement>('button'))
      control.setAttribute('aria-pressed', String(control.dataset.side === side))
  }
  const graphColumn = element('section')
  graphColumn.className = 'comparison-graph-column'
  graphColumn.setAttribute('aria-label', '双线决策流程图')
  const graphEmpty = element('p', '等待 JevLoop 决策记录…')
  const graphChoice = element('select')
  graphChoice.setAttribute('aria-label', '流程图所属会话')
  graphChoice.hidden = true
  graphChoice.addEventListener('change', () => {
    for (const host of graphColumn.querySelectorAll<HTMLElement>(':scope > section'))
      host.hidden = host.dataset.side !== graphChoice.value
  })
  graphColumn.append(graphChoice, graphEmpty)
  panes.append(graphColumn)
  let workspaceView: 'chat' | 'trace' = 'chat'
  const views = element('nav')
  views.className = 'comparison-views'
  views.setAttribute('aria-label', '双线视图')
  const chatView = button('对话', () => setWorkspaceView('chat'))
  const traceView = button('双线轨迹', () => setWorkspaceView('trace'))
  views.append(chatView, traceView)
  function setWorkspaceView(view: 'chat' | 'trace') {
    workspaceView = view
    chatView.setAttribute('aria-pressed', String(view === 'chat'))
    traceView.setAttribute('aria-pressed', String(view === 'trace'))
    for (const lane of lanes.values()) lane.view(view)
  }
  const replayHost = element('div')
  const metricsHost = element('div')
  const metrics = createComparisonMetrics(metricsHost, client.comparison.priceDetails)
  const rounds = element('div')
  rounds.className = 'comparison-rounds'
  rounds.setAttribute('aria-live', 'polite')
  const inputCancellation = element('p')
  inputCancellation.className = 'comparison-input-cancellation'
  inputCancellation.setAttribute('role', 'status')
  const form = element('form')
  form.className = 'comparison-composer'
  const input = element('textarea')
  input.setAttribute('aria-label', '发送给两侧的相同输入')
  input.placeholder = '输入任务，两侧将分别执行。'
  const submit = element('button', '同时提交两侧')
  submit.type = 'submit'
  const refresh = button('刷新状态', () => run(refreshSnapshot))
  const reconcileDurable = button('核对持久状态', () => run(() => refreshSnapshot(true)))
  const retryPending = button('重试原请求', () => run(() => submitInput(true)))
  const cancelAll = button('停止两侧', () => run(() => cancelComparison()))
  const releaseResources = button('释放运行资源', () => run(() => retireComparison('release')))
  const removeHistory = button('删除对比记录', () => run(() => retireComparison('remove')))
  const fresh = button('新建对比', () =>
    run(async () => {
      if (!canSwitch()) return
      const ticket = ++selection
      if (snapshot) drafts.set(snapshot.id, input.value)
      opening = true
      render()
      try {
        await detach()
        if (ticket !== selection || !dialog.open) return
        snapshot = undefined
        permissionChoice = undefined
        pending = undefined
        pendingCreate = undefined
        creation = undefined
        restoreFailed = false
        input.value = ''
        clearLatestComparisonEntry()
        await navigation.select?.(undefined)
        fillSetup()
      } finally {
        if (ticket === selection) {
          opening = false
          render()
        }
      }
    }),
  )
  const management = element('details')
  management.className = 'comparison-management'
  const managementBody = element('div')
  management.append(element('summary', '管理'), managementBody)
  managementBody.append(refresh, reconcileDurable, cancelAll, releaseResources, removeHistory, fresh)
  const results = element('details')
  results.className = 'comparison-results-popover'
  results.append(element('summary', '对比结果'), metricsHost)
  heading.append(
    title,
    views,
    results,
    management,
    button('关闭', () => dialog.close()),
  )
  form.append(input, submit, retryPending)
  const historyHost = element('div')
  const diagnostics = element('details')
  diagnostics.className = 'comparison-diagnostics'
  diagnostics.append(element('summary', '运行详情与回放'), historyHost, facts, replayHost, rounds)
  dialog.append(
    heading,
    message,
    permissionControls,
    setup,
    diagnostics,
    mobileLanes,
    panes,
    inputCancellation,
    form,
  )
  // This is the active main workspace, not a modal layered over the original chat.
  const workspaceHost = document.getElementById('main-content') ?? document.body
  workspaceHost.append(dialog)
  let snapshot: ComparisonSnapshot | undefined
  let pending: PendingInput | undefined
  let pendingFailure: { input: PendingInput; message: string } | undefined
  let pendingCreate: ComparisonCreateParams | undefined
  let creation: PermissionCreation | undefined
  let permissionChoice: PermissionMode | undefined
  const pendingPermissions = new Set<ComparisonLane['side']>()
  const approvalFences = new Map<string, { roundIds: Set<string>; tickets: Set<string> }>()
  let permissionRequestIdentity = 0
  let offConnection: (() => void) | undefined
  let restoreFailed = false
  let draftRequestId: string | undefined
  let busy = false
  let opening = false
  let cancelling = false
  let selection = 0
  const drafts = new Map<string, string>()
  let epoch = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let refreshPending = false
  let journal: ReturnType<typeof createComparisonJournal> | undefined
  let journalMode: 'loading' | 'journal' | 'per-lane-only' | 'error' = 'loading'
  let journalEntries: readonly ComparisonJournalEntry[] = []
  let coordinatorCursor: number | null = null
  let coordinator: Extract<ComparisonJournalFact, { kind: 'coordinator' }> | undefined
  const lanes = new Map<
    ComparisonLane['side'],
    {
      view(value: 'chat' | 'trace'): void
      mutable(live: boolean): void
      retireApprovals(cancel: boolean): void
      prepare(cut: number, atSeq: number | null): Promise<(() => void) | undefined>
      connect(): Promise<void>
      cut(atSeq: number, throughSeq: number): void
      dispose(): Promise<void>
    }
  >()
  const replay = createComparisonReplay(
    replayHost,
    async (cuts, live, current, atSeq) => {
      const ticket = epoch
      render()
      if (atSeq !== null) metrics.loading(atSeq)
      const prepared = await Promise.all([...lanes].map(([side, lane]) => lane.prepare(cuts[side], atSeq)))
      if (!current() || ticket !== epoch || prepared.length !== 2 || prepared.some((item) => !item))
        return false
      let accounting: ComparisonMetricsResult | undefined
      if (atSeq !== null && snapshot) {
        const id = snapshot.id
        accounting = await client.comparison.metrics({ id, atSeq })
        if (!current() || ticket !== epoch) return false
        if (
          accounting.id !== id ||
          accounting.atSeq !== atSeq ||
          accounting.cuts.left !== cuts.left ||
          accounting.cuts.right !== cuts.right
        )
          throw new Error('计量返回了不同的共享 journal 前缀')
        const seen = new Set<string>()
        for (const value of accounting.lanes) {
          const lane = snapshot.lanes.find((lane) => lane.side === value.side)
          if (
            seen.has(value.side) ||
            lane?.sessionId !== value.sessionId ||
            lane.runtime.id !== value.runtime.id ||
            lane.runtime.version !== value.runtime.version ||
            value.accounting.throughSeq !== cuts[value.side] ||
            value.accounting.afterSeq > value.accounting.throughSeq
          )
            throw new Error('计量的会话身份或账本窗口不匹配')
          seen.add(value.side)
        }
      }
      if (!current() || ticket !== epoch) return false
      for (const commit of prepared) commit?.()
      if (accounting) metrics.render(accounting)
      coordinatorCursor = atSeq
      const fact =
        atSeq === null
          ? undefined
          : journalEntries.slice(0, atSeq).findLast((entry) => entry.fact.kind === 'coordinator')?.fact
      coordinator = fact?.kind === 'coordinator' ? fact : undefined
      render()
      for (const lane of lanes.values()) lane.mutable(live)
      return true
    },
    (error) => {
      metrics.unavailable(`计量或投影读取失败：${error instanceof Error ? error.message : String(error)}`)
      fail(error)
    },
  )

  const fail = (error: unknown) => {
    message.textContent =
      comparisonCreationMessage(error) ??
      (error instanceof Error ? error.message : '对比操作失败，请刷新状态。')
    pendingFailure = pending ? { input: pending, message: message.textContent } : undefined
  }
  const run = (action: () => Promise<void>) => {
    void action().catch(fail)
  }
  const connected = () => client.connectionState === undefined || client.connectionState === 'connected'
  const selectedPermission = () =>
    pending?.permissionMode ??
    pendingCreate?.permissionMode ??
    permissionChoice ??
    (snapshot ? comparisonPermissionMode(snapshot) : (defaults().permissionMode ?? 'workspace'))
  const activePermission = () =>
    pending?.permissionMode ?? (snapshot ? comparisonPermissionMode(snapshot) : selectedPermission())
  const canSelectPermission = () =>
    dialog.open &&
    connected() &&
    !busy &&
    !opening &&
    !cancelling &&
    !restoreFailed &&
    !pending &&
    !pendingCreate &&
    !pendingPermissions.size &&
    (!snapshot || (replay.live() && canSubmitRound(snapshot)))
  const permissionPicker = createPermissionPicker({
    trigger: permissionTrigger,
    onError: fail,
    onSelect: async (mode) => {
      if (!canSelectPermission()) return false
      permissionChoice = mode
      renderPermission()
      return true
    },
  })
  function renderPermission() {
    const disabled = !canSelectPermission()
    if (disabled) permissionPicker.close()
    permissionPicker.render({
      disabled,
      pending: busy || opening,
      selected: selectedPermission(),
      options: COMPARISON_PERMISSION_OPTIONS,
    })
    permissionHint.textContent =
      snapshot && !canSubmitRound(snapshot)
        ? `本轮：${comparisonPermissionLabel(activePermission())}；执行或审批中不可切换。`
        : '只在创建或下一轮提交时生效；两侧始终保持对比目录隔离。'
  }
  function watchConnection() {
    if (!offConnection && typeof client.on === 'function')
      offConnection = client.on('connectionStateChanged', () => {
        if (!connected()) for (const lane of lanes.values()) lane.retireApprovals(false)
        if (dialog.open) render()
      })
  }
  const save = () => {
    const id = snapshot?.id ?? pendingCreate?.requestId ?? creation?.params.requestId
    if (id)
      writeComparisonEntry({
        id,
        ...(pending ? { pending } : {}),
        ...(creation ? { creation } : {}),
        draft: input.value,
      })
  }
  const canSwitch = () => dialog.open && !busy && !opening && !cancelling && !pending && !pendingCreate
  const pendingCancellation = () => {
    const inputId = pending?.inputId
    return inputId ? snapshot?.inputCancellations?.find((item) => item.inputId === inputId) : undefined
  }
  function clearAcknowledgedCancellation() {
    const cancellation = pendingCancellation()
    if (
      cancellation &&
      (['left', 'right'] as const).every((side) =>
        cancellation.states.some((item) => item.side === side && item.status === 'acknowledged'),
      )
    ) {
      pending = undefined
      creation = undefined
      message.textContent = '原输入已停止，两侧取消均已确认；草稿已保留。'
      return true
    }
    return false
  }
  const canCancel = (side?: ComparisonLane['side']) =>
    dialog.open &&
    (snapshot?.storageState ?? 'full') === 'full' &&
    replay.live() &&
    !opening &&
    !busy &&
    !cancelling &&
    !refreshPending &&
    (pending !== undefined ||
      snapshot?.rounds.some((round) =>
        (side ? [side] : (['left', 'right'] as const)).some(
          (target) =>
            !round.settledSides.includes(target) &&
            !round.terminalCauses?.some((cause) => cause.side === target) &&
            round.acceptances.find((receipt) => receipt.side === target)?.status !== 'rejected',
        ),
      ) === true)
  async function cancelComparison(side?: ComparisonLane['side']) {
    if (!snapshot || !canCancel(side)) return
    const id = snapshot.id
    const ticket = selection
    const current = () => dialog.open && selection === ticket && snapshot?.id === id
    cancelling = true
    for (const [target, lane] of lanes) if (!side || side === target) lane.retireApprovals(true)
    render()
    try {
      const next = await client.comparison.cancel({
        id,
        ...(side ? { side } : {}),
        ...(pending ? { inputId: pending.inputId } : {}),
      })
      if (!current()) return
      if (next.id !== id) throw new Error('停止请求返回了不同的对比记录。')
      if (snapshot && next.revision >= snapshot.revision) snapshot = next
      message.textContent = `已请求停止${side ? (side === 'left' ? '左侧' : '右侧') : '两侧'}；各侧结束状态以持久记录为准，可核对持久状态。`
      clearAcknowledgedCancellation()
      save()
      await journal?.read()
    } catch {
      if (current()) message.textContent = '停止请求结果待确认；输入已保留，请核对持久状态。'
    } finally {
      if (current()) {
        cancelling = false
        render()
      }
    }
  }
  const history = createComparisonHistory(historyHost, {
    list: (params) =>
      typeof client.comparison.list === 'function'
        ? client.comparison.list(params)
        : Promise.reject(new Error('当前连接不支持已保存对比列表。')),
    active: () => dialog.open,
    canSelect: canSwitch,
    selected: () => snapshot?.id,
    select: async (id) => {
      if (!canSwitch() || snapshot?.id === id) return
      const ticket = ++selection
      const previous = snapshot
      const draft = input.value
      const previousPending = pending
      const previousCreation = creation
      const previousPermission = permissionChoice
      opening = true
      history.retire()
      render()
      try {
        const next = await client.comparison.get(id)
        if (ticket !== selection || !dialog.open) return
        if (next.id !== id || next.lanes.length !== 2) throw new Error('保存的对比尚无完整双侧会话。')
        if (previous) drafts.set(previous.id, draft)
        const entry = comparisonPermissionEntry(readComparisonEntry(id))
        pending = entry?.pending
        creation = entry?.creation
        snapshot = next
        permissionChoice = undefined
        input.value = pending?.text ?? creation?.firstInput?.text ?? entry?.draft ?? drafts.get(id) ?? ''
        try {
          await mount(true)
        } catch (error) {
          if (ticket !== selection || !dialog.open) return
          snapshot = previous
          pending = previousPending
          creation = previousCreation
          permissionChoice = previousPermission
          input.value = draft
          if (previous) await mount()
          else await detach()
          throw error
        }
        if (ticket !== selection || !dialog.open) return
        save()
        await navigation.select?.(id)
        message.textContent = '已打开保存的对比；切换不会取消另一组的运行。'
      } catch (error) {
        if (ticket === selection && dialog.open) fail(error)
      } finally {
        if (ticket === selection) {
          opening = false
          render()
        }
      }
    },
  })
  const renderRound = (round: ComparisonRound): HTMLElement => {
    const row = element('p', `输入 ${round.inputId.slice(0, 8)}：`)
    row.append(element('span', `审批：${comparisonPermissionLabel(round.permissionMode)}； `))
    appendPreparedPermissions(row, round.prepared)
    for (const acceptance of round.acceptances) {
      const side = acceptance.side === 'left' ? '左侧' : '右侧'
      const cause = round.terminalCauses?.find((item) => item.side === acceptance.side)?.cause
      const terminalLabel = {
        finished: '已完成',
        cancelled: '已取消',
        failed: '失败',
        unknown: '结束原因未知',
      }
      row.append(
        element(
          'span',
          acceptance.status === 'accepted'
            ? `${side} 已接收 #${acceptance.seq} · ${cause ? terminalLabel[cause] : round.settledSides.includes(acceptance.side) ? '结束原因未知' : '执行中'}； `
            : `${side} ${acceptance.status === 'unknown' ? '接收状态待确认' : '接收失败'}${acceptance.error ? ` · ${acceptance.error.message}` : ''}； `,
        ),
      )
    }
    return row
  }
  function renderJournalRound() {
    const row = element('p', `共享协调事实 · journal #${coordinatorCursor ?? 0}`)
    if (!coordinator) {
      row.append(' · 此前缀尚无协调事实')
      return row
    }
    row.append(` · 修订 ${coordinator.revision} · ${coordinator.creation} · ${coordinator.roundCount} 轮`)
    const round = coordinator.latestRound
    if (round) {
      row.append(` · 输入 ${round.inputId.slice(0, 8)}：`)
      row.append(`审批：${comparisonPermissionLabel(round.permissionMode)}； `)
      appendPreparedPermissions(row, round.prepared)
      for (const side of ['left', 'right'] as const) {
        const accepted = round.acceptances[side]
        const cause = round.terminalCauses[side]
        const acceptance =
          accepted === 'accepted'
            ? `已接收${round.acceptedSeqs[side] === undefined ? '（序号未知）' : ` #${round.acceptedSeqs[side]}`}`
            : accepted === 'rejected'
              ? '接收失败'
              : '接收状态待确认'
        const terminal =
          cause === 'finished'
            ? '已完成'
            : cause === 'cancelled'
              ? '已取消'
              : cause === 'failed'
                ? '失败'
                : round.runs[side] === 'settled'
                  ? '结束原因未知'
                  : `执行状态 ${round.runs[side]}`
        row.append(element('span', `${side === 'left' ? '左侧' : '右侧'} ${acceptance} · ${terminal}； `))
      }
    }
    for (const side of ['left', 'right'] as const) {
      const state = coordinator.cancellation[side]
      if (state)
        row.append(
          element(
            'span',
            `${side === 'left' ? '左侧' : '右侧'}停止请求：${state === 'acknowledged' ? '已确认接收（不代表已结束）' : state === 'unknown' ? '结果待确认' : '已请求'}； `,
          ),
        )
    }
    return row
  }
  function appendPreparedPermissions(host: HTMLElement, prepared: ComparisonRound['prepared']) {
    if (!prepared) return
    for (const side of ['left', 'right'] as const) {
      const permission = prepared[side]?.configuration.effective.permission
      if (permission)
        host.append(
          element(
            'span',
            `${side === 'left' ? '左侧' : '右侧'}实际审批 ${permission.approvalMode ?? '未知'} · YOLO ${permission.yolo ? '启用' : '关闭'}； `,
          ),
        )
    }
  }
  function render() {
    history.render()
    renderPermission()
    setup.hidden = snapshot !== undefined
    panes.hidden = !snapshot
    graphColumn.hidden = !snapshot?.lanes.some((lane) => lane.runtime.id === 'jevloop')
    panes.dataset.hasGraph = String(!graphColumn.hidden)
    form.hidden = !snapshot
    replayHost.hidden = !snapshot
    metricsHost.hidden = !snapshot
    results.hidden = !snapshot
    views.hidden = !snapshot
    mobileLanes.hidden = !snapshot
    chatView.setAttribute('aria-pressed', String(workspaceView === 'chat'))
    traceView.setAttribute('aria-pressed', String(workspaceView === 'trace'))
    for (const lane of lanes.values())
      lane.mutable(replay.live() && (snapshot?.storageState ?? 'full') === 'full')
    for (const select of [cwd, left, right]) select.disabled = busy || pendingCreate !== undefined
    create.textContent = pendingCreate ? '确认上次创建结果' : '创建隔离快照并对比'
    create.disabled =
      restoreFailed ||
      busy ||
      opening ||
      cancelling ||
      pending !== undefined ||
      !cwd.value ||
      !left.value ||
      !right.value
    fresh.disabled = !canSwitch()
    cancelAll.disabled = !canCancel()
    const storageState = snapshot?.storageState ?? 'full'
    releaseResources.hidden = !snapshot || !['full', 'releasing'].includes(storageState)
    releaseResources.textContent = storageState === 'releasing' ? '重试释放资源' : '释放运行资源'
    releaseResources.disabled =
      !canSwitch() ||
      refreshPending ||
      !replay.live() ||
      (storageState === 'full' &&
        (!snapshot || ['preparing', 'running'].includes(snapshot.phase) || !roundsSettled(snapshot)))
    removeHistory.hidden = !snapshot || !['released', 'removing'].includes(storageState)
    removeHistory.disabled = !canSwitch() || refreshPending || !replay.live()
    submit.disabled =
      !canSubmitRound(snapshot) ||
      busy ||
      cancelling ||
      opening ||
      pending !== undefined ||
      !input.value.trim() ||
      !replay.live() ||
      !connected()
    submit.textContent =
      storageState !== 'full'
        ? '此对比已停止继续运行'
        : snapshot && !canSubmitRound(snapshot)
          ? '等待两侧完成或核对持久状态'
          : '同时提交两侧'
    input.disabled = storageState !== 'full' || pending !== undefined || busy || opening || !replay.live()
    retryPending.hidden = pending === undefined
    retryPending.disabled =
      !pending ||
      !!pendingCancellation() ||
      storageState !== 'full' ||
      busy ||
      opening ||
      cancelling ||
      refreshPending ||
      !replay.live() ||
      !connected()
    const cancellation = pendingCancellation()
    inputCancellation.hidden = !cancellation || !replay.live()
    inputCancellation.textContent = cancellation
      ? `此输入已禁止再次执行；${(['left', 'right'] as const)
          .map((side) => {
            const status = cancellation.states.find((item) => item.side === side)?.status
            return `${side === 'left' ? '左侧' : '右侧'}${status === 'acknowledged' ? '取消已确认' : status === 'requested' ? '正在取消' : status === 'unknown' ? '取消结果待确认' : '尚未请求取消'}`
          })
          .join(' · ')}。可停止两侧并核对持久状态。`
      : ''
    refresh.disabled = refreshPending || opening || cancelling
    reconcileDurable.disabled = !snapshot || refreshPending || opening || busy || cancelling || !replay.live()
    facts.textContent = snapshot
      ? `基线 ${snapshot.baselineId} · 摘要 ${snapshot.baselineDigest.slice(0, 12)} · 策略 ${snapshot.policyHash.slice(0, 12)}${storageState === 'released' ? ' · 运行资源已释放，历史已归档' : storageState === 'releasing' ? ' · 资源回收待完成' : ''}`
      : '在同一工作区快照、模型和默认预设下创建两个独立会话。每侧单独接收输入，可能部分失败。'
    if (!snapshot) rounds.replaceChildren()
    else if (journalMode === 'journal') rounds.replaceChildren(renderJournalRound())
    else if (journalMode === 'per-lane-only' && replay.live())
      rounds.replaceChildren(
        element('p', '当前协调状态（per-lane-only，无共享历史证据）'),
        ...snapshot.rounds.map(renderRound),
      )
    else
      rounds.replaceChildren(
        element(
          'p',
          journalMode === 'per-lane-only'
            ? 'per-lane-only：无法还原历史协调、接收或结束状态。'
            : '共享协调事实尚未载入，当前状态不参与历史回放。',
        ),
      )
  }
  function fillSetup() {
    const value = defaults()
    cwd.replaceChildren(...value.workspaces.map((item) => option(item.path, item.path)))
    if (value.cwd) cwd.value = value.cwd
    for (const select of [left, right]) {
      select.replaceChildren(
        ...value.runtimes.map((item) => {
          const itemOption = option(
            `${item.label}${item.available ? '' : `（${item.unavailableReason ?? '不可用'}）`}`,
            item.id,
          )
          itemOption.disabled = !item.available
          return itemOption
        }),
      )
      select.value = value.runtimes.find((item) => item.available)?.id ?? ''
    }
    if (value.runtimes.some((item) => item.id === 'jevloop' && item.available)) right.value = 'jevloop'
    render()
  }
  async function detach() {
    history.retire()
    epoch++
    journal?.dispose()
    journal = undefined
    replay.reset()
    metrics.reset()
    journalMode = 'loading'
    journalEntries = []
    coordinatorCursor = null
    coordinator = undefined
    if (timer) clearInterval(timer)
    timer = undefined
    const old = [...lanes.values()]
    lanes.clear()
    await Promise.allSettled(old.map((lane) => lane.dispose()))
    graphChoice.replaceChildren()
    graphChoice.hidden = true
    graphColumn.replaceChildren(graphChoice, graphEmpty)
    graphEmpty.hidden = false
    panes.replaceChildren(graphColumn)
    mobileLanes.replaceChildren()
    mobileSide = undefined
  }
  async function mountLane(lane: ComparisonLane, ticket: number) {
    if (!snapshot) return
    const comparisonId = snapshot.id
    const historical = journalMode === 'journal'
    const retired = (snapshot.storageState ?? 'full') !== 'full'
    if (retired && !historical) throw new Error('已停止运行的对比缺少共享历史，无法载入。')
    const readOnly =
      retired || (historical && snapshot.rounds.length > 0 && canSubmitRound(snapshot) && !pending)
    let committedAtSeq: number | null = null
    const section = element('section')
    section.className = 'comparison-lane'
    section.dataset.side = lane.side
    section.dataset.runtime = lane.runtime.id
    section.setAttribute('aria-label', lane.side === 'left' ? '左侧对比会话' : '右侧对比会话')
    const head = element('header')
    const state = element('p', '正在载入…')
    const transcript = element('div')
    transcript.className = 'comparison-transcript'
    const newContent = element('button', '有新内容')
    newContent.type = 'button'
    newContent.hidden = true
    const renderer = createTimelineRenderer({
      transcript,
      scrollContainer: transcript,
      newContentButton: newContent,
    })
    const approval = element('div')
    const approvalRoot = createRoot(approval)
    const questionHost = element('section')
    questionHost.dataset.agnesRegion = 'questions'
    const questions = createQuestionController(questionHost, client)
    questions.project([])
    questions.enabled(false)
    const runtimeTraceHost = element('section')
    runtimeTraceHost.hidden = lane.runtime.id === 'native'
    const graph = createJevDecisionGraph(runtimeTraceHost, { sharedReplay: true })
    const coverage = element('p', '尚无账本数据，正在载入…')
    coverage.className = 'comparison-coverage'
    coverage.setAttribute('role', 'status')
    const trace = element('details')
    const traceLabel = element('summary', '原始记录')
    trace.append(traceLabel)
    const events = element('ol')
    trace.append(events)
    let pane = new SessionPaneController(client, lane.sessionId)
    const conversationPane = element('div')
    conversationPane.className = 'comparison-conversation'
    conversationPane.append(transcript, newContent)
    const tracePanel = element('section')
    tracePanel.className = 'comparison-trace-panel'
    tracePanel.setAttribute('aria-label', `${lane.side === 'left' ? '左侧' : '右侧'}原生轨迹`)
    const traceTab = button('轨迹', () => {})
    const chatTab = button('对话', () => {})
    const nativeTrace = createComparisonTrace(tracePanel, {
      sessionId: lane.sessionId,
      toggle: traceTab,
      chatToggle: chatTab,
      conversation: conversationPane,
      readToolDetail: (sessionId, callSeq, resultSeq, signal) => {
        if (historical) {
          if (sessionId !== lane.sessionId || committedAtSeq === null || !committedTimeline)
            throw new Error('工具详情不属于当前显示的对比位置。')
          return client.comparison.toolDetail(
            {
              id: comparisonId,
              side: lane.side,
              atSeq: committedAtSeq,
              callSeq,
              ...(resultSeq === undefined ? {} : { resultSeq }),
            },
            {
              ...(signal ? { signal } : {}),
              expectedSource: { sessionId: lane.sessionId, throughSeq: committedTimeline.upto },
            },
          )
        }
        const session = pane.session
        if (!session || session.id !== sessionId) throw new Error('对比会话已经关闭或切换。')
        return session.readToolDetail(callSeq, resultSeq, signal ? { signal } : undefined)
      },
    })
    nativeTrace.setOpen(workspaceView === 'trace')
    let timeline: UITimeline | undefined
    let streamTimeline: UITimeline | undefined
    let committedTimeline: ComparisonTimeline | undefined
    type LiveRequest = {
      identity: number
      request: PermissionRequest
      signal: AbortSignal
      afterSeq: number
      generation?: number
      finish(outcome: PermissionOutcome): void
    }
    let liveRequest: LiveRequest | undefined
    let approvalBusy = false
    let interactionsMutable = false
    let disposed = false
    let opened = false
    let ledgerEvents: readonly EventEnvelope[] = []
    let ledgerState: import('./comparison-replay.js').ComparisonReplayLane = {
      events: [],
      complete: false,
      loading: false,
    }
    const updateLedger = (value: import('./comparison-replay.js').ComparisonReplayLane, text: string) => {
      if (disposed) return
      ledgerState = value
      ledgerEvents = value.events
      coverage.textContent = text
      earlier.textContent = value.complete ? '加载更早对话' : '继续读取账本与更早对话'
      earlier.disabled = value.loading
      replay.update(lane.side, value)
    }
    const cutLedger = historical
      ? createComparisonCutLedger(
          client,
          { id: comparisonId, side: lane.side, sessionId: lane.sessionId },
          updateLedger,
        )
      : undefined
    const ledger = cutLedger ?? createComparisonLedger(client, lane.sessionId, updateLedger)
    // Cancellation or a terminal snapshot retires this round even before the lane ledger catches up.
    // Keep its tickets retired after a new round starts; a delayed old projection is not fresh authority.
    const rememberApprovalFence = () => {
      const fence = approvalFences.get(lane.sessionId) ?? {
        roundIds: new Set<string>(),
        tickets: new Set<string>(),
      }
      for (const round of snapshot?.rounds ?? []) fence.roundIds.add(round.inputId)
      if (pending) fence.roundIds.add(pending.inputId)
      approvalFences.set(lane.sessionId, fence)
      return fence
    }
    const approvalBlocked = () => {
      const roundId = pending?.inputId ?? snapshot?.rounds.at(-1)?.inputId
      const fence = approvalFences.get(lane.sessionId)
      if (fence && (roundId === undefined || fence.roundIds.has(roundId))) return true
      const round = snapshot?.rounds.find((item) => item.inputId === roundId)
      return (
        round?.settledSides.includes(lane.side) === true ||
        round?.terminalCauses?.some((item) => item.side === lane.side) === true ||
        snapshot?.inputCancellations?.some(
          (item) => item.inputId === roundId && item.states.some((state) => state.side === lane.side),
        ) === true
      )
    }
    const retiredApproval = (node: Extract<UITimeline['nodes'][number], { kind: 'approval' }>) =>
      approvalFences.get(lane.sessionId)?.tickets.has(node.ticket ?? node.id) === true
    const currentRequest = (request: LiveRequest) =>
      liveRequest === request &&
      !disposed &&
      epoch === ticket &&
      snapshot?.id === comparisonId &&
      !approvalBlocked() &&
      request.request.sessionId === lane.sessionId &&
      !request.signal.aborted &&
      (request.request.deadlineMs === undefined || request.request.deadlineMs > Date.now()) &&
      (request.generation === undefined || timeline?.generation === request.generation) &&
      !ledgerEvents.some((event) => event.type === 'turn/end' && event.seq > request.afterSeq) &&
      !timeline?.turns.some((turn) => turn.endSeq !== undefined && turn.endSeq > request.afterSeq)
    const drawApproval = () => {
      if (disposed) return
      if (liveRequest && !currentRequest(liveRequest)) {
        liveRequest.finish({ verdict: 'rejected' })
        return
      }
      const durable = committedTimeline?.nodes.find(
        (node): node is Extract<UITimeline['nodes'][number], { kind: 'approval' }> =>
          node.kind === 'approval' && node.state === 'pending',
      )
      const liveApproval = timeline?.nodes.find(
        (node): node is Extract<UITimeline['nodes'][number], { kind: 'approval' }> =>
          node.kind === 'approval' && node.state === 'pending',
      )
      const matchingRequest =
        replay.live() && liveRequest && currentRequest(liveRequest) ? liveRequest : undefined
      if (approvalBlocked()) {
        const fence = rememberApprovalFence()
        for (const node of [durable, liveApproval]) if (node) fence.tickets.add(node.ticket ?? node.id)
      }
      let view: ApprovalView | undefined
      const decide = (current: () => boolean, action: () => Promise<void>) =>
        run(async () => {
          if (
            disposed ||
            approvalBusy ||
            approvalBlocked() ||
            !connected() ||
            !interactionsMutable ||
            !replay.live() ||
            (snapshot?.storageState ?? 'full') !== 'full' ||
            !current()
          )
            return
          approvalBusy = true
          drawApproval()
          try {
            await action()
            live?.refresh()
          } finally {
            approvalBusy = false
            drawApproval()
          }
        })
      if (matchingRequest) {
        const request = matchingRequest
        const labels: Record<string, string> = {
          allow_once: '仅允许这次',
          allow_always: '本会话允许',
          reject_once: '拒绝',
          reject_always: '始终拒绝',
        }
        const rawInput = request.request.toolCall.rawInput
        const preview = rawInput === undefined ? undefined : JSON.stringify(rawInput, null, 2)
        view = {
          key: String(request.request.toolCall.toolCallId),
          title: interactionsMutable ? '需要确认' : '已记录审批（只读）',
          summary:
            typeof request.request.toolCall.title === 'string'
              ? request.request.toolCall.title
              : '允许执行此操作？',
          impact: lane.workspaceLabel,
          ...(preview === undefined ? {} : { preview: preview.slice(0, 2048) }),
          disabled: approvalBusy || !connected() || !interactionsMutable,
          actions: request.request.options.map((option) => ({
            id: option.optionId,
            label: labels[option.name] ?? option.name,
            onSelect: () =>
              decide(
                () => currentRequest(request),
                async () => request.finish({ optionId: option.optionId }),
              ),
          })),
        }
      } else if (durable) {
        const approvalTicket = durable.ticket
        const actionable =
          interactionsMutable &&
          connected() &&
          activePermission() !== 'view' &&
          !approvalBlocked() &&
          !retiredApproval(durable) &&
          approvalTicket !== undefined &&
          liveApproval?.ticket === approvalTicket
        view = {
          key: approvalTicket ?? durable.id,
          title: actionable ? '需要确认' : '已记录审批（只读）',
          summary: durable.summary,
          impact: lane.workspaceLabel,
          disabled: approvalBusy || !actionable,
          actions: durableApprovalActions(durable).map((action) => ({
            id: action.option,
            label: action.label,
            onSelect: () =>
              decide(
                () =>
                  approvalTicket !== undefined &&
                  !retiredApproval(durable) &&
                  (timeline ? webView(timeline).approval?.ticket : undefined) === approvalTicket &&
                  committedTimeline?.nodes.some(
                    (node) =>
                      node.kind === 'approval' && node.state === 'pending' && node.ticket === approvalTicket,
                  ) === true,
                async () => {
                  await client.approval.decide(approvalTicket!, action.verdict, { kind: 'local' })
                },
              ),
          })),
        }
      }
      approvalRoot.render(
        createElement(Approval, {
          key: view
            ? JSON.stringify([
                view.key,
                matchingRequest?.identity,
                view.disabled,
                view.title,
                view.summary,
                view.preview,
                view.actions.map((action) => [action.id, action.label]),
              ])
            : 'empty',
          ...(view ? { initialView: view } : {}),
        }),
      )
    }
    let live: ReturnType<SessionPaneController['project']> | undefined
    const cancel = button('停止此侧', () => run(() => cancelComparison(lane.side)))
    const earlier = button('加载更早记录', () =>
      run(async () => {
        await Promise.all([ledger.read(), live?.loadEarlier()])
      }),
    )
    head.append(
      element(
        'h3',
        `${lane.runtime.id === 'jevloop' ? 'JevLoop' : lane.runtime.id === 'native' ? 'Native' : lane.runtime.id} · ${lane.side === 'left' ? '左侧' : '右侧'}`,
      ),
      cancel,
    )
    const directStats = createJevDirectStats(head, 'comparison')
    const pendingStats = () => directStats.update({ runtime: lane.runtime, events: [], complete: false })
    pendingStats()
    const body = element('div')
    body.className = 'comparison-lane-body'
    const info = element('div')
    info.className = 'comparison-lane-info'
    const permission = snapshot?.prepared?.[lane.side]?.configuration.effective.permission
    const confined =
      permission?.enforcement?.level === 'full' &&
      permission.enforcement.scope.includes('file') &&
      !permission.yolo
    info.append(
      element('p', lane.workspaceLabel),
      element('p', confined ? '写入沙箱已启用（准备时验证）' : '历史记录未证明完整写入沙箱，建议新建对比'),
      state,
      earlier,
    )
    body.append(info, conversationPane, tracePanel, approval, coverage, trace)
    const childHistory = createComparisonChildHistory(info, client, { id: comparisonId, side: lane.side })
    section.append(head, questionHost, body)
    if (lane.runtime.id === 'jevloop') {
      graphEmpty.hidden = true
      runtimeTraceHost.dataset.side = lane.side
      const previous = graphChoice.value
      graphChoice.append(option(`JevLoop · ${lane.side === 'left' ? '左侧' : '右侧'}`, lane.side))
      graphChoice.value = previous || lane.side
      graphChoice.hidden = graphChoice.options.length < 2
      runtimeTraceHost.hidden = graphChoice.value !== lane.side
      graphColumn.append(runtimeTraceHost)
      graphColumn.after(section)
    } else panes.append(section)
    const mobileTab = button(
      lane.runtime.id === 'jevloop' ? 'JevLoop' : lane.runtime.id === 'native' ? 'Native' : lane.runtime.id,
      () => selectMobileSide(lane.side),
    )
    mobileTab.dataset.side = lane.side
    if (lane.runtime.id === 'jevloop') mobileLanes.prepend(mobileTab)
    else mobileLanes.append(mobileTab)
    selectMobileSide(lane.runtime.id === 'jevloop' ? lane.side : (mobileSide ?? lane.side))
    lanes.set(lane.side, {
      view(value) {
        nativeTrace.setOpen(value === 'trace')
      },
      retireApprovals(cancel) {
        if (cancel) rememberApprovalFence()
        liveRequest?.finish({ verdict: 'rejected' })
        drawApproval()
      },
      mutable(live) {
        live = live && (snapshot?.storageState ?? 'full') === 'full'
        interactionsMutable = live && opened
        cancel.disabled = !live || !canCancel(lane.side)
        questions.enabled(live && opened)
        drawApproval()
        if (!live && committedTimeline) renderer.render(committedTimeline.nodes, committedTimeline.turns)
      },
      connect,
      cut: (atSeq, throughSeq) => cutLedger?.cut(atSeq, throughSeq),
      async prepare(cut, atSeq) {
        pendingStats()
        if ((!historical && !opened) || disposed || cut > (ledgerEvents.at(-1)?.seq ?? 0)) return undefined
        let value: ComparisonTimeline
        if (historical) {
          if (atSeq === null) return undefined
          const result = await client.comparison.projectUI({
            id: comparisonId,
            side: lane.side,
            atSeq,
            surface: 'web',
          })
          if (
            result.id !== comparisonId ||
            result.side !== lane.side ||
            result.atSeq !== atSeq ||
            result.sessionId !== lane.sessionId ||
            result.throughSeq !== cut
          )
            throw new Error('对比投影返回了不同的共享位置')
          value = result.timeline
        } else {
          value = await client.call<UITimeline>('_agnes/v1/session.projectUI', {
            sessionId: lane.sessionId,
            upto: cut,
            surface: 'web',
          })
        }
        if (disposed) return undefined
        if (value.sessionId !== lane.sessionId || value.upto !== cut)
          throw new Error('对比投影返回了不同的账本位置')
        return () => {
          committedAtSeq = atSeq
          drawPrefix(value, cut)
        }
      },
      dispose: async () => {
        disposed = true
        liveRequest?.finish({ verdict: 'rejected' })
        questions.dispose()
        ledger.dispose()
        graph.dispose()
        nativeTrace.dispose()
        childHistory.dispose()
        renderer.dispose?.()
        await pane.dispose()
        approvalRoot.unmount()
      },
    })
    const drawConversation = (value: ComparisonTimeline) => {
      const preview = streamTimeline
      const matching =
        replay.live() &&
        preview?.sessionId === value.sessionId &&
        preview.generation === (value.generation ?? timeline?.generation) &&
        (!historical || timeline?.upto === value.upto) &&
        preview.upto === value.upto
      const streamed = matching ? new Map(preview.nodes.map((node) => [node.id, node])) : undefined
      const nodes = value.nodes.map((node) => {
        const overlay = streamed?.get(node.id)
        return node.kind === 'assistant' &&
          node.streaming &&
          node.effectId !== undefined &&
          overlay?.kind === 'assistant' &&
          overlay.streaming &&
          overlay.effectId === node.effectId
          ? {
              ...node,
              text: overlay.text,
              ...(overlay.thinking === undefined ? {} : { thinking: overlay.thinking }),
            }
          : node
      })
      renderer.render(nodes, value.turns)
    }
    const drawPrefix = (value: ComparisonTimeline, cut: number) => {
      if (disposed) return
      committedTimeline = value
      const prefix = ledgerEvents.filter((event) => event.seq <= cut)
      directStats.update({ runtime: lane.runtime, events: prefix, complete: true })
      const pendingQuestions = new Map<string, import('@agnes/protocol').QuestionInteraction>()
      for (const event of prefix) {
        if (event.origin !== 'system' || event.trust !== 'trusted') continue
        if (event.type === 'question/requested') {
          const data = event.data as import('@agnes/protocol').QuestionRequestedData
          pendingQuestions.set(data.interactionId, {
            ...data,
            sessionId: lane.sessionId,
            requestedSeq: event.seq,
          })
        } else if (event.type === 'question/settled') {
          const data = event.data as import('@agnes/protocol').QuestionSettledData
          if (pendingQuestions.get(data.interactionId)?.requestedSeq === data.requestedSeq)
            pendingQuestions.delete(data.interactionId)
        }
      }
      questions.project([...pendingQuestions.values()])
      graph.update(prefix, lane.sessionId)
      section.dataset.cut = String(cut)
      const view = webView(value)
      state.textContent = `${view.status} · #${value.upto}`
      drawConversation(value)
      nativeTrace.render(value, cut)
      childHistory.render(value, committedAtSeq, snapshot?.storageState === 'released' && replay.live())
      events.replaceChildren(
        ...prefix.map((event) => {
          const row = element('li')
          const item = element('details')
          const data = event.data as { record?: { kind?: string } }
          item.append(
            element(
              'summary',
              `#${event.seq} ${event.type}${data.record?.kind ? ` · ${data.record.kind}` : ''}`,
            ),
          )
          const raw = JSON.stringify(event.data, null, 2)
          item.append(
            element('pre', raw.length > 16_384 ? `${raw.slice(0, 16_384)}\n（此记录显示已截断）` : raw),
          )
          row.append(item)
          return row
        }),
      )
      traceLabel.textContent = `原始记录 · #0–${cut} · ${prefix.length} 条记录`
      drawApproval()
    }
    const draw = (value: UITimeline) => {
      if (disposed) return
      timeline = value
      if (liveRequest && !currentRequest(liveRequest)) liveRequest.finish({ verdict: 'rejected' })
      ledger.head(value.upto)
      if (replay.live()) void journal?.read()
      drawApproval()
    }
    let connecting: Promise<void> | undefined
    function connect(): Promise<void> {
      if ((snapshot?.storageState ?? 'full') !== 'full')
        return Promise.reject(new Error('此对比已停止继续运行。'))
      if (opened) return Promise.resolve()
      if (connecting) return connecting
      connecting = openLive()
        .catch(async (error: unknown) => {
          try {
            await pane.dispose()
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], '会话连接失败，断开连接也未确认；可重试。')
          } finally {
            questions.select()
            live = undefined
            timeline = undefined
            streamTimeline = undefined
            if (!disposed) pane = new SessionPaneController(client, lane.sessionId)
          }
          throw error
        })
        .finally(() => {
          connecting = undefined
        })
      return connecting
    }
    async function openLive() {
      await pane.open(
        (request, context) =>
          new Promise<PermissionOutcome>((resolve) => {
            const pendingRequest: LiveRequest = {
              identity: ++permissionRequestIdentity,
              request,
              signal: context.signal,
              afterSeq: Math.max(timeline?.upto ?? 0, ledgerEvents.at(-1)?.seq ?? 0, lane.lastSeq),
              ...(timeline?.generation === undefined ? {} : { generation: timeline.generation }),
              finish: (outcome: PermissionOutcome) => {
                context.signal.removeEventListener('abort', abort)
                if (liveRequest === pendingRequest) {
                  liveRequest = undefined
                  pendingPermissions.delete(lane.side)
                }
                drawApproval()
                renderPermission()
                resolve(context.signal.aborted ? { verdict: 'rejected' } : outcome)
              },
            }
            const abort = () => pendingRequest.finish({ verdict: 'rejected' })
            if (
              context.signal.aborted ||
              disposed ||
              request.sessionId !== lane.sessionId ||
              approvalBlocked() ||
              activePermission() === 'view' ||
              !connected() ||
              (request.deadlineMs !== undefined && request.deadlineMs <= Date.now())
            ) {
              resolve({ verdict: 'rejected' })
              return
            }
            liveRequest?.finish({ verdict: 'rejected' })
            liveRequest = pendingRequest
            pendingPermissions.add(lane.side)
            context.signal.addEventListener('abort', abort, { once: true })
            drawApproval()
            renderPermission()
          }),
        undefined,
        lane.runtime,
      )
      if (epoch !== ticket || disposed) return
      live = pane.project({
        timeline: (value, window) => {
          draw(value)
          if (window?.reason === 'opening') void questions.refresh()
        },
        stream: (value) => {
          if (disposed) return
          streamTimeline = value
          if (replay.live() && committedTimeline) drawConversation(committedTimeline)
        },
        error: fail,
        event: (event) => {
          questions.event(event)
          ledger.head(event.seq)
          if (replay.live()) void journal?.read()
        },
      })
      await live.start()
      if (!disposed && epoch === ticket) {
        opened = true
        questions.select(lane.sessionId)
        questions.enabled(replay.live())
        replay.update(lane.side, ledgerState)
      }
    }
    if (cutLedger) {
      const last = journalEntries.at(-1)
      cutLedger.cut(last?.seq ?? 0, last?.cuts[lane.side] ?? 0)
    }
    if (!readOnly) await connect()
    if (!timeline) ledger.head(lane.lastSeq)
  }
  async function mount(strict = false) {
    if (!snapshot) return
    await detach()
    const ticket = epoch
    const id = snapshot.id
    journal = createComparisonJournal(client, id, snapshot.lanes, (value) => {
      if (ticket !== epoch || snapshot?.id !== id) return
      journalMode = value.mode
      journalEntries = value.entries
      if (value.mode === 'journal' && !value.loading) {
        const cuts = value.entries.at(-1)?.cuts ?? { left: 0, right: 0 }
        for (const [side, lane] of lanes) lane.cut(value.throughSeq, cuts[side])
      }
      replay.updateJournal(value)
      render()
      if (value.mode === 'per-lane-only')
        metrics.unavailable('per-lane-only：此对比无共享 journal，无法选择共享前缀计量。')
      else if (value.error) metrics.unavailable(value.error)
    })
    await journal.read()
    if (ticket !== epoch || snapshot?.id !== id || journalMode === 'error') return
    opening = true
    render()
    try {
      const results = await Promise.allSettled(snapshot.lanes.map((lane) => mountLane(lane, ticket)))
      for (const result of results) if (result.status === 'rejected') fail(result.reason)
      if (strict) {
        const failed = results.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
      if (epoch === ticket) timer = setInterval(() => run(refreshSnapshot), 3000)
    } finally {
      if (epoch === ticket) {
        opening = false
        render()
      }
    }
  }
  async function refreshSnapshot(durable = false) {
    if (!snapshot || refreshPending || cancelling || (durable && !replay.live())) return
    refreshPending = true
    render()
    const ticket = epoch
    const id = snapshot.id
    try {
      const next = await (durable ? client.comparison.reconcile(id) : client.comparison.get(id))
      if (ticket !== epoch || snapshot?.id !== id) return
      const storageChanged = (snapshot.storageState ?? 'full') !== (next.storageState ?? 'full')
      snapshot = next
      if ((next.storageState ?? 'full') !== 'full') pending = undefined
      if (pending && !clearAcknowledgedCancellation()) {
        const found = snapshot.rounds.find((round) => round.inputId === pending?.inputId)
        if (found?.acceptances.every((item) => item.status !== 'unknown')) {
          pending = undefined
          creation = undefined
          message.textContent = '已确认两侧接收结果。'
        } else
          message.textContent =
            pendingFailure?.input === pending && message.textContent === pendingFailure.message
              ? pendingFailure.message
              : '上次输入的接收结果待确认；保留输入标识，可核对持久状态。'
      }
      save()
      if (storageChanged) await mount(true)
      else await journal?.read()
    } finally {
      refreshPending = false
      render()
    }
  }
  async function retireComparison(operation: 'release' | 'remove') {
    if (!snapshot || !canSwitch() || refreshPending || !replay.live()) return
    const current = snapshot
    const state = current.storageState ?? 'full'
    if (
      operation === 'release'
        ? !['full', 'releasing'].includes(state) ||
          (state === 'full' && (['preparing', 'running'].includes(current.phase) || !roundsSettled(current)))
        : !['released', 'removing'].includes(state)
    )
      return
    if (
      !window.confirm(
        operation === 'release'
          ? '永久结束此对比的继续运行，并释放其私有运行资源？已记录的对话、轨迹和子任务历史会保留。'
          : '永久删除此对比的对话、轨迹和子任务历史？删除后无法恢复。',
      )
    )
      return
    busy = true
    render()
    try {
      const request = { id: current.id, expectedRevision: current.revision }
      if (operation === 'release') {
        const next = await client.comparison.release(request)
        if (snapshot?.id !== current.id) return
        if (next.id !== current.id || next.storageState !== 'released') throw new Error('回收结果尚未确认。')
        if ('kind' in next) {
          await detach()
          snapshot = undefined
          pending = undefined
          creation = undefined
          pendingCreate = undefined
          forgetComparisonEntry(current.id)
          await navigation.select?.(undefined)
          input.value = ''
          fillSetup()
          message.textContent = '准备失败的运行资源已释放；此记录没有完整双侧历史。'
          await history.refresh()
          return
        }
        snapshot = next
        save()
        await mount(true)
        message.textContent = '运行资源已释放；可以继续查看已归档的对话、轨迹和子任务。'
      } else {
        const result = await client.comparison.remove(request)
        if (snapshot?.id !== current.id) return
        if (result.id !== current.id || result.storageState !== 'removed')
          throw new Error('删除结果尚未确认。')
        await detach()
        snapshot = undefined
        pending = undefined
        drafts.delete(current.id)
        forgetComparisonEntry(current.id)
        creation = undefined
        await navigation.select?.(undefined)
        input.value = ''
        fillSetup()
        message.textContent = '对比记录已删除。'
      }
      await history.refresh()
    } catch (error) {
      message.textContent = `操作未确认，保留当前记录，可刷新状态后重试：${error instanceof Error ? error.message : '请重试'}`
    } finally {
      busy = false
      render()
    }
  }
  setup.addEventListener('submit', (event) => {
    event.preventDefault()
    run(async () => {
      if (restoreFailed || busy || opening || cancelling || pending) return
      const ticket = selection
      busy = true
      render()
      message.textContent = '正在准备工作区快照…'
      try {
        const model = defaults().model
        pendingCreate ??= {
          requestId: crypto.randomUUID(),
          cwd: cwd.value,
          left: { runtime: left.value },
          right: { runtime: right.value },
          isolation: 'snapshot',
          permissionMode: selectedPermission(),
          ...(model ? { model } : {}),
        }
        creation ??= { params: pendingCreate }
        save()
        await navigation.select?.(pendingCreate.requestId)
        if (ticket !== selection || !dialog.open) return
        const request = pendingCreate
        const created = await client.comparison.create(request)
        if (ticket !== selection || !dialog.open) return
        if (created.id !== request.requestId) throw new Error('创建返回了不同的对比身份。')
        snapshot = created
        pendingCreate = undefined
        pending = undefined
        if (!creation?.firstInput) creation = undefined
        save()
        message.textContent = ''
        if (dialog.open) await mount()
      } finally {
        if (ticket === selection) {
          busy = false
          render()
        }
      }
    })
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    run(() => submitInput())
  })
  async function submitInput(retry = false) {
    if (
      !snapshot ||
      (snapshot.storageState ?? 'full') !== 'full' ||
      (retry ? !pending || !!pendingCancellation() : !canSubmitRound(snapshot) || pending !== undefined) ||
      busy ||
      cancelling ||
      opening ||
      !replay.live() ||
      !connected() ||
      !input.value.trim()
    )
      return
    const submitEpoch = epoch
    const submitId = snapshot.id
    const text = retry ? pending!.text : input.value
    const current = () => dialog.open && epoch === submitEpoch && snapshot?.id === submitId
    busy = true
    render()
    try {
      await Promise.all([...lanes.values()].map((lane) => lane.connect()))
    } catch (error) {
      if (!current()) return
      busy = false
      render()
      throw error
    }
    if (!current()) return
    if (creation?.firstInput && text !== creation.firstInput.text) {
      busy = false
      render()
      throw new Error('首次输入尚待确认，请保留原文完成提交或取消后再发送新任务。')
    }
    const priorPending = pending
    pending ??= creation?.firstInput ?? {
      inputId: crypto.randomUUID(),
      text,
      permissionMode: selectedPermission(),
    }
    renderPermission()
    try {
      save()
    } catch (error) {
      pending = priorPending
      busy = false
      render()
      throw error
    }
    const submitted = { id: snapshot.id, ...pending }
    try {
      const round = await client.comparison.submit({
        id: submitted.id,
        inputId: submitted.inputId,
        content: [{ type: 'text', text: submitted.text }],
        ...(submitted.permissionMode === undefined ? {} : { permissionMode: submitted.permissionMode }),
      })
      if (!current()) return
      pendingFailure = undefined
      snapshot = {
        ...snapshot,
        permissionMode:
          round.permissionMode ?? submitted.permissionMode ?? comparisonPermissionMode(snapshot),
        rounds: [...snapshot.rounds.filter((item) => item.inputId !== round.inputId), round],
      }
      if (round.acceptances.every((item) => item.status !== 'unknown')) {
        permissionChoice = undefined
        pending = undefined
        creation = undefined
        input.value = ''
      }
      message.textContent = pending ? '部分接收结果待确认，请刷新查询。' : '已返回两侧接收结果。'
      save()
    } catch (error) {
      if (!current()) return
      // A refusal of a retry proves nothing about the earlier invocation whose reply was lost.
      if (!retry && rejectedBeforeAdmission(error, submitted.id, submitted.inputId)) {
        pending = undefined
        save()
        // Refresh updates the active-round gate; it is not evidence of non-admission.
        await refreshSnapshot().catch(() => {})
        if (!current()) return
        const reason = error instanceof JsonRpcError ? error.data.admissionReason : undefined
        message.textContent =
          reason === 'configuration-changed' || reason === 'prepared-source-invalid'
            ? '本次输入尚未接收，草稿已保留。准备配置已变化或无法核验，请新建对比；刷新不会更新这组冻结配置。'
            : reason === 'resource-recovery-required'
              ? '本次输入尚未接收，草稿已保留。运行资源需要恢复，请核对后台状态后再提交。'
              : '本次输入尚未接收，草稿已保留。等待两侧完成或刷新状态后可再次提交。'
      } else {
        message.textContent = `连接未确认提交结果，已保留输入标识。可核对持久状态或显式重试原请求。${error instanceof Error ? error.message : ''}`
        if (pending) pendingFailure = { input: pending, message: message.textContent }
      }
    } finally {
      if (current()) {
        busy = false
        render()
      }
    }
  }
  input.addEventListener('input', () => {
    save()
    render()
  })
  dialog.addEventListener('close', () => {
    permissionPicker.close()
    offConnection?.()
    offConnection = undefined
    selection++
    opening = false
    busy = false
    cancelling = false
    run(detach)
  })
  async function openEntry(id?: string): Promise<boolean> {
    if (dialog.open) {
      if (!id || snapshot?.id === id || creation?.params.requestId === id) return !opening
      throw new Error('请先关闭当前对比视图。')
    }
    const previous = comparisonPermissionEntry(readComparisonEntry(id)) ?? (id ? { id } : undefined)
    workspaceView = 'chat'
    dialog.show()
    watchConnection()
    const ticket = ++selection
    fillSetup()
    opening = true
    render()
    try {
      await detach()
      if (ticket !== selection || !dialog.open) return false
      snapshot = undefined
      permissionChoice = undefined
      pending = undefined
      creation = undefined
      pendingCreate = undefined
      restoreFailed = !!previous
      if (previous) {
        pending = previous.pending
        creation = previous.creation
        pendingCreate = creation?.params
        input.value =
          pending?.text ?? creation?.firstInput?.text ?? previous.draft ?? drafts.get(previous.id) ?? ''
        await navigation.select?.(previous.id)
        let restored: ComparisonSnapshot
        try {
          restored = await client.comparison.get(previous.id)
        } catch (error) {
          if (ticket !== selection || !dialog.open) return false
          if (creation && error instanceof JsonRpcError && error.data.code === 'COMPARISON_NOT_FOUND') {
            snapshot = undefined
            message.textContent = '首次创建尚未确认；已保留原工作区、配置和输入，可显式重试创建。'
            restoreFailed = false
            return true
          }
          throw error
        }
        if (ticket !== selection || !dialog.open) return false
        if (restored.id !== previous.id) throw new Error('恢复返回了不同的对比记录。')
        snapshot = restored
        restoreFailed = false
        pendingCreate = undefined
        const first = creation?.firstInput
        if (first) {
          const round = snapshot.rounds.find((item) => item.inputId === first.inputId)
          if (round) {
            pending = round.acceptances.some((item) => item.status === 'unknown') ? first : undefined
            if (!pending) {
              creation = undefined
              if (input.value === first.text) input.value = ''
            }
          }
        }
        save()
        await mount()
        if (ticket !== selection || !dialog.open) return false
        await refreshSnapshot()
      }
      return ticket === selection && dialog.open
    } catch (error) {
      if (ticket === selection && dialog.open) fail(error)
      throw error
    } finally {
      if (ticket === selection) {
        opening = false
        render()
        if (dialog.open) void history.refresh()
      }
    }
  }
  async function startDraft(requestId: string, text: string) {
    if (dialog.open || busy || opening || cancelling) throw new Error('请先关闭当前对比视图。')
    const previous = comparisonPermissionEntry(readComparisonEntry(requestId))
    if (previous?.pending) throw new Error('上次对比输入尚待确认，请打开双线对比核对后再新建。')
    const value = defaults()
    if (
      !previous?.creation &&
      (!value.cwd ||
        !['native', 'jevloop'].every((id) => value.runtimes.some((r) => r.id === id && r.available)))
    )
      throw new Error('请选择可用工作区，并确认 Native 与 JevLoop 均可用。')
    creation = previous?.creation ?? {
      params: {
        requestId,
        cwd: value.cwd ?? '',
        left: { runtime: 'native' },
        right: { runtime: 'jevloop' },
        isolation: 'snapshot',
        permissionMode: value.permissionMode ?? 'workspace',
        ...(value.model ? { model: value.model } : {}),
      },
      firstInput: { inputId: crypto.randomUUID(), text, permissionMode: value.permissionMode ?? 'workspace' },
    }
    if (creation.firstInput && creation.firstInput.text !== text)
      throw new Error('首次输入尚待确认，请使用保留的原输入重试。')
    pendingCreate = creation.params
    input.value = creation.firstInput?.text ?? text
    writeComparisonEntry({ id: requestId, creation, draft: input.value })
    await navigation.select?.(requestId)
    workspaceView = 'chat'
    dialog.show()
    watchConnection()
    const ticket = ++selection
    const assertCurrent = () => {
      if (ticket !== selection || !dialog.open) throw new Error('对比视图已关闭；草稿已保留，可重试原创建。')
    }
    opening = true
    render()
    try {
      if (draftRequestId !== requestId) {
        if (snapshot) drafts.set(snapshot.id, input.value)
        await detach()
        assertCurrent()
        snapshot = undefined
        draftRequestId = requestId
      }
      input.value = creation.firstInput?.text ?? text
      fillSetup()
      if (!snapshot) {
        message.textContent = '正在准备双线工作区…'
        const created = await client.comparison.create(pendingCreate)
        assertCurrent()
        if (created.id !== requestId) throw new Error('创建返回了不同的对比身份。')
        snapshot = created
        pendingCreate = undefined
        save()
      }
      await mount()
      assertCurrent()
      message.textContent = ''
    } catch (error) {
      if (ticket === selection) dialog.close()
      throw error
    } finally {
      if (ticket === selection) {
        opening = false
        render()
      }
    }
    await submitInput()
    void history.refresh()
  }
  return {
    startDraft,
    async open(id?: string) {
      if (dialog.open && id && id !== snapshot?.id && id !== creation?.params.requestId) dialog.close()
      await openEntry(id)
    },
    close() {
      if (dialog.open) dialog.close()
    },
    async submitDraft(id: string, text: string) {
      if (!(await openEntry(id))) throw new Error('对比视图已关闭或切换；输入保留，请显式重新提交。')
      if (pending) throw new Error('上次输入接收结果待确认，请先核对或重试原请求。')
      if (!snapshot && creation) {
        dialog.close()
        await startDraft(id, text)
        return
      }
      if (
        !snapshot ||
        snapshot.id !== id ||
        !canSubmitRound(snapshot) ||
        busy ||
        opening ||
        cancelling ||
        !replay.live()
      )
        throw new Error('当前对比尚不能接收新输入，请等待两侧结束或核对状态。')
      input.value = text
      save()
      await submitInput()
    },
  }
}
