import type { UINode, UITurn } from '@agnes/protocol'
import { bindAutoDismissDisclosure } from '@agnes/web-admin-frame'
import { type ConversationMessageActions, createConversationMessageActions } from '@agnes/web-units'

type TurnEntry = {
  element: HTMLElement
  user: HTMLElement
  status: HTMLElement
  process: HTMLDetailsElement
  processSummary: HTMLElement
  processLabel: HTMLElement
  processBody: HTMLElement
  processPreference?: boolean
  processWasActive?: boolean
  attention: HTMLElement
  final: HTMLElement
  actions: ConversationMessageActions
  refreshStatus?: () => void
}

type RenderedNode = { element: HTMLElement; thinking?: HTMLDetailsElement }

const turnStatus: Record<UITurn['status'], string> = {
  running: '正在执行',
  waiting: '等待处理',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
}

const durationLabel = (duration?: number): string | undefined => {
  if (duration === undefined) return undefined
  if (duration < 1000) return `${duration} 毫秒`
  if (duration < 60_000) return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(duration / 60_000)} 分 ${Math.round((duration % 60_000) / 1000)} 秒`
}

function processChevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'icon process-chevron')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'm6 9 6 6 6-6')
  svg.append(path)
  return svg
}

function makeTurnEntry(onFork?: (turn: UITurn) => Promise<void>): TurnEntry {
  const element = document.createElement('section')
  element.className = 'conversation-turn'
  const user = document.createElement('div')
  user.className = 'turn-user'
  const response = document.createElement('div')
  response.className = 'turn-response'
  const process = document.createElement('details')
  process.className = 'turn-process'
  // 身份行保持独立，等待首段内容或折叠过程时也不消失。
  const processSummary = document.createElement('summary')
  const identity = document.createElement('span')
  identity.className = 'process-identity'
  const avatar = document.createElement('span')
  avatar.className = 'process-avatar'
  const avatarMark = document.createElement('span')
  avatarMark.className = 'agnes-mark process-avatar-mark'
  avatarMark.setAttribute('aria-hidden', 'true')
  avatar.append(avatarMark)
  const name = document.createElement('span')
  name.className = 'process-name'
  name.textContent = 'Agnes Harness'
  identity.append(avatar, name)
  const status = document.createElement('p')
  status.className = 'turn-status'
  status.setAttribute('data-agnes-dynamic', 'turn-process')
  const row = document.createElement('span')
  row.className = 'process-row'
  const processLabel = document.createElement('span')
  processLabel.className = 'process-label'
  // The rendered label contains elapsed time (startedAt while running, daemon duration on finish).
  // It is intentionally marked
  // as dynamic so browser parity capture can mask the volatile number without hiding the whole
  // process card or weakening its text/ARIA assertions.
  processLabel.setAttribute('data-agnes-dynamic', 'turn-process')
  const chevron = processChevron()
  row.append(processLabel, chevron)
  processSummary.append(row)
  const processBody = document.createElement('div')
  processBody.className = 'turn-process-body'
  process.append(processSummary, processBody)
  const attention = document.createElement('div')
  attention.className = 'turn-attention'
  const final = document.createElement('div')
  final.className = 'turn-final'
  const actions = createConversationMessageActions({
    ...(onFork ? { onFork } : {}),
    bindAutoDismiss: bindAutoDismissDisclosure,
  })
  response.append(identity, status, process, attention, final, actions.element)
  element.append(user, response)
  const entry: TurnEntry = {
    element,
    user,
    status,
    process,
    processSummary,
    processLabel,
    processBody,
    attention,
    final,
    actions,
  }
  // 过程块**不**注册「点外部关闭」：
  // 点旁边空白把运行中的过程块收起、下一帧渲染又被撑回，既闪烁又误伤面过宽。
  // 它的开关只认 summary 点击（偏好记在 processPreference），其余区域一律不管。
  processSummary.addEventListener('click', () => {
    entry.processPreference = !process.open
  })
  return entry
}

export function createTurnProjector(options: {
  transcript: HTMLElement
  onFork?: (turn: UITurn) => Promise<void>
}) {
  const turnEntries = new Map<string, TurnEntry>()
  const ticking = new Set<TurnEntry>()
  let clock: ReturnType<typeof setInterval> | undefined
  const stopClock = () => {
    if (clock !== undefined) clearInterval(clock)
    clock = undefined
  }
  const orphan = document.createElement('section')
  orphan.className = 'timeline-unassigned'
  const place = (parent: HTMLElement, children: HTMLElement[]) => {
    for (const [index, child] of children.entries())
      if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null)
  }
  const trim = (parent: HTMLElement, children: HTMLElement[]) => {
    while (parent.children.length > children.length) parent.lastElementChild?.remove()
  }
  return {
    render(
      nodes: readonly UINode[],
      turns: readonly UITurn[] | undefined,
      resolve: (id: string) => RenderedNode | undefined,
    ): boolean {
      ticking.clear()
      if (!turns?.length) {
        stopClock()
        for (const shell of turnEntries.values()) shell.element.remove()
        turnEntries.clear()
        orphan.remove()
        return false
      }
      const nodeMap = new Map(nodes.map((node) => [node.id, node]))
      const turnIds = new Set(turns.map((turn) => turn.id))
      const assigned = new Set(turns.flatMap((turn) => turn.nodeIds))
      let changed = false
      for (const [index, turn] of turns.entries()) {
        let shell = turnEntries.get(turn.id)
        if (!shell) {
          shell = makeTurnEntry(options.onFork)
          shell.element.dataset.turnId = turn.id
          turnEntries.set(turn.id, shell)
          changed = true
        }
        const userNodes: HTMLElement[] = []
        const processNodes: HTMLElement[] = []
        const attentionNodes: HTMLElement[] = []
        const finalNodes: HTMLElement[] = []
        let finalText = ''
        let processCount = 0
        let pendingApproval = false
        let awaitingToolApproval = false
        let runningTool = false
        let latestStreaming: Extract<UINode, { kind: 'assistant' }> | undefined
        for (const id of turn.nodeIds) {
          const node = nodeMap.get(id)
          const rendered = resolve(id)
          if (!node || !rendered) continue
          const { element, thinking } = rendered
          if (node.kind === 'approval' && node.state === 'pending') pendingApproval = true
          if (node.kind === 'tool') {
            if (node.status === 'awaiting_approval') awaitingToolApproval = true
            if (node.status === 'running') runningTool = true
          }
          if (
            node.kind === 'assistant' &&
            node.streaming &&
            (!latestStreaming || node.seq >= latestStreaming.seq)
          )
            latestStreaming = node
          if (node.kind === 'user') userNodes.push(element)
          else if (id === turn.finalAssistantId) {
            if (node.kind === 'assistant' && node.thinking?.trim() && thinking) {
              processNodes.push(thinking)
              processCount++
            }
            finalNodes.push(element)
            if (node.kind === 'assistant') finalText = node.text
          } else if (node.kind === 'approval' && node.state === 'pending') attentionNodes.push(element)
          else {
            processNodes.push(element)
            processCount++
          }
        }
        // Move every node to its next owner before trimming any old owner. A streaming assistant
        // becomes the final response when the turn settles; removing it from processBody first
        // detaches a user selection, whereas an in-DOM move keeps the selection intact.
        const destinations: Array<[HTMLElement, HTMLElement[]]> = [
          [shell.user, userNodes],
          [shell.processBody, processNodes],
          [shell.attention, attentionNodes],
          [shell.final, finalNodes],
        ]
        for (const [parent, children] of destinations) place(parent, children)
        for (const [parent, children] of destinations) trim(parent, children)
        let status = turnStatus[turn.status]
        if (turn.status === 'running' || turn.status === 'waiting') {
          if (pendingApproval || awaitingToolApproval) status = '等待审批'
          else if (turn.status === 'waiting') status = turnStatus.waiting
          else if (runningTool) status = '正在执行工具'
          else if (latestStreaming?.text.trim()) status = '正在回复'
          else if (latestStreaming?.thinking?.trim()) status = '正在思考'
          else status = '正在准备回复'
        }
        const entry = shell
        const active = !turn.endedAt && (turn.status === 'running' || turn.status === 'waiting')
        const startedAt = Date.parse(turn.startedAt)
        entry.refreshStatus = () => {
          const duration =
            active && Number.isFinite(startedAt)
              ? `${Math.floor(Math.max(0, Date.now() - startedAt) / 1000)} 秒`
              : durationLabel(turn.durationMs)
          const statusText = `${status}${duration ? ` · 用时 ${duration}` : ''}`
          if (entry.status.textContent !== statusText) entry.status.textContent = statusText
          if (entry.processLabel.textContent !== statusText) entry.processLabel.textContent = statusText
        }
        entry.refreshStatus()
        if (active) ticking.add(entry)
        else delete entry.refreshStatus
        shell.status.hidden = processCount > 0
        shell.process.hidden = processCount === 0
        const processActive = turn.status === 'running' || turn.status === 'waiting'
        // 只在本回合由运行中进入终态时自动收起一次。此后的手动展开由
        // processPreference 保留，不会被终态的后续投影反复覆盖。
        if (shell.processWasActive && !processActive) shell.processPreference = false
        shell.processWasActive = processActive
        shell.process.open = shell.processPreference ?? processActive
        shell.attention.hidden = shell.attention.childElementCount === 0
        const settled =
          turn.status !== 'running' && turn.status !== 'waiting' && Boolean(turn.finalAssistantId)
        shell.actions.update({ turn, finalText, settled })
        shell.element.dataset.status = turn.status
        shell.element.dataset.inherited = String(turn.inherited)
        const child = options.transcript.children[index]
        if (child !== shell.element) {
          options.transcript.insertBefore(shell.element, child ?? null)
          changed = true
        }
      }
      for (const [id, shell] of turnEntries) {
        if (turnIds.has(id)) continue
        shell.actions.dispose()
        shell.element.remove()
        turnEntries.delete(id)
        changed = true
      }
      if (ticking.size > 0) {
        if (clock === undefined)
          clock = setInterval(() => {
            if (options.transcript.ownerDocument.visibilityState === 'hidden') return
            for (const shell of ticking) shell.refreshStatus?.()
          }, 1000)
      } else stopClock()
      const orphanNodes = nodes
        .filter((node) => !assigned.has(node.id))
        .map((node) => resolve(node.id)?.element)
        .filter((node): node is HTMLElement => Boolean(node))
      place(orphan, orphanNodes)
      trim(orphan, orphanNodes)
      orphan.hidden = orphanNodes.length === 0
      if (options.transcript.lastElementChild !== orphan) {
        options.transcript.append(orphan)
        changed = true
      }
      return changed
    },
    reset() {
      stopClock()
      ticking.clear()
      for (const shell of turnEntries.values()) shell.actions.dispose()
      turnEntries.clear()
      orphan.remove()
    },
  }
}
