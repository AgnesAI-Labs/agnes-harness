import type { TraceHead, TraceOption } from '@agnes/jev-trace'
import type { Translate } from './jev-locale.js'

export type JevCircuitTone = 'jev' | 'llm' | 'tool' | 'evidence' | 'neutral' | 'critical'
export type JevCircuitStageId =
  | 'ledger'
  | 'context'
  | 'language-context'
  | 'decision'
  | 'candidates'
  | 'gate'
  | 'intent'
  | 'host'
  | 'result'
  | 'helper'
  | 'answer'
export type JevCircuitStage = {
  id: JevCircuitStageId
  title: string
  body: string
  tone: JevCircuitTone
  evidence?: unknown
  tooltip?: string
  active?: boolean
}
type Point = { x: number; y: number }
type Rect = Point & { width: number; height: number }
type Fan = {
  head: TraceHead
  rect: Rect
  options: readonly TraceOption[]
  expanded: boolean
  total: number
}

function childKey(child: Node, index: number): string {
  if (child.nodeType !== 1) return `${child.nodeType}:${index}`
  const element = child as Element
  for (const attribute of [
    'data-stage',
    'data-edge',
    'data-flow-edge',
    'data-pulse-edge',
    'data-circuit-panel',
    'data-circuit-junction',
    'data-option-key',
    'data-candidate-toggle',
    'data-side',
  ]) {
    const value = element.getAttribute(attribute)
    if (value !== null) return `${element.tagName}:${attribute}:${value}`
  }
  const head = element.getAttribute('data-compact-head')
  if (head !== null) return `head:${element.getAttribute('data-request')}:${head}`
  return `${element.nodeType}:${element.tagName}:${index}`
}

/** Preserve keyed element identity while replacing handlers with the current visible evidence. */
function reconcileChildren(target: Node, source: Node) {
  const available = new Map(Array.from(target.childNodes, (child, index) => [childKey(child, index), child]))
  const desired = Array.from(source.childNodes)
  const retained = new Set<Node>()
  for (const [index, fresh] of desired.entries()) {
    const key = childKey(fresh, index)
    const old = available.get(key)
    const current = old && old.nodeType === fresh.nodeType && old.nodeName === fresh.nodeName ? old : fresh
    if (current !== fresh) {
      if (current.nodeType === 1) {
        const element = current as Element,
          next = fresh as Element
        if (element.classList.contains('jev-edge-pulse') && next.classList.contains('jev-edge-pulse'))
          (next as SVGElement).style.animationDelay = (element as SVGElement).style.animationDelay
        for (const attribute of Array.from(element.attributes))
          if (attribute.name !== 'style' && !next.hasAttribute(attribute.name))
            element.removeAttribute(attribute.name)
        for (const attribute of Array.from(next.attributes))
          if (attribute.name !== 'style' && element.getAttribute(attribute.name) !== attribute.value)
            element.setAttribute(attribute.name, attribute.value)
        // CSSOM writes remain valid under the Host's style-src-attr policy; style attributes do not.
        if ('style' in element && 'style' in next) {
          const style = (element as HTMLElement | SVGElement).style
          const incoming = (next as HTMLElement | SVGElement).style
          for (const property of Array.from(style))
            if (!incoming.getPropertyValue(property)) style.removeProperty(property)
          for (const property of Array.from(incoming))
            style.setProperty(
              property,
              incoming.getPropertyValue(property),
              incoming.getPropertyPriority(property),
            )
        }
        if ('onclick' in element) (element as HTMLElement).onclick = (next as HTMLElement).onclick
        reconcileChildren(element, next)
      } else if (current.nodeValue !== fresh.nodeValue) current.nodeValue = fresh.nodeValue
    }
    retained.add(current)
    if (target.childNodes[index] !== current) target.insertBefore(current, target.childNodes[index] ?? null)
  }
  for (const child of Array.from(target.childNodes)) if (!retained.has(child)) target.removeChild(child)
}

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, content?: string) => {
  const element = document.createElement(tag)
  if (content !== undefined) element.textContent = content
  return element
}
const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K) =>
  document.createElementNS('http://www.w3.org/2000/svg', tag)
