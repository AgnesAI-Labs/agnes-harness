import { assertRuntimeRecord } from '@agnes/jev-runtime'
import { projectTrace, type TraceEntry, type TraceHead, type TraceRequest } from '@agnes/jev-trace'
import type { EventEnvelope } from '@agnes/protocol'
import { renderJevCircuit } from './jev-circuit.js'
import type { Translate } from './jev-locale.js'
import { createJevRequestViewer, decisionModelLabel } from './jev-request-viewer.js'

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

const headStatusLabels = (t: Translate): Record<TraceHead['status'], string> => ({
  pending: t('graph.headStatus.pending'),
  unconsumed: t('graph.headStatus.unconsumed'),
  consumed: t('graph.headStatus.consumed'),
  supporting: t('graph.headStatus.supporting'),
  deterministic: t('graph.headStatus.deterministic'),
  invalid: t('graph.headStatus.invalid'),
})
const requestModel = (request: Pick<TraceRequest, 'backend'> | undefined, t: Translate) =>
  request ? decisionModelLabel(request.backend, t) : t('graph.decisionModel')
const requestText = (request: TraceRequest | undefined, t: Translate) =>
  request
    ? `${requestModel(request, t)} · ${request.observedModel ?? request.requestedModel ?? t('graph.unknownModel')}\n${t('graph.request.seq', { seq: request.requestedSeq })}\n${request.settledSeq ? t('graph.settlement.seq', { seq: request.settledSeq, status: request.status }) : t('graph.settlement.unobserved')}`
    : t('graph.request.unobserved')

/** A fixed conversation cut the graph owns while all-turn replay scrubs the durable ledger. */
export type JevReplayCut = { sessionId: string; through: number }

