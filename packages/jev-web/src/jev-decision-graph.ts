import { assertRuntimeRecord } from '@agnes/jev-runtime'
import { projectTrace, type TraceEntry, type TraceHead, type TraceRequest } from '@agnes/jev-trace'
import type { EventEnvelope } from '@agnes/protocol'
import { createJevRequestViewer } from './jev-request-viewer.js'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? ''
const text = (value: unknown) => (typeof value === 'string' ? value : json(value))
function el<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string) {
  const node = document.createElement(tag)
  if (content !== undefined) node.textContent = content
  return node
}

/** Host sequence is the cursor. Portable turn/step IDs, never display labels, define grouping. */
export function jevTraceEntries(events: readonly EventEnvelope[]): TraceEntry[] {
  const turns = new Map<string, number>()
  const steps = new Map<string, Map<string, number>>()
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((event) => {
      if (event.type !== 'runtime/record') return []
      const data = object(event.data)
      if (object(data?.runtime)?.id !== 'jevloop') return []
      if (object(data?.runtime)?.version !== '1') throw new Error('不支持的 Jev runtime 版本')
      const record = data?.record
      assertRuntimeRecord(record)
      if (!turns.has(record.turn)) turns.set(record.turn, turns.size + 1)
      let numbers = steps.get(record.turn)
      if (!numbers) {
        numbers = new Map()
        steps.set(record.turn, numbers)
      }
      if (record.step !== undefined && !numbers.has(record.step)) numbers.set(record.step, numbers.size + 1)
      return [
        {
          seq: event.seq,
          time: Date.parse(event.ts),
          turn: turns.get(record.turn)!,
          ...(record.step === undefined ? {} : { step: numbers.get(record.step)! }),
          record,
        },
      ]
    })
}

const status: Record<TraceHead['status'], string> = {
  pending: '等待采用证据',
  unconsumed: '未采用',
  consumed: '已采用',
  supporting: '门控支持（非采用）',
  deterministic: '确定常量（无概率）',
  invalid: '采用证据无效',
}
const requestText = (request?: TraceRequest) =>
  request
    ? `${request.observedModel ?? request.requestedModel ?? request.backend}\n请求 #${request.requestedSeq}\n${request.settledSeq ? `结算 #${request.settledSeq} · ${request.status}` : '未观测结算'}`
    : '未观测请求'

/** A fixed conversation cut the graph owns while all-turn replay scrubs the durable ledger. */
export type JevReplayCut = { sessionId: string; through: number }