const center = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
const right = (rect: Rect): Point => ({ x: rect.x + rect.width, y: rect.y + rect.height / 2 })
const left = (rect: Rect): Point => ({ x: rect.x, y: rect.y + rect.height / 2 })
const curve = (from: Point, to: Point) => {
  const mid = (from.x + to.x) / 2
  return `M${from.x} ${from.y} C${mid} ${from.y} ${mid} ${to.y} ${to.x} ${to.y}`
}
const headStatusLabels = (t: Translate): Record<TraceHead['status'], string> => ({
  pending: t('circuit.headStatus.pending'),
  unconsumed: t('circuit.headStatus.unconsumed'),
  consumed: t('circuit.headStatus.consumed'),
  supporting: t('circuit.headStatus.supporting'),
  deterministic: t('circuit.headStatus.deterministic'),
  invalid: t('circuit.headStatus.invalid'),
})
const roleLabels = (t: Translate): Record<TraceHead['role'], string> => ({
  phase: t('circuit.role.phase'),
  action: t('circuit.role.action'),
  binding: t('circuit.role.binding'),
  other: t('circuit.role.other'),
})
function optionLabel(t: Translate, head: TraceHead, option: TraceOption): string {
  if (head.role === 'binding' && option.key === 'LLM_PARAMETERS') return t('circuit.option.llmParameters')
  if (head.role === 'binding' && option.key === 'DEFAULT_ARGUMENTS') return t('circuit.option.defaultArguments')
  if (head.role !== 'binding') return option.key
  const criterion = option.criterion
  if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return option.key
  const args = criterion['arguments']
  const path = args && typeof args === 'object' && !Array.isArray(args) ? args['path'] : criterion['path']
  for (const value of [path, criterion['name'], criterion['description']])
    if (typeof value === 'string' && value.trim() && value.length <= 256) return value
  return option.key
}

const headTitle = (t: Translate, head: TraceHead) =>
  head.role === 'phase' && head.key === 'purpose'
    ? t('circuit.headTitle.purpose')
    : head.role === 'action' && head.key.startsWith('operation_')
      ? t('circuit.headTitle.tool', { name: head.key.slice(10) })
      : head.role === 'binding' && head.key.startsWith('binding_')
        ? t('circuit.headTitle.binding', { name: head.key.slice(8) })
        : head.key

/** One coordinate system owns nodes, ports and wires. Pool growth only extends the scroll area. */
function layout(
  heads: readonly TraceHead[],
  width: number,
  expanded: ReadonlySet<string>,
  prefix: string,
  reservation: { heads: number; slots: readonly number[] },
) {
  const columns = Math.min(4, Math.max(2, Math.floor((width - 950) / 230)))
  const poolLeft = 320
  const poolRight = poolLeft + columns * 230
  const gateX = poolRight + 112
  const mainY = 240
  const rect = (x: number, y: number, width = 176, height = 64): Rect => ({
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
  })
  const positions: Record<JevCircuitStageId, Rect> = {
    ledger: rect((gateX + 530) / 2, 48, 270, 60),
    context: rect(110, mainY),
    'language-context': rect(gateX, 132, 176, 56),
    decision: rect(250, mainY, 96, 96),
    candidates: rect((poolLeft + poolRight) / 2, 118, columns * 230, 36),
    gate: rect(gateX, mainY),
    intent: rect(gateX + 208, mainY),
    host: rect(gateX + 416, mainY),
    helper: rect(gateX, 382),
    answer: rect(gateX, 520),
    result: rect(gateX + 416, 520),
  }
  const fans: Fan[] = heads.map((head, index) => {
    const open = expanded.has(`${prefix}:${head.key}`)
    const selected = head.options.filter((option) => option.selected || head.selected === option.key)
    const visible = new Set(selected)
    const limit = Math.max(2, selected.length)
    for (const option of head.options) if (visible.size < limit) visible.add(option)
    const options = open
      ? head.options
      : head.status === 'unconsumed'
        ? []
        : head.options.filter((option) => visible.has(option))
    const rows = options.length || (head.status === 'unconsumed' && !open ? 0 : 1)
    const height = 62 + rows * 38 + (options.length < head.options.length || open ? 30 : 0)
    const slot = reservation.slots[index] ?? index
    return {
      head,
      options,
      expanded: open,
      total: head.options.length,
      rect: { x: poolLeft + (slot % columns) * 230, y: Math.floor(slot / columns), width: 230, height },
    }
  })
  const rows = Math.ceil(Math.max(reservation.heads, heads.length) / columns)
  const rowHeights = Array.from({ length: rows }, () => 168)
  for (const fan of fans) rowHeights[fan.rect.y] = Math.max(rowHeights[fan.rect.y] ?? 168, fan.rect.height)
  const rowOffsets: number[] = []
  let bottom = 168
  for (const height of rowHeights) {
    rowOffsets.push(bottom)
    bottom += height + 22
  }
  for (const fan of fans) fan.rect.y = rowOffsets[fan.rect.y] ?? 168
  return {
    positions,
    fans,
    poolLeft,
    poolRight,
    width: gateX + 528,
    height: Math.max(600, bottom + 46),
  }
}