/** Instance-local, read-only circuit. Every highlighted edge is backed by committed evidence. */
export function createJevDecisionGraph(
  host: HTMLElement,
  options: {
    sharedReplay?: boolean
    liveMotion?: () => boolean
    onCut?: (cut: JevReplayCut | undefined) => void
  } = {},
  t: Translate,
) {
  const headStatus = headStatusLabels(t)
  const root = el('section')
  root.className = 'jev-decision-graph'
  root.setAttribute('aria-label', t('graph.aria.root'))
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
  select.setAttribute('aria-label', t('graph.select.turnStep'))
  const actionSelect = el('select')
  actionSelect.setAttribute('aria-label', t('graph.select.action'))
  actionSelect.hidden = true
  const previous = button(t('graph.step.previous'), () => navigate(-1), '‹')
  const next = button(t('graph.step.next'), () => navigate(1), '›')
  const follow = button(
    t('graph.follow'),
    () => {
      through = undefined
      selected = ''
      followingActive = true
      lastActiveStage = ''
      replayTurn = ''
      allTurns = false
      scopeSelect.value = 'turn'
      pause()
      closeInspector()
      draw()
    },
    t('graph.live'),
  )
  const candidatesButton = button(t('graph.candidates.aria'), () => showPanel('candidates'), t('graph.candidates'))
  const historyButton = button(t('graph.history.aria'), () => showPanel('history'), t('graph.history'))
  let requestViewer: ReturnType<typeof createJevRequestViewer> | undefined
  let activeRequestSeq: number | undefined
  const requestEntries = () => entries.filter((entry) => through === undefined || entry.seq <= through)
  const openRequest = () => {
    requestViewer ??= createJevRequestViewer(t)
    requestViewer.open(requestEntries(), activeRequestSeq)
  }
  const requestButton = button(t('graph.requestBody.aria'), openRequest, t('graph.requestBody'))
  requestButton.disabled = true
  toolbar.append(
    el('strong', t('graph.toolbar.decision')),
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
  scene.setAttribute('aria-label', t('graph.scene.aria'))
  const pools = el('div')
  pools.className = 'jev-candidate-pools'
  pools.hidden = true
  const history = el('div')
  history.className = 'jev-graph-history'
  history.hidden = true
  const detail = el('aside')
  detail.className = 'jev-graph-detail'
  detail.hidden = true
  detail.setAttribute('aria-label', t('graph.inspector.aria'))
  const detailHeader = el('header')
  const detailTitle = el('strong', t('graph.evidence.title'))
  const close = button(t('graph.inspector.close'), closeInspector, '×')
  detailHeader.append(detailTitle, close)
  const evidence = el('div')
  evidence.className = 'jev-node-evidence'
  evidence.hidden = true
  const facts = el('dl')
  const raw = el('details')
  const detailText = el('pre')
  raw.append(el('summary', t('graph.evidence.raw')), detailText)
  evidence.append(facts, raw)
  detail.append(detailHeader, pools, history, evidence)
  workspace.append(scene, detail)
  const footer = el('div')
  footer.className = 'jev-graph-footer'
  const cursor = el('input')
  cursor.type = 'range'
  cursor.min = '0'
  cursor.setAttribute('aria-label', t('graph.replay.cursor.aria'))
  const position = el('output')
  position.setAttribute('role', 'status')
  const play = button(t('graph.replay.play'), () => {
    if (playing) pause()
    else startReplay(false)
    draw()
  })
  const restart = button(t('graph.replay.restart'), () => {
    startReplay(true)
    draw()
  })
  const speed = el('select')
  speed.setAttribute('aria-label', t('graph.replay.speed.aria'))
  for (const value of [1, 2, 4, 8]) {
    const option = el('option', t('graph.replay.speedOption', { value }))
    option.value = String(value)
    speed.append(option)
  }
  speed.value = '2'
  const previousEvent = button(t('graph.replay.previousEvent'), () => seek(-1), '‹')
  const nextEvent = button(t('graph.replay.nextEvent'), () => seek(1), '›')
  // 单轮 keeps the historical per-turn replay; 全轮 scrubs every persisted event by ledger seq.
  const scopeSelect = el('select')
  scopeSelect.setAttribute('aria-label', t('graph.replay.scope.aria'))
  for (const [value, label] of [
    ['turn', t('graph.replay.scope.turn')],
    ['all', t('graph.replay.scope.all')],
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
  zoomLabel.setAttribute('aria-label', t('graph.zoom.label.aria'))
  const zoomOut = button(t('graph.zoom.out'), () => setZoom(zoom - 0.15), '−')
  const zoomIn = button(t('graph.zoom.in'), () => setZoom(zoom + 0.15), '+')
  const fit = button(
    t('graph.zoom.fit'),
    () => {
      autoFit = true
      fitCamera = undefined
      restoreFitAfterExpansion = false
      expansionPreviousZoom = undefined
      applyZoom()
    },
    t('graph.zoom.fitShort'),
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
  let restoreFitAfterExpansion = false
  let expansionPreviousZoom: number | undefined
  let expansionStep = ''
  let lastViewportWidth = 0
  let reserveWidth = -1
  let reservedHeads = 0
  let suppliedHeads = 0
  let fitCamera:
    | {
        width: number
        windowWidth: number
        windowHeight: number
        canvasWidth: number
        canvasHeight: number
        zoom: number
      }
    | undefined
  let followingActive = true
  let lastActiveStage = ''
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
    if (autoFit) {
      const width = Math.max(1, (scene.clientWidth || canvasWidth + 32) - 32)
      const height = Math.max(1, (scene.clientHeight || canvasHeight + 32) - 32)
      const fitted = Math.min(1, Math.max(0.15, Math.min(width / canvasWidth, height / canvasHeight)))
      const view = scene.ownerDocument.defaultView
      const windowWidth = view?.innerWidth ?? 0
      const windowHeight = view?.innerHeight ?? 0
      if (scene.clientWidth && scene.clientHeight) {
        // Content-driven height changes are not camera gestures during playback.
        if (
          !fitCamera ||
          (!options.sharedReplay &&
            through === undefined &&
            !playing &&
            (fitCamera.canvasWidth !== canvasWidth || fitCamera.canvasHeight !== canvasHeight)) ||
          Math.abs(fitCamera.width - scene.clientWidth) > 2 ||
          fitCamera.windowWidth !== windowWidth ||
          fitCamera.windowHeight !== windowHeight
        )
          fitCamera = {
            width: scene.clientWidth,
            windowWidth,
            windowHeight,
            canvasWidth,
            canvasHeight,
            zoom: fitted,
          }
        zoom = fitCamera.zoom
      } else zoom = fitted
    }
    diagram.style.transform = `scale(${zoom})`
    space.style.width = `${canvasWidth * zoom}px`
    space.style.height = `${canvasHeight * zoom}px`
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`
    zoomOut.disabled = zoom <= 0.35
    zoomIn.disabled = zoom >= 2
  }
  function setZoom(value: number) {
    autoFit = false
    restoreFitAfterExpansion = false
    expansionPreviousZoom = undefined
    zoom = Math.min(2, Math.max(0.35, value))
    applyZoom()
  }
  function finishExpansion() {
    if (restoreFitAfterExpansion) autoFit = true
    else if (expansionPreviousZoom !== undefined) zoom = expansionPreviousZoom
    restoreFitAfterExpansion = false
    expansionPreviousZoom = undefined
    expansionStep = ''
  }
  const observer =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => {
          const width = scene.clientWidth
          if (Math.abs(width - lastViewportWidth) > 2) draw()
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
      kind === 'candidates'
        ? t('graph.panel.candidates')
        : kind === 'history'
          ? t('graph.panel.history')
          : t('graph.evidence.title')
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
      tool: t('graph.field.tool'),
      purpose: t('graph.field.purpose'),
      status: t('graph.field.status'),
      operation: t('graph.field.operation'),
      phase: t('graph.field.phase'),
      requestedModel: t('graph.field.requestedModel'),
      observedModel: t('graph.field.observedModel'),
      confidence: t('graph.field.confidence'),
      effect: t('graph.field.effect'),
      requestedSeq: t('graph.field.requestedSeq'),
      settledSeq: t('graph.field.settledSeq'),
      seq: t('graph.field.seq'),
    }
    for (const [key, label] of Object.entries(labels)) {
      const field = object(value)?.[key]
      if (typeof field === 'string' || typeof field === 'number')
        facts.append(el('dt', label), el('dd', String(field)))
    }
    if (!facts.childElementCount)
      facts.append(el('dt', t('graph.field.record')), el('dd', t('graph.field.recordFallback')))
    const serialized = text(value)
    detailText.textContent =
      serialized.length > 24000 ? `${serialized.slice(0, 24000)}\n${t('graph.evidence.truncated')}` : serialized
  }
  function navigate(offset: number) {
    const index = select.selectedIndex + offset
    if (index < 0 || index >= select.options.length) return
    select.selectedIndex = index
    select.dispatchEvent(new Event('change'))
  }
  scene.addEventListener(
    'wheel',
    () => {
      followingActive = false
    },
    { passive: true },
  )
  scene.addEventListener(
    'touchmove',
    () => {
      followingActive = false
    },
    { passive: true },
  )
  scene.addEventListener('pointerdown', (event) => {
    if (event.target === scene) followingActive = false
  })
  scene.addEventListener('keydown', (event) => {
    if (
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(
        event.key,
      )
    )
      followingActive = false
  })
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
      fitCamera = undefined
      applyZoom()
    }
  })
  function draw() {
    emitCut()
    const scrollTop = scene.scrollTop
    const scrollLeft = scene.scrollLeft
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
          const option = el('option', t('graph.option.turnStep', { turn: turn.number, step: step.number }))
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
      if (expansionStep && expansionStep !== active?.key) finishExpansion()
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
      play.textContent = playing ? t('graph.replay.pauseShort') : t('graph.replay.playShort')
      play.setAttribute('aria-label', playing ? t('graph.replay.pause') : t('graph.replay.play'))
      play.setAttribute('aria-pressed', String(playing))
      position.textContent = allTurns
        ? `${playing ? t('graph.replay.allPlaying') : through === undefined ? t('graph.replay.allLive') : t('graph.replay.allReplaying')} · #${through ?? full.throughSeq ?? 0}`
        : `${playing ? t('graph.replay.playing') : through === undefined ? t('graph.live') : t('graph.replay.replaying')} · #${through ?? full.throughSeq ?? 0}`
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
              ? {
                  success: t('graph.action.outcome.success'),
                  error: t('graph.action.outcome.error'),
                  cancelled: t('graph.action.outcome.cancelled'),
                }[value.outcome.outcome.kind]
              : {
                  intended: t('graph.action.state.intended'),
                  dispatching: t('graph.action.state.dispatching'),
                  settled: t('graph.action.state.settled'),
                  unknown: t('graph.action.state.unknown'),
                  resolved: t('graph.action.state.resolved'),
                }[value.status]
          const option = el(
            'option',
            t('graph.action.option', {
              index: index + 1,
              total: actions.length,
              tool: value.tool,
              state,
            }),
          )
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
      const recordedLanguageContexts = observed.filter((value) => {
        if (
          value.record.kind !== 'model.requested' ||
          !['agnes-language-v1', 'agnes-language-v2'].includes(value.record.call.codec) ||
          (value.record.id !== helper?.id && value.record.id !== answer?.id)
        )
          return false
        const native = object(object(value.record.call.input)?.['request'])
        return Array.isArray(native?.['messages']) && Array.isArray(native?.['tools'])
      })
      const languageContext = recordedLanguageContexts.at(-1)

      const stop = turn?.stops.at(-1)
      const prefix = through ?? full.throughSeq ?? 0
      const advancing = previousPrefix !== undefined && prefix > previousPrefix
      if (previousPrefix !== undefined && prefix < previousPrefix) edgePulses.clear()
      previousPrefix = entries.length ? prefix : undefined
      for (const [key, started] of edgePulses) if (Date.now() - started >= 900) edgePulses.delete(key)
      const nextEdges = new Set<string>()
      const gateBody = adopted
        ? `${adopted.phase} → ${adopted.operation}\n${final && original && final.id !== original.id ? t('graph.gate.takeover', { model: requestModel(request, t), original: original.operation, final: final.operation }) : reasons ? (reasons.length ? reasons.join(' / ') : t('graph.gate.passed')) : t('graph.gate.unobserved')}`
        : t('graph.gate.waiting')
      const live =
        options.liveMotion?.() === true &&
        !options.sharedReplay &&
        through === undefined &&
        !playing &&
        !stop &&
        turn?.id === full.turns.at(-1)?.id &&
        active?.key === choices.at(-1)?.key
      const latestRequest = step?.requests.at(-1)
      const decisionActive = live && request?.status === 'pending' && request === latestRequest
      const helperActive = live && helper?.status === 'pending' && helper === latestRequest
      const answerActive = live && answer?.status === 'pending' && answer === latestRequest
      const hostActive = live && action?.status === 'dispatching' && action === actions.at(-1)
      const requestState = (value?: TraceRequest) =>
        value
          ? value.status === 'pending'
            ? t('graph.request.pendingSettlement')
            : value.status === 'failed'
              ? t('graph.request.failed')
              : t('graph.request.settled')
          : t('graph.request.none')
      const helperTitle =
        helper?.purpose === 'arbitration'
          ? t('graph.helper.arbitration')
          : helper?.purpose === 'parameters'
            ? t('graph.helper.parameters')
            : t('graph.helper.either')
      lastViewportWidth = scene.clientWidth
      if (reserveWidth !== lastViewportWidth) {
        reservedHeads = 0
        reserveWidth = lastViewportWidth
      }
      const knownRequests = full.turns.flatMap((value) =>
        value.steps.flatMap((item) => item.requests.filter((entry) => entry.purpose === 'decision')),
      )
      reservedHeads = Math.max(
        reservedHeads,
        suppliedHeads,
        options.sharedReplay ? 8 : 0,
        ...knownRequests.map((entry) => entry.heads.length),
      )
      const knownRequest = knownRequests.find((entry) => entry.id === request?.id)
      const slots =
        request?.heads.map((head, index) => {
          const slot = knownRequest?.heads.findIndex((entry) => entry.key === head.key)
          return slot !== undefined && slot >= 0 ? slot : index
        }) ?? []
      const circuit = renderJevCircuit({
        t,
        viewport: scene,
        availableWidth: lastViewportWidth,
        scope,
        requestKey: request?.id ?? '',
        reservation: { heads: reservedHeads, slots },
        heads: request?.heads ?? [],
        expanded: canvasExpanded,
        prefix: active?.key ?? '',
        stages: [
          {
            id: 'ledger',
            title: t('graph.stage.ledger'),
            body: turn
              ? t('graph.stage.ledger.turn', {
                  turn: turn.number,
                  state: stop ? t('graph.stage.ledger.ended') : t('graph.stage.ledger.observed'),
                })
              : t('graph.stage.ledger.waiting'),
            tone: 'evidence',
            evidence: turn,
            tooltip: turn
              ? t('graph.stage.ledger.tooltip', { first: turn.firstSeq, last: turn.lastSeq })
              : t('graph.stage.ledger.waitingTooltip'),
          },
          {
            id: 'context',
            title: t('graph.stage.context'),
            body: environment ? t('graph.stage.context.observed') : t('graph.stage.context.waiting'),
            tone: 'evidence',
            evidence: environment?.record,
            tooltip: environment
              ? t('graph.stage.context.tooltip', { seq: environment.seq })
              : t('graph.stage.context.waitingTooltip'),
          },
          {
            id: 'language-context',
            title: t('graph.stage.languageContext'),
            body: languageContext
              ? t('graph.stage.languageContext.observed')
              : t('graph.stage.languageContext.waiting'),
            tone: 'llm',
            evidence: languageContext?.record,
            active: (helperActive || answerActive) && languageContext?.record.id === latestRequest?.id,
            tooltip: languageContext
              ? t('graph.stage.languageContext.tooltip', { seq: languageContext.seq })
              : t('graph.stage.languageContext.waitingTooltip'),
          },
          {
            id: 'decision',
            title: requestModel(request, t),
            body: requestState(request),
            tone: 'jev',
            evidence: request,
            active: decisionActive,
            tooltip: requestText(request, t),
          },
          {
            id: 'candidates',
            title: t('graph.stage.candidates'),
            body: t('graph.stage.candidates.body', { count: request?.heads.length ?? 0 }),
            tone: 'jev',
            evidence: request?.heads,
          },
          {
            id: 'gate',
            title: t('graph.stage.gate'),
            body: adopted ? `${adopted.phase} → ${adopted.operation}` : t('graph.gate.waiting'),
            tone: reasons?.length ? 'critical' : 'jev',
            evidence: adopted ? { original, adopted, route: routeData } : undefined,
            tooltip: gateBody,
          },
          {
            id: 'intent',
            title: t('graph.stage.intent'),
            body: action
              ? `${action.tool}${actions.length > 1 ? t('graph.stage.intent.action', { index: actions.indexOf(action) + 1, total: actions.length }) : ''}`
              : responsePath
                ? t('graph.stage.intent.answerPath')
                : t('graph.stage.intent.none'),
            tone: 'tool',
            evidence: action,
            tooltip: action
              ? t('graph.stage.intent.tooltip', { tool: action.tool, seq: action.intendedSeq })
              : t('graph.stage.intent.none'),
          },
          {
            id: 'host',
            title: t('graph.stage.host'),
            body: hostActive
              ? t('graph.stage.host.waitingTool')
              : action?.dispatchingSeq
                ? t('graph.stage.host.dispatched')
                : responsePath
                  ? t('graph.stage.host.noDispatch')
                  : t('graph.stage.host.waitingDispatch'),
            tone: 'tool',
            evidence: action?.dispatchingSeq ? action : undefined,
            active: hostActive,
            tooltip: action?.dispatchingSeq
              ? t('graph.stage.host.tooltip', { seq: action.dispatchingSeq, status: action.status })
              : t('graph.stage.host.waitingTooltip'),
          },
          {
            id: 'result',
            title: t('graph.stage.result'),
            body: action?.outcome
              ? t('graph.stage.result.body', {
                  outcome: action.outcome.outcome.kind,
                  effect: action.outcome.effect,
                })
              : responsePath
                ? t('graph.stage.result.answerPath')
                : t('graph.stage.result.unobserved'),
            tone: action?.status === 'unknown' ? 'critical' : 'evidence',
            evidence: action?.outcome ? action : undefined,
          },
          {
            id: 'helper',
            title: helperTitle,
            body: requestState(helper),
            tone: 'llm',
            evidence: helper,
            active: helperActive,
            tooltip: `${requestText(helper, t)}\n${helper?.purpose === 'arbitration' ? t('graph.helper.tooltip.arbitration') : helper?.purpose === 'parameters' ? t('graph.helper.tooltip.parameters') : t('graph.helper.tooltip.waiting')}`,
          },
          {
            id: 'answer',
            title: t('graph.stage.answer'),
            body: requestState(answer),
            tone: 'llm',
            evidence: answer,
            active: answerActive,
            tooltip: requestText(answer, t),
          },
        ],
        edges: {
          'ledger-context': { observed: !!environment, tone: 'evidence' },
          'ledger-language-context': {
            observed: !!languageContext,
            active: !!languageContext && (helperActive || answerActive),
            tone: 'llm',
          },
          'language-context-helper': {
            observed: recordedLanguageContexts.some((value) => value.record.id === helper?.id),
            active: helperActive && recordedLanguageContexts.some((value) => value.record.id === helper?.id),
            tone: 'llm',
          },
          'language-context-answer': {
            observed: recordedLanguageContexts.some((value) => value.record.id === answer?.id),
            active: answerActive && recordedLanguageContexts.some((value) => value.record.id === answer?.id),
            tone: 'llm',
          },
          'context-request': { observed: !!request, active: decisionActive, tone: 'jev' },
          'request-candidates': { observed: !!request, active: decisionActive, tone: 'jev' },
          'candidates-gate': { observed: !!original, tone: 'jev' },
          'gate-intent': { observed: !!action && !helper, tone: 'tool' },
          'intent-dispatch': {
            observed: action?.dispatchingSeq !== undefined,
            active: hostActive,
            tone: 'tool',
          },
          'dispatch-settlement': {
            observed: action?.settledSeq !== undefined,
            active: hostActive,
            tone: 'tool',
          },
          'result-ledger': { observed: action?.settledSeq !== undefined, tone: 'evidence' },
          'gate-helper': { observed: !!helper, active: helperActive, tone: 'llm' },
          'helper-intent': { observed: !!helper && !!action, tone: 'llm' },
          'gate-answer': { observed: !!answer, active: answerActive, tone: 'llm' },
          'answer-ledger': { observed: answer?.settledSeq !== undefined, tone: 'evidence' },
        },
        edge(svg, name, pathData, observed, moving, tone) {
          const path = document.createElementNS(svg.namespaceURI, 'path')
          path.setAttribute('d', pathData)
          path.setAttribute('class', observed ? 'jev-edge observed' : 'jev-edge')
          path.setAttribute('data-edge', name)
          path.setAttribute('data-observed', String(observed))
          path.setAttribute('data-active', String(moving))
          path.setAttribute('data-tone', tone)
          svg.append(path)
          if (moving) {
            const packet = path.cloneNode() as SVGElement
            packet.removeAttribute('data-edge')
            packet.setAttribute('data-flow-edge', name)
            packet.setAttribute('class', 'jev-flow-packet')
            packet.setAttribute('pathLength', '100')
            packet.setAttribute('aria-hidden', 'true')
            svg.append(packet)
          }
          const key = `${scope}:${select.value}:${name}`
          if (!observed) return
          nextEdges.add(key)
          if (advancing && !observedEdges.has(key)) edgePulses.set(key, Date.now())
          const started = edgePulses.get(key)
          if (started !== undefined && Date.now() - started < 900) {
            const pulse = path.cloneNode() as SVGElement
            pulse.removeAttribute('data-edge')
            pulse.setAttribute('data-pulse-edge', name)
            pulse.removeAttribute('data-observed')
            pulse.removeAttribute('data-active')
            pulse.setAttribute('class', 'jev-edge-pulse')
            pulse.setAttribute('pathLength', '100')
            pulse.setAttribute('aria-hidden', 'true')
            pulse.style.animationDelay = `-${Date.now() - started}ms`
            svg.append(pulse)
          } else edgePulses.delete(key)
        },
        onStage(stage) {
          if (stage.id === 'decision') openRequest()
          else if (stage.id === 'candidates') showPanel('candidates')
          else showDetail(stage.title, stage.evidence)
        },
        onHead() {
          showPanel('candidates')
        },
        onOption(head, option, state) {
          showDetail(option.key, { ...option, question: head.key, headStatus: head.status, status: state })
        },
        onToggle(head) {
          const key = `${active?.key}:${head.key}`
          const prefix = `${active?.key}:`
          const hasVisibleExpansion = () => [...canvasExpanded].some((value) => value.startsWith(prefix))
          if (canvasExpanded.has(key)) {
            canvasExpanded.delete(key)
            if (!hasVisibleExpansion()) finishExpansion()
          } else {
            if (!hasVisibleExpansion()) {
              restoreFitAfterExpansion = autoFit
              expansionPreviousZoom = zoom
              expansionStep = active?.key ?? ''
            }
            canvasExpanded.add(key)
            autoFit = false
            zoom = restoreFitAfterExpansion ? 1 : Math.max(0.65, zoom)
          }
          draw()
          Array.from(scene.querySelectorAll<HTMLButtonElement>('[data-candidate-toggle]'))
            .find((element) => element.dataset.candidateToggle === head.key)
            ?.focus()
        },
      })
      canvasWidth = circuit.width
      canvasHeight = circuit.height
      observedEdges = nextEdges
      applyZoom()
      pools.append(el('p', t('graph.pools.note')))
      for (const [role, title] of [
        ['phase', t('graph.pools.group.phase')],
        ['action', t('graph.pools.group.action')],
        ['binding', t('graph.pools.group.binding')],
        ['other', t('graph.pools.group.other')],
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
              `${head.key} · ${headStatus[head.status]}${head.selected ? ` · ${head.selected}` : ''}`,
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
                ` · ${option.selected ? t('graph.option.adopted') : head.status === 'supporting' && option.key === head.selected ? t('graph.option.supporting') : t('graph.option.candidate')} · ${option.probability === undefined ? t('graph.option.probabilityNone') : `${(option.probability * 100).toFixed(1)}%`}`,
              ),
            )
            if (option.probability !== undefined) {
              const meter = el('meter')
              meter.min = 0
              meter.max = 1
              meter.value = option.probability
              meter.setAttribute('aria-label', t('graph.option.probability.aria', { key: option.key }))
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
      history.append(el('h4', t('graph.history.title')))
      for (const request of step?.requests ?? []) {
        const item = el('details')
        item.append(el('summary', requestText(request, t)))
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
              object(block)?.kind === 'text'
                ? String(object(block)?.text ?? '')
                : t('graph.history.nonText'),
            )
            .join('\n')
          if (answerText)
            history.append(el('p', t('graph.history.answer', { seq: String(settlement?.seq), answer: answerText })))
        }
      }
      for (const entry of observed) {
        if (entry.record.kind !== 'resource.observed') continue
        const review = object(entry.record.resource)
        if (review?.kind === 'jev.response-review.v1')
          history.append(
            el(
              'p',
              t('graph.history.review', {
                seq: entry.seq,
                stage: `${text(review.stage)}${review.verdict ? ` · ${text(review.verdict)}` : ''}`,
              }),
            ),
          )
      }
      if (original)
        history.append(
          el(
            'p',
            `${t('graph.history.original', { operation: original.operation, seq: original.seq })}${final && final.id !== original.id ? t('graph.history.final', { operation: final.operation, seq: final.seq }) : ''}`,
          ),
        )
      if (stop)
        history.append(
          el(
            'p',
            t('graph.history.stop', {
              seq: stop.seq,
              reason: stop.reason,
              detail: stop.detail,
              unresolved: stop.unresolved.join(', ') || t('graph.history.stopNone'),
            }),
          ),
        )
      note.textContent = entries.length
        ? options.sharedReplay
          ? t('graph.note.shared')
          : t('graph.note.local')
        : t('graph.note.waiting')
      note.title = options.sharedReplay ? t('graph.note.sharedTitle') : t('graph.note.localTitle')
      scene.scrollTop = scrollTop
      scene.scrollLeft = scrollLeft
      const activeStage = scene.querySelector<HTMLElement>(
        '.jev-stage[data-active="true"]:not([data-stage="language-context"])',
      )
      const activeKey = activeStage
        ? `${active?.key}:${activeStage.dataset.stage}:${latestRequest?.id}:${action?.intentId}`
        : ''
      if (
        activeStage &&
        activeKey &&
        activeKey !== lastActiveStage &&
        followingActive &&
        !autoFit &&
        scene.clientWidth &&
        scene.clientHeight
      ) {
        const x = (parseFloat(activeStage.style.left) + parseFloat(activeStage.style.width) / 2) * zoom
        const y = (parseFloat(activeStage.style.top) + parseFloat(activeStage.style.height) / 2) * zoom
        const width = scene.clientWidth,
          height = scene.clientHeight
        const marginX = width * 0.18,
          marginY = height * 0.18
        const left =
          x < scrollLeft + marginX || x > scrollLeft + width - marginX
            ? Math.max(0, Math.min(x - width / 2, canvasWidth * zoom - width + 32))
            : scrollLeft
        const top =
          y < scrollTop + marginY || y > scrollTop + height - marginY
            ? Math.max(0, Math.min(y - height / 2, canvasHeight * zoom - height + 32))
            : scrollTop
        if (left !== scrollLeft || top !== scrollTop) scene.scrollTo({ left, top, behavior: 'auto' })
      }
      lastActiveStage = activeKey
    } catch (error) {
      pause()
      closeInspector()
      scene.replaceChildren()
      note.textContent = t('graph.error.incomplete', {
        message: error instanceof Error ? error.message : String(error),
      })
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
    update(events: readonly EventEnvelope[], sessionId: string, reservation?: { heads: number }) {
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
        restoreFitAfterExpansion = false
        expansionPreviousZoom = undefined
        expansionStep = ''
        zoom = 1
        followingActive = true
        lastActiveStage = ''
        canvasHeight = 680
        reserveWidth = -1
        reservedHeads = 0
        suppliedHeads = 0
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
        fitCamera = undefined
      }
      if (reservation && Number.isSafeInteger(reservation.heads) && reservation.heads >= 0)
        suppliedHeads = Math.max(suppliedHeads, reservation.heads)
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
        note.textContent = t('graph.error.project', {
          message: error instanceof Error ? error.message : String(error),
        })
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
