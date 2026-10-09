import type { UINode } from '@agnes/protocol'
import { createMarkdownRenderer } from '@agnes/web-conversation/markdown'
import type { Translate } from '@agnes/web-conversation/presentation'
import { toolIcon } from '@agnes/web-conversation/tool-icon'
import { createCostDetails } from '@agnes/web-conversation/usage'
import { createConversationToolCard } from '@agnes/web-units'
import { getSlotCardContext, mountSlotCard } from '../client-modules/timeline-slot.js'
import type { ApprovalNode, Entry, TextRef } from './contracts.js'
import {
  APPROVAL_DECISION_KEYS,
  APPROVAL_LABEL_KEYS,
  APPROVAL_REASON_KEYS,
  assistantText,
  legacyUserContent,
} from './node-presentation.js'

/** Update a text node in place so a selection never loses its owner during a stream update. */
export function updateText(ref: TextRef, value: string): void {
  if (ref.value === value) return
  if (value.startsWith(ref.value)) ref.node.appendData(value.slice(ref.value.length))
  else ref.node.replaceData(0, ref.node.length, value)
  ref.value = value
}

export function text(parent: HTMLElement, className: string, value = ''): TextRef {
  const element = document.createElement('div')
  element.className = className
  const node = document.createTextNode(value)
  element.append(node)
  parent.append(element)
  return { element, node, value }
}

export function label(parent: HTMLElement, className: string, value: string): TextRef {
  const element = document.createElement('span')
  element.className = className
  const node = document.createTextNode(value)
  element.append(node)
  parent.append(element)
  return { element, node, value }
}

export function heading(parent: HTMLElement, className: string, value: string): TextRef {
  const element = document.createElement('p')
  element.className = className
  const node = document.createTextNode(value)
  element.append(node)
  parent.append(element)
  return { element, node, value }
}

export function article(node: UINode): HTMLElement {
  const element = document.createElement('article')
  element.className = `timeline-node ${node.kind}`
  element.dataset.nodeId = node.id
  element.dataset.nodeKind = node.kind
  return element
}

export const approvalStatus = (node: ApprovalNode, t: Translate): string =>
  (node.state === 'decided' && node.decision
    ? (() => {
        const key =
          APPROVAL_REASON_KEYS.get(node.decision.reason ?? '') ??
          APPROVAL_DECISION_KEYS.get(node.decision.verdict)
        return key === undefined ? undefined : t(key)
      })()
    : undefined) ?? t(APPROVAL_LABEL_KEYS[node.state])

export function approvalLabel(node: ApprovalNode, t: Translate): string {
  return t('timeline.approvalLabel', { status: approvalStatus(node, t) })
}

export function compactionSummary(node: Extract<UINode, { kind: 'compaction' }>, t: Translate): string {
  return node.summary ?? t('timeline.compactionFallback', { range: node.range.join('–') })
}

