import type { UINode, UITurn } from '@agnes/protocol'
import { createRegionHost, renderRegion, unmountRegion } from '@agnes/web-ui'
import { type ConversationMessageActions, createConversationMessageActions } from '@agnes/web-units'
import type { Translate } from './presentation.js'

type TurnEntry = {
  element: HTMLElement
  user: HTMLElement
  status: HTMLElement
  error: HTMLElement
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
  dispose(): void
}

type RenderedNode = { element: HTMLElement; thinking?: HTMLDetailsElement }

const TURN_STATUS_KEYS: Record<UITurn['status'], string> = {
  running: 'turn.status.running',
  waiting: 'turn.status.waiting',
  completed: 'turn.status.completed',
  failed: 'turn.status.failed',
  cancelled: 'turn.status.cancelled',
}

const durationLabel = (duration: number | undefined, t: Translate): string | undefined => {
  if (duration === undefined) return undefined
  if (duration < 1000) return t('turn.duration.ms', { n: duration })
  if (duration < 60_000)
    return t('turn.duration.s', { n: (duration / 1000).toFixed(duration < 10_000 ? 1 : 0) })
  return t('turn.duration.minSec', {
    min: Math.floor(duration / 60_000),
    sec: Math.round((duration % 60_000) / 1000),
  })
}

/** React owns the shell; the projector only moves stable node hosts between empty outlets. */
function makeTurnEntry(onFork: ((turn: UITurn) => Promise<void>) | undefined, t: Translate): TurnEntry {
  const element = createRegionHost(document.body, 'section', 'conversation-turn')
  element.remove()
  renderRegion(
    element,
    <>
      <div className="turn-user" />
      <div className="turn-response">
        <span className="process-identity">
          <span className="process-avatar">
            <span className="agnes-mark process-avatar-mark" aria-hidden="true" />
          </span>
          <span className="process-name">{t('brand.harness')}</span>
        </span>
        <p className="turn-status" data-agnes-dynamic="turn-process" />
        <details className="turn-process">
          <summary>
            <span className="process-row">
              <span className="process-label" data-agnes-dynamic="turn-process" />
              <svg className="icon process-chevron" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </summary>
          <div className="turn-process-body" />
        </details>
        <p className="turn-error" role="alert" hidden />
        <div className="turn-attention" />
        <div className="turn-final" />
      </div>
    </>,
  )
  const find = <T extends HTMLElement>(selector: string): T => {
    const node = element.querySelector<T>(selector)
    if (!node) throw new Error(`missing turn shell ${selector}`)
    return node
  }
  const actions = createConversationMessageActions({ ...(onFork ? { onFork } : {}), t })
  find('.turn-response').append(actions.element)
  const entry: TurnEntry = {
    element,
    user: find('.turn-user'),
    status: find('.turn-status'),
    error: find('.turn-error'),
    process: find('.turn-process'),
    processSummary: find('summary'),
    processLabel: find('.process-label'),
    processBody: find('.turn-process-body'),
    attention: find('.turn-attention'),
    final: find('.turn-final'),
    actions,
    dispose() {
      actions.dispose()
      queueMicrotask(() => unmountRegion(element))
    },
  }
  // The process disclosure only follows its summary; outside clicks never reset its preference.
  entry.processSummary.addEventListener('click', () => {
    entry.processPreference = !entry.process.open
  })
  return entry
}

export function createTurnProjector(options: {
  transcript: HTMLElement
  onFork?: (turn: UITurn) => Promise<void>
  translate: Translate
  localeTag?: () => string
}) {
  const t = options.translate
  const turnEntries = new Map<string, TurnEntry>()
  const ticking = new Set<TurnEntry>()
  let clock: ReturnType<typeof setInterval> | undefined
  const stopClock = () => {
    if (clock !== undefined) clearInterval(clock)
    clock = undefined
  }
  const orphan = createRegionHost(options.transcript, 'section', 'timeline-unassigned')
  orphan.remove()
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
        for (const shell of turnEntries.values()) {
          shell.dispose()
          shell.element.remove()
        }
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
          shell = makeTurnEntry(options.onFork, t)
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
        let status = t(TURN_STATUS_KEYS[turn.status])
        if (turn.status === 'running' || turn.status === 'waiting') {
          if (pendingApproval || awaitingToolApproval) status = t('turn.status.awaitingApproval')
          else if (turn.status === 'waiting') status = t(TURN_STATUS_KEYS.waiting)
          else if (runningTool) status = t('turn.status.runningTool')
          else if (latestStreaming?.text.trim()) status = t('turn.status.replying')
          else if (latestStreaming?.thinking?.trim()) status = t('turn.status.thinking')
          else status = t('turn.status.preparing')
        }
        const entry = shell
        const active = !turn.endedAt && (turn.status === 'running' || turn.status === 'waiting')
        const startedAt = Date.parse(turn.startedAt)
        entry.refreshStatus = () => {
          const duration =
            active && Number.isFinite(startedAt)
              ? t('turn.duration.s', { n: Math.floor(Math.max(0, Date.now() - startedAt) / 1000) })
              : durationLabel(turn.durationMs, t)
          const statusText = duration ? `${status}${t('turn.elapsedSuffix', { duration })}` : status
          if (entry.status.textContent !== statusText) entry.status.textContent = statusText
          if (entry.processLabel.textContent !== statusText) entry.processLabel.textContent = statusText
        }
        entry.refreshStatus()
        entry.error.hidden = turn.status !== 'failed'
        const errorText =
          turn.status !== 'failed'
            ? ''
            : turn.error
              ? t('turn.error.codeJoin', { code: turn.error.code, message: turn.error.message })
              : t('turn.error.noDetail', { reason: turn.reason ?? t('turn.error.unknownReason') })
        if (entry.error.textContent !== errorText) entry.error.textContent = errorText
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
        shell.actions.update({ turn, finalText, settled, localeTag: options.localeTag?.() ?? 'en-US' })
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
        shell.dispose()
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
      for (const shell of turnEntries.values()) shell.dispose()
      turnEntries.clear()
      orphan.remove()
    },
  }
}