export function renderJevCircuit(input: {
  t: Translate
  viewport: HTMLElement
  availableWidth: number
  scope: string
  requestKey: string
  reservation: { heads: number; slots: readonly number[] }
  heads: readonly TraceHead[]
  expanded: ReadonlySet<string>
  prefix: string
  stages: readonly JevCircuitStage[]
  edges: Readonly<Record<string, { observed: boolean; active?: boolean; tone?: JevCircuitTone }>>
  edge(
    svg: SVGSVGElement,
    name: string,
    path: string,
    observed: boolean,
    active: boolean,
    tone: JevCircuitTone,
  ): void
  onStage(stage: JevCircuitStage): void
  onOption(head: TraceHead, option: TraceOption, state: string): void
  onHead(head: TraceHead): void
  onToggle(head: TraceHead): void
}) {
  const t = input.t
  const status = headStatusLabels(t)
  const roles = roleLabels(t)
  const geometry = layout(input.heads, input.availableWidth, input.expanded, input.prefix, input.reservation)
  const { positions: p } = geometry
  const diagram = node('div')
  diagram.className = 'jev-circuit'
  diagram.dataset.layout = 'horizontal'
  diagram.dataset.scope = input.scope
  diagram.style.width = `${geometry.width}px`
  diagram.style.height = `${geometry.height}px`
  const svg = svgNode('svg')
  svg.setAttribute('viewBox', `0 0 ${geometry.width} ${geometry.height}`)
  svg.setAttribute('aria-label', t('circuit.aria'))
  svg.setAttribute('role', 'img')
  const wire = (name: string, path: string, override?: { observed: boolean; tone?: JevCircuitTone }) => {
    const state = override ?? input.edges[name] ?? { observed: false }
    input.edge(
      svg,
      name,
      path,
      state.observed,
      'active' in state && state.active === true,
      state.tone ?? 'neutral',
    )
  }
  const busY = geometry.height - 28
  wire('ledger-context', `M${p.ledger.x} 48 H${center(p.context).x} V${p.context.y}`)
  wire(
    'ledger-language-context',
    `M${p.ledger.x + p.ledger.width} 48 H${center(p['language-context']).x} V${p['language-context'].y}`,
  )
  wire(
    'language-context-helper',
    `M${right(p['language-context']).x} ${center(p['language-context']).y} H${right(p['language-context']).x + 20} V${center(p.helper).y} H${right(p.helper).x}`,
  )
  wire(
    'language-context-answer',
    `M${right(p['language-context']).x} ${center(p['language-context']).y} H${right(p['language-context']).x + 30} V${center(p.answer).y} H${right(p.answer).x}`,
  )
  wire('context-request', curve(right(p.context), left(p.decision)))
  wire(
    'request-candidates',
    `M${right(p.decision).x} ${center(p.decision).y} H${geometry.poolLeft - 8} V144 H${geometry.poolRight + 8}`,
  )
  wire('candidates-gate', `M${geometry.poolRight + 8} 144 V${center(p.gate).y} H${p.gate.x}`)
  wire('gate-intent', curve(right(p.gate), left(p.intent)))
  wire('intent-dispatch', curve(right(p.intent), left(p.host)))
  wire('dispatch-settlement', `M${center(p.host).x} ${p.host.y + p.host.height} V${p.result.y}`)
  wire(
    'result-ledger',
    `M${right(p.result).x} ${center(p.result).y} H${geometry.width - 12} V48 H${p.ledger.x + p.ledger.width}`,
  )
  wire('gate-helper', `M${center(p.gate).x} ${p.gate.y + p.gate.height} V${p.helper.y}`)
  wire(
    'helper-intent',
    `M${right(p.helper).x} ${center(p.helper).y} H${center(p.intent).x} V${p.intent.y + p.intent.height}`,
  )
  wire(
    'gate-answer',
    `M${p.gate.x} ${center(p.gate).y} H${p.gate.x - 18} V${center(p.answer).y} H${p.answer.x}`,
  )
  wire(
    'answer-ledger',
    `M${center(p.answer).x} ${p.answer.y + p.answer.height} V${busY} H12 V48 H${p.ledger.x}`,
  )
  const pools = node('div')
  pools.className = 'jev-circuit-pools'
  for (const fan of geometry.fans) {
    const { head, rect, options } = fan
    const start = { x: rect.x + 8, y: rect.y + 62 + (Math.max(1, options.length) - 1) * 19 }
    const end = { x: rect.x + rect.width - 8, y: start.y }
    const consumed = head.status === 'consumed' || head.status === 'deterministic'
    const tone = ({ phase: 'jev', action: 'tool', binding: 'llm', other: 'neutral' } as const)[head.role]
    const panel = svgNode('rect')
    panel.setAttribute('class', 'jev-fan-panel')
    panel.setAttribute('data-status', head.status)
    panel.setAttribute('data-circuit-panel', `${input.requestKey}:${head.key}`)
    for (const [key, value] of Object.entries({
      x: rect.x + 4,
      y: rect.y + 4,
      width: rect.width - 8,
      height: rect.height - 8,
    }))
      panel.setAttribute(key, String(value))
    panel.setAttribute('data-tone', tone)
    panel.setAttribute('rx', '12')
    svg.append(panel)
    const group = node('section')
    group.className = 'jev-flow-fan jev-compact-head'
    group.dataset.compactHead = head.key
    group.dataset.request = input.requestKey
    group.dataset.role = head.role
    group.dataset.status = head.status
    for (const [property, value] of Object.entries({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    }))
      group.style.setProperty(property, `${value}px`)
    const title = node('button')
    title.type = 'button'
    title.className = 'jev-compact-head-title'
    title.title = `${roles[head.role]} · ${head.key} · ${status[head.status]}`
    title.setAttribute('aria-label', title.title)
    title.append(node('span', headTitle(t, head)), node('small', status[head.status]))
    title.onclick = () => input.onHead(head)
    group.append(title)
    wire(`candidate-input-${head.key}`, `M${start.x} 144 V${start.y}`, {
      observed: input.edges['request-candidates']?.observed === true,
      tone: 'jev',
    })
    wire(`candidate-output-${head.key}`, `M${end.x} ${end.y} V144`, {
      observed: consumed,
      tone: 'jev',
    })
    if (!options.length) {
      const empty = node(
        'small',
        head.status === 'unconsumed' && !fan.expanded
          ? t('circuit.fan.unconsumed', { total: fan.total })
          : t('circuit.fan.waiting'),
      )
      empty.className = 'jev-fan-empty'
      group.append(empty)
      wire(`candidate-empty-${head.key}`, curve(start, end))
    }
    for (const [index, option] of options.entries()) {
      const point = { x: rect.x + 115, y: rect.y + 62 + index * 38 }
      const supporting = head.status === 'supporting' && option.key === head.selected
      const selected = option.selected
      const state = { observed: selected || supporting, tone }
      wire(
        `candidate-option-in-${head.key}-${option.key}`,
        curve(start, { x: point.x - 87, y: point.y }),
        state,
      )
      wire(
        `candidate-option-out-${head.key}-${option.key}`,
        curve({ x: point.x + 87, y: point.y }, end),
        state,
      )
      const capsule = node('button')
      capsule.type = 'button'
      capsule.className = 'jev-compact-option jev-flow-option'
      capsule.dataset.selected = String(selected)
      capsule.dataset.supporting = String(supporting)
      capsule.dataset.optionKey = option.key
      capsule.dataset.status = head.status
      capsule.style.left = '28px'
      capsule.style.top = `${point.y - rect.y - 16}px`
      capsule.style.width = '174px'
      capsule.style.height = '32px'
      const probability =
        head.status === 'deterministic'
          ? t('circuit.probability.fixed')
          : option.probability === undefined
            ? '—'
            : `${(option.probability * 100).toFixed(1)}%`
      const optionState = selected
        ? t('circuit.optionState.selected')
        : supporting
          ? t('circuit.optionState.supporting')
          : head.status === 'pending'
            ? t('circuit.optionState.pending')
            : head.status === 'invalid'
              ? t('circuit.optionState.invalid')
              : t('circuit.optionState.unconsumed')
      capsule.title = `${option.key} · ${probability} · ${optionState}`
      capsule.setAttribute('aria-label', `${head.key}: ${capsule.title}`)
      const line = node('span')
      line.append(node('strong', optionLabel(t, head, option)), node('small', probability))
      capsule.append(line)
      capsule.onclick = () => input.onOption(head, option, optionState)
      group.append(capsule)
    }
    if (options.length < fan.total || fan.expanded) {
      const toggle = node(
        'button',
        fan.expanded ? t('circuit.toggle.collapse') : t('circuit.toggle.expand', { count: fan.total - options.length }),
      )
      toggle.type = 'button'
      toggle.className = 'jev-candidate-toggle'
      toggle.dataset.candidateToggle = head.key
      toggle.style.top = `${rect.height - 30}px`
      toggle.setAttribute(
        'aria-label',
        t(fan.expanded ? 'circuit.toggle.aria.collapse' : 'circuit.toggle.aria.expand', { key: head.key }),
      )
      toggle.setAttribute('aria-expanded', String(fan.expanded))
      toggle.onclick = () => input.onToggle(head)
      group.append(toggle)
    }
    for (const [side, point] of [start, end].entries()) {
      const junction = svgNode('circle')
      junction.setAttribute('class', 'jev-fan-junction')
      junction.setAttribute('data-circuit-junction', `${input.requestKey}:${head.key}:${side}`)
      junction.setAttribute('cx', String(point.x))
      junction.setAttribute('cy', String(point.y))
      junction.setAttribute('r', '3')
      junction.setAttribute('data-status', head.status)
      junction.setAttribute('data-tone', tone)
      junction.setAttribute('data-selected', String(consumed))
      svg.append(junction)
    }
    pools.append(group)
  }
  diagram.append(svg, pools)
  for (const stage of input.stages) {
    const rect = p[stage.id]
    const button = node('button')
    button.type = 'button'
    button.className = 'jev-stage'
    button.dataset.stage = stage.id
    button.dataset.tone = stage.tone
    button.dataset.observed = String(stage.evidence !== undefined)
    button.dataset.active = String(stage.active === true)
    if (stage.id === 'decision') button.dataset.shape = 'core'
    for (const [property, value] of Object.entries({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    }))
      button.style.setProperty(property, `${value}px`)
    button.title = stage.tooltip ?? `${stage.title}\n${stage.body}`
    button.setAttribute('aria-label', button.title)
    button.append(node('strong', stage.title), node('span', stage.body))
    for (const side of stage.id === 'candidates' ? [] : ['input', 'output']) {
      const port = node('i')
      port.className = 'jev-stage-port'
      port.dataset.port = side
      port.dataset.side = side
      port.setAttribute('aria-hidden', 'true')
      button.append(port)
    }
    button.disabled = stage.evidence === undefined
    if (!button.disabled) button.onclick = () => input.onStage(stage)
    diagram.append(button)
  }
  const space = node('div')
  space.className = 'jev-canvas-space'
  space.append(diagram)
  const existing = input.viewport.querySelector<HTMLElement>('.jev-canvas-space')
  const existingDiagram = existing?.querySelector<HTMLElement>('.jev-circuit')
  if (existing && existingDiagram?.dataset.scope === input.scope) {
    reconcileChildren(existing, space)
    return {
      diagram: existing.querySelector<HTMLElement>('.jev-circuit'),
      width: geometry.width,
      height: geometry.height,
    }
  }
  input.viewport.replaceChildren(space)
  return { diagram, width: geometry.width, height: geometry.height }
}