export function createEntry(node: UINode, t: Translate, entryFingerprint: string): Entry {
  const element = article(node)

  if (node.kind === 'user') {
    const title = heading(element, 'node-label', t('timeline.userLabel'))
    const body = text(element, 'node-body', legacyUserContent(node, t))
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind !== 'user') return
        updateText(title, t('timeline.userLabel'))
        updateText(body, legacyUserContent(next, t))
      },
    }
  }

  if (node.kind === 'assistant') {
    const title = heading(element, 'node-label', 'Agnes')
    const thinking = document.createElement('details')
    thinking.className = 'thinking'
    thinking.hidden = !node.thinking?.trim()
    // 「正在思考」= 还在流式、且正文还没开始。正文一出现（或整条消息落定）就说明思考结束，
    // 此时自动收起一次；之后的开合只认用户点击（记在 thinkingPreference），
    // 与回合过程区（turns.ts 的 processPreference）同一套语义。
    const thinkingActive = (next: Extract<UINode, { kind: 'assistant' }>): boolean =>
      Boolean(next.thinking?.trim()) && next.streaming === true && next.text.trim() === ''
    let thinkingPreference: boolean | undefined
    let thinkingWasActive = thinkingActive(node)
    thinking.open = thinkingWasActive
    const thinkingSummary = document.createElement('summary')
    thinkingSummary.textContent = t('timeline.thinkingSummary')
    thinkingSummary.addEventListener('click', () => {
      thinkingPreference = !thinking.open
    })
    const thinkingContent = document.createElement('div')
    thinkingContent.className = 'thinking-content markdown'
    thinking.append(thinkingSummary, thinkingContent)
    element.append(thinking)
    const thinkingRenderer = createMarkdownRenderer(thinkingContent, node.thinking ?? '', {
      part: 'thinking',
      streaming: node.streaming === true,
    })
    const body = document.createElement('div')
    body.className = 'node-body markdown'
    element.append(body)
    const bodyRenderer = createMarkdownRenderer(body, assistantText(node, t), {
      streaming: node.streaming === true,
    })
    element.dataset.streaming = String(node.streaming === true)
    return {
      kind: node.kind,
      element,
      thinking,
      fingerprint: entryFingerprint,
      // 思考块固定排在 `.node-body` 之前（标题之后）。归属容器取 `body` 的实际父节点：
      // DSH 宿主会把原生内容整体搬进 `[data-agnes-timeline-native]`，写死 `element` 会让
      // 插入参照物不在同一父节点上而抛错。
      rehome() {
        const home = body.parentElement
        if (home === null) return
        if (thinking.parentElement === home && thinking.nextElementSibling === body) return
        home.insertBefore(thinking, body)
      },
      update(next) {
        if (next.kind !== 'assistant') return
        element.dataset.streaming = String(next.streaming === true)
        updateText(title, 'Agnes')
        thinkingSummary.textContent = t('timeline.thinkingSummary')
        thinking.hidden = !next.thinking?.trim()
        const active = thinkingActive(next)
        // 只在「思考结束」的那一刻收起一次，不会反复覆盖用户此后的手动开合。
        if (thinkingWasActive && !active) thinkingPreference = false
        thinkingWasActive = active
        thinking.open = thinkingPreference ?? active
        if (next.thinking !== undefined)
          thinkingRenderer.update(next.thinking, { streaming: next.streaming === true })
        bodyRenderer.update(assistantText(next, t), { streaming: next.streaming === true })
      },
      dispose() {
        thinkingRenderer.dispose({ defer: true })
        bodyRenderer.dispose({ defer: true })
      },
    }
  }

  if (node.kind === 'tool') {
    const card = createConversationToolCard(element, node, { icon: toolIcon, translate: t })
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind !== 'tool') return
        card.update(next)
      },
      dispose() {
        card.dispose()
      },
    }
  }

  if (node.kind === 'approval') {
    const head = document.createElement('div')
    head.className = 'approval-head'
    const title = label(head, 'node-label', t('timeline.approvalTitle'))
    const status = label(head, 'tool-status', approvalStatus(node, t))
    const summary = text(element, 'approval-summary', node.summary)
    element.prepend(head)
    element.setAttribute('aria-label', approvalLabel(node, t))
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind !== 'approval') return
        updateText(title, t('timeline.approvalTitle'))
        updateText(status, approvalStatus(next, t))
        updateText(summary, next.summary)
        element.setAttribute('aria-label', approvalLabel(next, t))
        element.dataset.state = next.state
      },
    }
  }

  if (node.kind === 'cost') {
    const update = createCostDetails(element, t)
    update(node)
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind === 'cost') update(next)
      },
    }
  }

  if (node.kind === 'artifact') {
    const title = heading(element, 'node-label', t('timeline.artifactLabel'))
    const body = text(element, 'node-body', node.name)
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind !== 'artifact') return
        updateText(title, t('timeline.artifactLabel'))
        updateText(body, next.name)
      },
    }
  }

  if (node.kind === 'compaction') {
    const title = heading(element, 'node-label', t('timeline.compactionLabel'))
    const body = text(element, 'node-body', compactionSummary(node, t))
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind !== 'compaction') return
        updateText(title, t('timeline.compactionLabel'))
        updateText(body, compactionSummary(next, t))
      },
    }
  }

  if (node.kind === 'slot') {
    // WC9：slot 节点的稳定容器。client-modules 底座未启动时由 mountSlotCard 降级为静态占位。
    const mount = mountSlotCard({ node, context: getSlotCardContext() })
    element.append(mount.element)
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind !== 'slot') return
        mount.update(next)
      },
      dispose() {
        mount.dispose()
      },
    }
  }

  const title = heading(element, 'node-label', t('timeline.unsupportedLabel'))
  const body = text(element, 'node-body', '')
  const update = (next: UINode) => {
    if (next.kind !== 'contribute-conflict') return
    updateText(title, t('timeline.conflictLabel'))
    updateText(
      body,
      `${next.key}${t('timeline.conflictJoiner')}${next.ops.join(t('timeline.conflictOpsJoiner'))}`,
    )
    element.setAttribute('role', 'note')
  }
  update(node)
  return {
    kind: node.kind,
    element,
    fingerprint: entryFingerprint,
    update,
  }
}