/** Instance-local, read-only circuit. Every highlighted edge is backed by committed evidence. */
export function createJevDecisionGraph(
  host: HTMLElement,
  options: { sharedReplay?: boolean; onCut?: (cut: JevReplayCut | undefined) => void } = {},
) {
  const root = el('section')
  root.className = 'jev-decision-graph'
  root.setAttribute('aria-label', 'Jev 决策流程图')
  function button(label: string, action: () => void, content = label) {
    const node = el('button', content)
    node.type = 'button'
    node.setAttribute('aria-label', label)
    node.title = label
    node.addEventListener('click', action)
    return node
  }
  const toolbar = el('div')
  toolbar.className = 'jev-graph-toolbar'
  const select = el('select')
  select.setAttribute('aria-label', 'Jev 轮次与步骤')
  const actionSelect = el('select')
  actionSelect.setAttribute('aria-label', 'Jev 步骤动作')
  actionSelect.hidden = true
  const previous = button('上一步', () => navigate(-1), '‹')
  const next = button('下一步', () => navigate(1), '›')
  const follow = button(
    '跟随最新',
    () => {
      through = undefined
      selected = ''
      replayTurn = ''
      allTurns = false
      scopeSelect.value = 'turn'
      pause()
      closeInspector()
      draw()
    },
    '实时',
  )
  const candidatesButton = button('查看候选与采用关系', () => showPanel('candidates'), '候选')
  const historyButton = button('查看调用轨迹', () => showPanel('history'), '轨迹')
  let requestViewer: ReturnType<typeof createJevRequestViewer> | undefined
  let activeRequestSeq: number | undefined
  const requestEntries = () => entries.filter((entry) => through === undefined || entry.seq <= through)
  const openRequest = () => {
    requestViewer ??= createJevRequestViewer()
    requestViewer.open(requestEntries(), activeRequestSeq)
  }
  const requestButton = button('查看 Jev 实际请求体', openRequest, '请求体')
  requestButton.disabled = true
  toolbar.append(
    el('strong', 'Jev'),
    previous,
    select,
    next,
    follow,
    actionSelect,
    requestButton,
    candidatesButton,
    historyButton,
  )
  const workspace = el('div')
  workspace.className = 'jev-graph-workspace'
  const scene = el('div')
  scene.className = 'jev-graph-viewport'
  scene.tabIndex = 0
  scene.setAttribute('aria-label', '决策电路，可横向滚动')
  const pools = el('div')
  pools.className = 'jev-candidate-pools'
  pools.hidden = true
  const history = el('div')
  history.className = 'jev-graph-history'
  history.hidden = true
  const detail = el('aside')
  detail.className = 'jev-graph-detail'
  detail.hidden = true
  detail.setAttribute('aria-label', 'Jev 检查器')
  const detailHeader = el('header')
  const detailTitle = el('strong', '节点证据')
  const close = button('关闭检查器', closeInspector, '×')
  detailHeader.append(detailTitle, close)
  const evidence = el('div')
  evidence.className = 'jev-node-evidence'
  evidence.hidden = true
  const facts = el('dl')
  const raw = el('details')
  const detailText = el('pre')
  raw.append(el('summary', '原始证据'), detailText)
  evidence.append(facts, raw)
  detail.append(detailHeader, pools, history, evidence)
  workspace.append(scene, detail)
  const footer = el('div')
  footer.className = 'jev-graph-footer'
  const cursor = el('input')
  cursor.type = 'range'
  cursor.min = '0'
  cursor.setAttribute('aria-label', 'Jev 账本回放位置')
  const position = el('output')
  position.setAttribute('role', 'status')
  const play = button('播放回放', () => {
    if (playing) pause()
    else startReplay(false)
    draw()
  })
  const restart = button('从头回放', () => {
    startReplay(true)
    draw()
  })
  const speed = el('select')
  speed.setAttribute('aria-label', '回放速度')
  for (const value of [1, 2, 4, 8]) {
    const option = el('option', `${value} 事件/秒`)
    option.value = String(value)
    speed.append(option)
  }
  speed.value = '2'
  const previousEvent = button('上一个事件', () => seek(-1), '‹')
  const nextEvent = button('下一个事件', () => seek(1), '›')
  // 单轮 keeps the historical per-turn replay; 全轮 scrubs every persisted event by ledger seq.
  const scopeSelect = el('select')
  scopeSelect.setAttribute('aria-label', 'Jev 回放范围')
  for (const [value, label] of [
    ['turn', '单轮'],
    ['all', '全轮'],
  ] as const) {
    const option = el('option', label)
    option.value = value
    scopeSelect.append(option)
  }
  scopeSelect.value = 'turn'
  const replay = el('div')
  replay.className = 'jev-graph-replay'
  replay.hidden = options.sharedReplay === true
  replay.append(scopeSelect, play, restart, speed, position, previousEvent, cursor, nextEvent)
  const note = el('p')
  note.className = 'jev-graph-evidence'
  const zoomLabel = el('output')
  zoomLabel.setAttribute('aria-label', '画布缩放比例')
  const zoomOut = button('缩小画布', () => setZoom(zoom - 0.15), '−')
  const zoomIn = button('放大画布', () => setZoom(zoom + 0.15), '+')
  const fit = button(
    '适应画布',
    () => {
      autoFit = true
      applyZoom()
    },
    '适应',
  )
  footer.append(zoomOut, zoomLabel, zoomIn, fit)
  root.append(toolbar, workspace, replay, footer, note)
  host.append(root)
  let entries: TraceEntry[] = []
  let selected = ''
  let selectedAction = ''
  let actionStep = ''
  let through: number | undefined
  let replayTurn = ''
  let allTurns = false
  let playing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let scope = ''
  let canvasWidth = 600
  let canvasHeight = 680
  let zoom = 1
  let autoFit = true
  let returnFocus: HTMLElement | undefined
  const expanded = new Set<string>()
  const canvasExpanded = new Set<string>()
  let previousPrefix: number | undefined
  let observedEdges = new Set<string>()
  const edgePulses = new Map<string, number>()
  /** Cut notifications fire only on real changes; the host conversation re-renders per change. */
  let emittedCut = ''
  function emitCut() {
    if (!options.onCut) return
    const cut = allTurns && through !== undefined && scope ? { sessionId: scope, through } : undefined
    const key = cut ? `${cut.sessionId}:${cut.through}` : ''
    if (key === emittedCut) return
    emittedCut = key
    options.onCut(cut)
  }
  function pause() {
    playing = false
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  function sequence() {
    if (allTurns) return entries
    const turn = replayTurn || [...new Set(entries.map((entry) => entry.record.turn))].at(-1)
    return entries.filter((entry) => entry.record.turn === turn)
  }
  function replayIndex(values = sequence()) {
    const bound = through
    return bound === undefined ? values.length - 1 : values.findLastIndex((entry) => entry.seq <= bound)
  }
  function startReplay(fromStart: boolean) {
    const values = sequence()
    if (values.length < 2) return
    replayTurn = values[0]!.record.turn
    selected = ''
    const index = replayIndex(values)
    if (fromStart || index >= values.length - 1) through = values[0]!.seq
    playing = true
    closeInspector()
  }
  function seek(offset: number) {
    const values = sequence()
    const target = values[Math.min(values.length - 1, Math.max(0, replayIndex(values) + offset))]
    if (!target) return
    pause()
    replayTurn = target.record.turn
    through = target.seq
    selected = ''
    closeInspector()
    draw()
  }
  function scheduleReplay() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!playing) return
    if (replayIndex() >= sequence().length - 1) {
      pause()
      return
    }
    timer = setTimeout(() => {
      const values = sequence()
      const nextIndex = replayIndex(values) + 1
      const target = values[nextIndex]
      if (target && allTurns && nextIndex === values.length - 1) {
        // The final event is the live ledger head; release the conversation cut at completion.
        through = undefined
        pause()
      } else if (target) through = target.seq
      else pause()
      draw()
    }, 1000 / Number(speed.value))
  }
  speed.addEventListener('change', scheduleReplay)
  scopeSelect.addEventListener('change', () => {
    pause()
    const next = scopeSelect.value === 'all'
    if (next === allTurns) {
      draw()
      return
    }
    if (!next && through !== undefined) {
      // Keep the inspected position: single-turn replay continues from the turn at the cut.
      const bound = through
      const at = entries.findLast((entry) => entry.seq <= bound)
      if (at) replayTurn = at.record.turn
    }
    allTurns = next
    closeInspector()
    draw()
  })
  function applyZoom() {
    const diagram = scene.querySelector<HTMLElement>('.jev-circuit')
    const space = scene.querySelector<HTMLElement>('.jev-canvas-space')
    if (!diagram || !space) return
    if (autoFit)
      zoom = Math.min(1, Math.max(0.35, ((scene.clientWidth || canvasWidth + 32) - 32) / canvasWidth))
    diagram.style.transform = `scale(${zoom})`
    space.style.width = `${canvasWidth * zoom}px`
    space.style.height = `${canvasHeight * zoom}px`
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`
    zoomOut.disabled = zoom <= 0.35
    zoomIn.disabled = zoom >= 2
  }
  function setZoom(value: number) {
    autoFit = false
    zoom = Math.min(2, Math.max(0.35, value))
    applyZoom()
  }
  const observer =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => {
          if (Math.abs(Math.max(420, (scene.clientWidth || 632) - 32) - canvasWidth) > 2) draw()
          else applyZoom()
        })
  function closeInspector() {
    detail.hidden = true
    candidatesButton.setAttribute('aria-expanded', 'false')
    historyButton.setAttribute('aria-expanded', 'false')
    if (returnFocus?.isConnected) returnFocus.focus()
    applyZoom()
  }
  function showPanel(kind: 'candidates' | 'history' | 'evidence') {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    pools.hidden = kind !== 'candidates'
    history.hidden = kind !== 'history'
    evidence.hidden = kind !== 'evidence'
    detailTitle.textContent =
      kind === 'candidates' ? '候选与采用关系' : kind === 'history' ? '调用轨迹' : '节点证据'
    candidatesButton.setAttribute('aria-expanded', String(kind === 'candidates'))
    historyButton.setAttribute('aria-expanded', String(kind === 'history'))
    detail.hidden = false
    close.focus()
    applyZoom()
  }
  function showDetail(title: string, value: unknown) {
    showPanel('evidence')
    detailTitle.textContent = title
    raw.open = false
    facts.replaceChildren()
    const labels: Record<string, string> = {
      tool: '工具',
      purpose: '用途',
      status: '状态',
      operation: '操作',
      phase: '目的',
      requestedModel: '请求模型',
      observedModel: '实际模型',
      confidence: '置信度',
      effect: '效果',
      requestedSeq: '请求位置',
      settledSeq: '结算位置',
      seq: '账本位置',
    }
    for (const [key, label] of Object.entries(labels)) {
      const field = object(value)?.[key]
      if (typeof field === 'string' || typeof field === 'number')
        facts.append(el('dt', label), el('dd', String(field)))
    }
    if (!facts.childElementCount) facts.append(el('dt', '记录'), el('dd', '已观测；展开下方查看完整证据'))
    const serialized = text(value)
    detailText.textContent =
      serialized.length > 24000 ? `${serialized.slice(0, 24000)}\n（显示截断）` : serialized
  }
  function navigate(offset: number) {
    const index = select.selectedIndex + offset
    if (index < 0 || index >= select.options.length) return
    select.selectedIndex = index
    select.dispatchEvent(new Event('change'))
  }
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !detail.hidden) {
      event.preventDefault()
      event.stopPropagation()
      closeInspector()
    }
    if (event.target === scene && (event.key === '+' || event.key === '-')) {
      event.preventDefault()
      setZoom(zoom + (event.key === '+' ? 0.15 : -0.15))
    }
    if (event.target === scene && event.key === '0') {
      event.preventDefault()
      autoFit = true
      applyZoom()
    }
  })
  function draw() {
    emitCut()
    const scrollTop = scene.scrollTop
    const scrollLeft = scene.scrollLeft
    scene.replaceChildren()
    pools.replaceChildren()
    history.replaceChildren()
    try {
      const full = projectTrace(entries)
      const visible = projectTrace(entries, through)
      const choices = full.turns.flatMap((turn) =>
        turn.steps.map((step) => ({ turn, step, key: JSON.stringify([turn.id, step.id ?? step.number]) })),
      )
      select.replaceChildren(
        ...choices.map(({ turn, step, key }) => {
          const option = el('option', `第 ${turn.number} 轮 · 步骤 ${step.number}`)
          option.value = key
          return option
        }),
      )
      const latest = visible.turns
        .filter((turn) => allTurns || !replayTurn || turn.id === replayTurn)
        .flatMap((turn) =>
          turn.steps.map((step) => ({ turn, step, key: JSON.stringify([turn.id, step.id ?? step.number]) })),
        )
      const active = latest.find((value) => value.key === selected) ?? latest.at(-1)
      const turn =
        active?.turn ?? visible.turns.findLast((turn) => allTurns || !replayTurn || turn.id === replayTurn)
      const step = active?.step
      if (active) select.value = active.key
      select.disabled = options.sharedReplay === true || choices.length === 0
      previous.disabled = options.sharedReplay === true || select.selectedIndex <= 0
      next.disabled =
        options.sharedReplay === true ||
        select.selectedIndex < 0 ||
        select.selectedIndex >= choices.length - 1
      follow.disabled = options.sharedReplay === true
      follow.setAttribute('aria-pressed', String(through === undefined && selected === ''))
      const values = sequence()
      const index = replayIndex(values)
      cursor.max = String(Math.max(0, values.length - 1))
      cursor.value = String(Math.max(0, index))
      cursor.disabled = values.length === 0
      previousEvent.disabled = index <= 0
      nextEvent.disabled = index >= values.length - 1
      play.disabled = restart.disabled = values.length < 2
      scheduleReplay()
      play.textContent = playing ? '暂停' : '播放'
      play.setAttribute('aria-label', playing ? '暂停回放' : '播放回放')
      play.setAttribute('aria-pressed', String(playing))
      position.textContent = allTurns
        ? `${playing ? '全轮播放中' : through === undefined ? '全轮实时' : '全轮回放'} · #${through ?? full.throughSeq ?? 0}`
        : `${playing ? '播放中' : through === undefined ? '实时' : '回放'} · #${through ?? full.throughSeq ?? 0}`
      const request = step?.requests.findLast((value) => value.purpose === 'decision')
      activeRequestSeq = request?.requestedSeq
      const savedRequests = requestEntries()
      requestButton.disabled = !savedRequests.some(
        (entry) => entry.record.kind === 'model.requested' && entry.record.call.purpose === 'decision',
      )
      requestViewer?.update(savedRequests)
      const original = step?.decisions.findLast((value) => value.requested === request?.id)
      const actions = step?.actions ?? []
      if (actionStep !== active?.key) {
        actionStep = active?.key ?? ''
        selectedAction = ''
      }
      if (selectedAction && !actions.some((value) => value.intentId === selectedAction)) selectedAction = ''
      const action = actions.find((value) => value.intentId === selectedAction) ?? actions.at(-1)
      actionSelect.replaceChildren(
        ...actions.map((value, index) => {
          const state =
            value.status === 'settled' && value.outcome
              ? { success: '成功', error: '失败', cancelled: '已取消' }[value.outcome.outcome.kind]
              : {
                  intended: '已准备',
                  dispatching: '执行中',
                  settled: '已结算',
                  unknown: '效果未知',
                  resolved: '已处理',
                }[value.status]
          const option = el('option', `动作 ${index + 1}/${actions.length} · ${value.tool} · ${state}`)
          option.value = value.intentId
          return option
        }),
      )
      actionSelect.hidden = actions.length < 2
      actionSelect.disabled = actions.length < 2
      actionSelect.value = action?.intentId ?? ''
      const final = step?.decisions.find((value) => value.id === action?.decisionId) ?? step?.finalDecision
      const adopted = final ?? original
      const helper = step?.requests.findLast(
        (value) => value.purpose === 'parameters' || value.purpose === 'arbitration',
      )
      const answer = step?.requests.findLast((value) => value.purpose === 'answer')
      const responsePath =
        !action && final?.operation === 'RESPOND' && (!!answer || final.purpose === 'arbitration')
      const observed = entries.filter(
        (value) =>
          value.seq <= (through ?? full.throughSeq ?? 0) &&
          value.record.turn === turn?.id &&
          (step?.id === undefined || value.record.step === step.id),
      )
      const route = observed.findLast(
        (value) =>
          value.record.kind === 'resource.observed' &&
          object(value.record.resource)?.kind === 'jev.decision.route.v1' &&
          object(value.record.resource)?.decisionRecordId === original?.id,
      )
      const routeData = route?.record.kind === 'resource.observed' ? object(route.record.resource) : undefined
      const reasons = Array.isArray(routeData?.reasons) ? routeData.reasons.map(text) : undefined
      const environment = observed.findLast((value) => value.record.kind === 'environment.observed')
      const stop = turn?.stops.at(-1)
      const diagram = el('div')
      diagram.className = 'jev-circuit'
      const prefix = through ?? full.throughSeq ?? 0
      const advancing = previousPrefix !== undefined && prefix > previousPrefix
      if (previousPrefix !== undefined && prefix < previousPrefix) edgePulses.clear()
      previousPrefix = entries.length ? prefix : undefined
      for (const [key, started] of edgePulses) if (Date.now() - started >= 900) edgePulses.delete(key)
      const nextEdges = new Set<string>()
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      // DSH's circuit separates decision, candidate and execution lanes. This layout keeps
      // those lanes at readable native text size, reflowing to a taller canvas in narrow panes.
      canvasWidth = Math.max(420, (scene.clientWidth || 632) - 32)
      const usable = canvasWidth - 64
      const leftWidth = Math.floor(usable * 0.28)
      const candidateWidth = Math.floor(usable * 0.39)
      const rightWidth = usable - leftWidth - candidateWidth
      const candidateLeft = 32 + leftWidth
      const right = candidateLeft + candidateWidth + 16
      type Rect = { x: number; y: number; width: number; height: number }
      const rect = (x: number, y: number, width: number, height = 82): Rect => ({ x, y, width, height })
      // Reserve wrapped model/request lines at the native font size instead of clipping an 82px box.
      const requestHeight = (value: string, width = leftWidth) =>
        Math.max(
          82,
          40 +
            value
              .split('\n')
              .reduce(
                (lines, line) =>
                  lines +
                  Math.max(
                    1,
                    Math.ceil(
                      [...line].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 15 : 7.5), 0) /
                        Math.max(60, width - 20),
                    ),
                  ),
                0,
              ) *
              18,
        )
      const decisionHeight = requestHeight(requestText(request))
      const helperHeight = requestHeight(requestText(helper))
      const answerHeight = requestHeight(requestText(answer))
      const gateBody = adopted
        ? `${adopted.phase} → ${adopted.operation}\n${final && original && final.id !== original.id ? `原始 Jev：${original.operation} → 仲裁：${final.operation}` : reasons ? (reasons.length ? reasons.join(' / ') : '已记录门控通过') : '未观测门控记录'}`
        : '等待采用选择'
      const gateHeight = requestHeight(gateBody, rightWidth)
      const actionY = Math.max(332, 208 + Math.max(decisionHeight, gateHeight) + 30)
      const hostY = Math.max(444, actionY + Math.max(82, helperHeight) + 30)
      const resultY = hostY + 112
      const positions: Record<string, Rect> = {
        ledger: rect(16, 16, canvasWidth - 32, 52),
        context: rect(16, 106, leftWidth, 68),
        decision: rect(16, 208, leftWidth, decisionHeight),
        candidates: rect(candidateLeft, 80, candidateWidth, 26),
        gate: rect(right, 208, rightWidth, gateHeight),
        intent: rect(right, actionY, rightWidth),
        host: rect(right, hostY, rightWidth, 72),
        result: rect(right, resultY, rightWidth),
        helper: rect(16, actionY, leftWidth, helperHeight),
        answer: rect(16, resultY, leftWidth, answerHeight),
      }
      const compactPools = el('div')
      compactPools.className = 'jev-circuit-pools'
      compactPools.style.left = `${candidateLeft}px`
      compactPools.style.top = '116px'
      compactPools.style.width = `${candidateWidth}px`
      let poolHeight = 0
      const ports: number[] = []
      for (const [role, title] of [
        ['phase', '目的 · Purpose'],
        ['action', '条件操作 · Operation'],
        ['binding', '参数绑定 · Binding'],
      ] as const) {
        const heads = request?.heads.filter((head) => head.role === role) ?? []
        const group = el('section')
        group.className = 'jev-compact-pool'
        group.dataset.role = role
        group.append(el('h4', title))
        ports.push(116 + poolHeight + 16)
        poolHeight += 40
        if (!heads.length) {
          group.append(el('small', '等待记录'))
          poolHeight += 24
        }
        const dormant = heads.filter((head) => head.status === 'unconsumed' || head.status === 'pending')
        const groupKey = `${active?.key}:${role}:dormant`
        const showDormant = canvasExpanded.has(groupKey)
        for (const head of heads.filter((head) => showDormant || !dormant.includes(head))) {
          const headBlock = el('div')
          headBlock.className = 'jev-compact-head'
          headBlock.dataset.compactHead = head.key
          headBlock.dataset.status = head.status
          const headTitle = button(
            `${head.key} · ${status[head.status]}`,
            () => showPanel('candidates'),
            head.key,
          )
          headTitle.className = 'jev-compact-head-title'
          headTitle.replaceChildren(el('span', head.key), el('small', status[head.status]))
          headBlock.append(headTitle)
          poolHeight += 31
          const expansionKey = `${active?.key}:${head.key}`
          const isExpanded = canvasExpanded.has(expansionKey)
          const defaultVisible = head.status !== 'pending' && head.status !== 'unconsumed' ? 2 : 0
          if (isExpanded || defaultVisible > 0) {
            const adopted = head.options.filter(
              (option) => option.selected || (head.status === 'supporting' && option.key === head.selected),
            )
            const visibleOptions = [
              ...adopted,
              ...head.options.filter((option) => !adopted.includes(option)),
            ].slice(0, isExpanded ? head.options.length : defaultVisible)
            for (const option of visibleOptions) {
              const optionNode = button(
                `${option.key} · ${option.probability === undefined ? '概率未知' : `${(option.probability * 100).toFixed(1)}%`}`,
                () => showDetail(option.key, { ...option, status: head.status }),
                '',
              )
              optionNode.className = 'jev-compact-option'
              optionNode.dataset.selected = String(option.selected)
              optionNode.dataset.supporting = String(
                head.status === 'supporting' && option.key === head.selected,
              )
              const line = el('span')
              line.append(
                el('strong', option.key),
                el(
                  'small',
                  option.probability === undefined ? '—' : `${(option.probability * 100).toFixed(1)}%`,
                ),
              )
              optionNode.append(line)
              if (option.probability !== undefined) {
                const meter = el('meter')
                meter.min = 0
                meter.max = 1
                meter.value = option.probability
                meter.setAttribute('aria-label', `${option.key} 概率`)
                optionNode.append(meter)
              }
              headBlock.append(optionNode)
              poolHeight += 40
            }
          }
          if (head.options.length > defaultVisible) {
            const toggle = button(
              `${isExpanded ? '收起' : '展开'} ${head.key} 候选`,
              () => {
                if (isExpanded) canvasExpanded.delete(expansionKey)
                else canvasExpanded.add(expansionKey)
                draw()
                Array.from(scene.querySelectorAll<HTMLButtonElement>('[data-candidate-toggle]'))
                  .find((element) => element.dataset.candidateToggle === head.key)
                  ?.focus()
              },
              isExpanded ? '收起' : `+${head.options.length - defaultVisible} 候选`,
            )
            toggle.dataset.candidateToggle = head.key
            toggle.className = 'jev-candidate-toggle'
            toggle.setAttribute('aria-expanded', String(isExpanded))
            headBlock.append(toggle)
            poolHeight += 28
          }
          group.append(headBlock)
        }
        if (dormant.length) {
          const toggle = button(
            `${showDormant ? '收起' : '展开'} ${title} 未采用组`,
            () => {
              if (showDormant) canvasExpanded.delete(groupKey)
              else canvasExpanded.add(groupKey)
              draw()
              scene.querySelector<HTMLButtonElement>(`[data-group-toggle="${role}"]`)?.focus()
            },
            showDormant
              ? '− 收起其余组'
              : `+ ${dormant.length} 组${request?.settledSeq === undefined ? '待结算' : '未采用'}候选`,
          )
          toggle.className = 'jev-candidate-toggle jev-group-toggle'
          toggle.dataset.groupToggle = role
          toggle.setAttribute('aria-expanded', String(showDormant))
          group.append(toggle)
          poolHeight += 30
        }
        compactPools.append(group)
        poolHeight += 12
      }
      const canvasSpace = el('div')
      canvasSpace.className = 'jev-canvas-space'
      diagram.style.width = `${canvasWidth}px`
      diagram.append(compactPools)
      canvasSpace.append(diagram)
      scene.append(canvasSpace)
      // Use rendered pool geometry so wrapping, fonts and disclosure never detach the ports.
      if (compactPools.offsetHeight > 0) {
        poolHeight = compactPools.offsetHeight
        Array.from(compactPools.children).forEach((group, index) => {
          ports[index] = 116 + (group as HTMLElement).offsetTop + 16
        })
      }
      canvasHeight = Math.max(680, 116 + poolHeight + 40, resultY + Math.max(82, answerHeight) + 40)
      diagram.style.width = `${canvasWidth}px`
      diagram.style.height = `${canvasHeight}px`
      svg.setAttribute('viewBox', `0 0 ${canvasWidth} ${canvasHeight}`)
      svg.setAttribute('aria-label', '账本、决策、门控、工具与语言模型分支')
      svg.setAttribute('role', 'img')
      const edge = (name: string, d: string, active: boolean) => {
        const path = document.createElementNS(svg.namespaceURI, 'path')
        path.setAttribute('d', d)
        path.setAttribute('class', active ? 'jev-edge observed' : 'jev-edge')
        path.setAttribute('data-edge', name)
        path.setAttribute('data-observed', String(active))
        svg.append(path)
        const key = `${scope}:${select.value}:${name}`
        if (active) {
          nextEdges.add(key)
          if (advancing && !observedEdges.has(key)) edgePulses.set(key, Date.now())
          const started = edgePulses.get(key)
          if (started !== undefined && Date.now() - started < 900) {
            const pulse = path.cloneNode() as SVGElement
            pulse.removeAttribute('data-edge')
            pulse.removeAttribute('data-observed')
            pulse.setAttribute('d', d.split(' m')[0]!)
            pulse.setAttribute('class', 'jev-edge-pulse')
            pulse.setAttribute('pathLength', '100')
            pulse.setAttribute('aria-hidden', 'true')
            pulse.style.animationDelay = `-${Date.now() - started}ms`
            svg.append(pulse)
          } else edgePulses.delete(key)
        }
      }
      const center = (id: string) => positions[id]!.x + positions[id]!.width / 2
      const rightEdge = right + rightWidth
      const candidateRail = candidateLeft + candidateWidth + 7
      const requestPort = positions.decision!.y + decisionHeight / 2
      const gatePort = positions.gate!.y + gateHeight / 2
      edge('ledger-context', `M${center('context')} 68 V104 m-4 -6 l4 6 4 -6`, !!environment)
      edge('context-request', `M${center('context')} 174 V206 m-4 -6 l4 6 4 -6`, !!request)
      edge('request-candidates', `M${16 + leftWidth} ${requestPort} H${candidateLeft - 7}`, !!request)
      edge('candidates-gate', `M${candidateRail} ${gatePort} H${right - 2} m-6 -4 l6 4 -6 4`, !!original)
      edge(
        'gate-intent',
        `M${center('gate')} ${208 + gateHeight} V${actionY - 2} m-4 -6 l4 6 4 -6`,
        !!action && !helper,
      )
      edge(
        'intent-dispatch',
        `M${center('intent')} ${actionY + 82} V${hostY - 2} m-4 -6 l4 6 4 -6`,
        action?.dispatchingSeq !== undefined,
      )
      edge(
        'dispatch-settlement',
        `M${center('host')} ${hostY + 72} V${resultY - 2} m-4 -6 l4 6 4 -6`,
        action?.settledSeq !== undefined,
      )
      edge(
        'result-ledger',
        `M${rightEdge} ${resultY + 41} H${canvasWidth - 5} V42 H${canvasWidth - 16} m6 -4 l-6 4 6 4`,
        action?.settledSeq !== undefined,
      )
      edge(
        'gate-helper',
        `M${right} ${208 + gateHeight - 10} H${candidateRail} V${canvasHeight - 20} H8 V${actionY + helperHeight / 2} H14 m-6 -4 l6 4 -6 4`,
        !!helper,
      )
      edge(
        'helper-intent',
        `M${16 + leftWidth} ${actionY + helperHeight / 2} H${candidateLeft - 7} V92 H${center('intent')} V${actionY - 2} m-4 -6 l4 6 4 -6`,
        !!helper && !!action,
      )
      edge(
        'gate-answer',
        `M${right} ${208 + gateHeight - 4} H${candidateRail} V${canvasHeight - 12} H${center('answer')} V${resultY + answerHeight + 2} m-4 6 l4 -6 4 6`,
        !!answer,
      )
      edge(
        'answer-ledger',
        `M16 ${resultY + answerHeight / 2} H4 V42 H14 m-6 -4 l6 4 -6 4`,
        answer?.settledSeq !== undefined,
      )
      for (const [index, y] of ports.entries()) {
        const headRole = ['phase', 'action', 'binding'][index]
        const consumed =
          request?.heads.some(
            (head) => head.role === headRole && ['consumed', 'deterministic'].includes(head.status),
          ) ?? false
        edge(
          `candidate-input-${index}`,
          `M${candidateLeft - 7} ${requestPort} V${y} H${candidateLeft}`,
          !!request,
        )
        edge(
          `candidate-output-${index}`,
          `M${candidateLeft + candidateWidth} ${y} H${candidateRail} V${gatePort}`,
          consumed,
        )
      }
      diagram.append(svg, compactPools)
      observedEdges = nextEdges
      function node(id: string, title: string, body: string, _x: number, _y: number, evidence?: unknown) {
        const button = el('button')
        button.type = 'button'
        button.className = 'jev-stage'
        button.dataset.stage = id
        const pos = positions[id]!
        button.style.left = `${pos.x}px`
        button.style.top = `${pos.y}px`
        button.style.width = `${pos.width}px`
        button.style.height = `${pos.height}px`
        button.append(el('strong', title), el('span', body))
        button.disabled = evidence === undefined
        if (evidence !== undefined) {
          button.dataset.observed = 'true'
          button.addEventListener('click', () =>
            id === 'decision'
              ? openRequest()
              : id === 'candidates'
                ? showPanel('candidates')
                : showDetail(title, evidence),
          )
        }
        diagram.append(button)
      }
      node(
        'ledger',
        '① 账本',
        turn ? `第 ${turn.number} 轮\n#${turn.firstSeq}–${turn.lastSeq}` : '等待记录',
        20,
        30,
        turn,
      )
      node(
        'context',
        '② 决策上下文',
        environment ? `环境观察 #${environment.seq}` : '未观测环境记录',
        200,
        30,
        environment?.record,
      )
      node('decision', '③ Jev 请求', requestText(request), 380, 30, request)
      node('candidates', '④ 候选池', `${request?.heads.length ?? 0} 题`, 560, 30, request?.heads)
      node(
        'gate',
        '⑤ 采用与门控',
        gateBody,
        560,
        180,
        adopted ? { original, adopted, route: routeData } : undefined,
      )
      node(
        'intent',
        '⑥ 冻结动作意图',
        action
          ? `${action.tool}\n${actions.length > 1 ? `动作 ${actions.indexOf(action) + 1}/${actions.length} · ` : ''}意图 #${action.intendedSeq}`
          : responsePath
            ? '采用回答路径'
            : '尚无动作意图',
        380,
        180,
        action,
      )
      node(
        'host',
        '⑦ 宿主派发',
        action?.dispatchingSeq
          ? `派发尝试 #${action.dispatchingSeq}`
          : responsePath
            ? '本步骤未派发工具'
            : '等待派发记录',
        200,
        180,
        action?.dispatchingSeq ? action : undefined,
      )
      node(
        'result',
        '⑧ 工具结算 → 账本',
        action?.outcome
          ? `outcome: ${action.outcome.outcome.kind}\neffect: ${action.outcome.effect}\n${action.resolution ? `resolution: ${action.resolution.resolution}` : action.status}`
          : responsePath
            ? '不适用 · 回答路径'
            : '未观测结算；效果未知',
        20,
        180,
        action?.outcome ? action : undefined,
      )
      node('helper', 'LLM 补参 / 仲裁', requestText(helper), 380, 330, helper)
      node('answer', 'LLM 回答 → 账本', requestText(answer), 560, 330, answer)
      applyZoom()
      pools.append(el('p', '并行问题 · 实线采用，虚线支持'))
      for (const [role, title] of [
        ['phase', 'Purpose 目的'],
        ['action', 'Conditional operation 条件操作'],
        ['binding', 'Binding 参数绑定'],
        ['other', '其他问题'],
      ] as const) {
        const heads = request?.heads.filter((head) => head.role === role) ?? []
        if (!heads.length) continue
        const group = el('section')
        group.className = 'jev-head-group'
        group.append(el('h4', title))
        for (const head of heads) {
          const key = `${active?.key}:${request?.id}:${head.key}`
          const card = el('details')
          card.dataset.head = head.key
          card.dataset.status = head.status
          card.open = expanded.has(key)
          const chosen = head.options.filter(
            (option) => option.selected || (head.status === 'supporting' && option.key === head.selected),
          )
          card.append(
            el(
              'summary',
              `${head.key} · ${status[head.status]}${head.selected ? ` · ${head.selected}` : ''}`,
            ),
          )
          const summaryOptions = el(
            'p',
            chosen
              .map(
                (option) =>
                  `${option.key} ${option.probability === undefined ? '—' : `${(option.probability * 100).toFixed(1)}%`}`,
              )
              .join(' · '),
          )
          // Adopted evidence stays visible even when the rest of the candidate reservoir is collapsed.
          group.append(summaryOptions)
          const list = el('ul')
          for (const option of head.options) {
            const item = el('li')
            item.dataset.selected = String(option.selected)
            item.append(
              el('strong', option.key),
              el(
                'span',
                ` · ${option.selected ? '采用' : head.status === 'supporting' && option.key === head.selected ? '支持' : '候选'} · ${option.probability === undefined ? '概率 —' : `${(option.probability * 100).toFixed(1)}%`}`,
              ),
            )
            if (option.probability !== undefined) {
              const meter = el('meter')
              meter.min = 0
              meter.max = 1
              meter.value = option.probability
              meter.setAttribute('aria-label', `${option.key} 概率`)
              item.append(meter)
            }
            item.append(el('pre', text(option.criterion)))
            list.append(item)
          }
          card.append(list)
          card.addEventListener('toggle', () => {
            if (card.open) expanded.add(key)
            else expanded.delete(key)
          })
          group.append(card)
        }
        pools.append(group)
      }
      history.append(el('h4', '本步骤调用与回答轨迹'))
      for (const request of step?.requests ?? []) {
        const item = el('details')
        item.append(el('summary', requestText(request)))
        const settlement = observed.find(
          (value) => value.record.kind === 'model.settled' && value.record.requested === request.id,
        )
        item.append(el('pre', text(settlement?.record ?? request)))
        history.append(item)
        const output =
          settlement?.record.kind === 'model.settled'
            ? object(settlement.record.settlement.output)
            : undefined
        if (output?.kind === 'answer' || request.purpose === 'answer') {
          const content = Array.isArray(output?.content) ? output.content : []
          const answerText = content
            .map((block) =>
              object(block)?.kind === 'text' ? String(object(block)?.text ?? '') : '[非文本内容]',
            )
            .join('\n')
          if (answerText) history.append(el('p', `已记录模型回答 #${settlement?.seq}：${answerText}`))
        }
      }
      for (const entry of observed) {
        if (entry.record.kind !== 'resource.observed') continue
        const review = object(entry.record.resource)
        if (review?.kind === 'jev.response-review.v1')
          history.append(
            el(
              'p',
              `回答审核 #${entry.seq}：${text(review.stage)}${review.verdict ? ` · ${text(review.verdict)}` : ''}`,
            ),
          )
      }
      if (original)
        history.append(
          el(
            'p',
            `原始 Jev 选择：${original.operation} · #${original.seq}${final && final.id !== original.id ? `；最终动作选择：${final.operation} · #${final.seq}` : ''}`,
          ),
        )
      if (stop)
        history.append(
          el(
            'p',
            `轮次停止 #${stop.seq}：${stop.reason} · ${stop.detail}；停止时未决意图：${stop.unresolved.join(', ') || '无'}`,
          ),
        )
      note.textContent = entries.length ? '实线 · 已观测   虚线 · 待观测' : '等待 Jev 记录'
      scene.scrollTop = scrollTop
      scene.scrollLeft = scrollLeft
    } catch (error) {
      pause()
      closeInspector()
      note.textContent = `流程图证据不完整或无效：${error instanceof Error ? error.message : String(error)}。可查看原始记录。`
      note.setAttribute('role', 'alert')
    }
  }
  select.addEventListener('change', () => {
    pause()
    selected = select.value
    const step = projectTrace(entries)
      .turns.flatMap((turn) =>
        turn.steps.map((step) => ({ turn, step, key: JSON.stringify([turn.id, step.id ?? step.number]) })),
      )
      .find((value) => value.key === selected)
    through = step?.step.lastSeq
    replayTurn = step?.turn.id ?? ''
    closeInspector()
    draw()
  })
  actionSelect.addEventListener('change', () => {
    pause()
    selectedAction = actionSelect.value
    closeInspector()
    draw()
  })
  cursor.addEventListener('input', () => {
    pause()
    const target = sequence()[Number(cursor.value)]
    if (!target) return
    replayTurn = target.record.turn
    through = target.seq
    selected = ''
    closeInspector()
    draw()
  })
  return {
    update(events: readonly EventEnvelope[], sessionId: string) {
      if (options.sharedReplay) {
        pause()
        selected = ''
        replayTurn = ''
        through = undefined
        closeInspector()
      }
      if (scope !== sessionId) {
        requestViewer?.dispose()
        requestViewer = undefined
        pause()
        replayTurn = ''
        allTurns = false
        scopeSelect.value = 'turn'
        scope = sessionId
        autoFit = true
        canvasHeight = 680
        observer?.disconnect()
        if (sessionId) observer?.observe(scene)
        selected = ''
        selectedAction = ''
        actionStep = ''
        through = undefined
        expanded.clear()
        canvasExpanded.clear()
        previousPrefix = undefined
        observedEdges.clear()
        edgePulses.clear()
        closeInspector()
      }
      note.removeAttribute('role')
      try {
        entries = jevTraceEntries(events)
        draw()
      } catch (error) {
        requestViewer?.update([])
        requestButton.disabled = true
        pause()
        closeInspector()
        scene.replaceChildren()
        pools.replaceChildren()
        history.replaceChildren()
        note.setAttribute('role', 'alert')
        note.textContent = `无法投影 Jev 记录：${error instanceof Error ? error.message : String(error)}`
        emitCut()
      }
    },
    dispose() {
      pause()
      allTurns = false
      through = undefined
      emitCut()
      requestViewer?.dispose()
      observer?.disconnect()
      root.remove()
    },
  }
}
