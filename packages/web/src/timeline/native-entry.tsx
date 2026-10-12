import type { UINode } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { toolIcon } from '@agnes/web-conversation/tool-icon'
import { createRegionHost, renderRegion, unmountRegion } from '@agnes/web-ui'
import { ConversationMarkdown, costDetails, costSummary } from '@agnes/web-ui/assistant-ui'
import { createConversationToolCard } from '@agnes/web-units'
import { Fragment, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { getSlotCardContext, mountSlotCard } from '../client-modules/timeline-slot.js'
import type { ApprovalNode, Entry } from './contracts.js'
import {
  APPROVAL_DECISION_KEYS,
  APPROVAL_LABEL_KEYS,
  APPROVAL_REASON_KEYS,
  assistantText,
  legacyUserContent,
} from './node-presentation.js'

export const approvalStatus = (node: ApprovalNode, t: Translate): string =>
  ((node.state === 'decided' || (node.state === 'expired' && node.decision?.reason === 'stopped')) &&
  node.decision
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

/** Stable React host moves intact into the DSH fallback; controllers retain entry ordering. */
export function createEntry(node: UINode, t: Translate, entryFingerprint: string): Entry {
  const element = createRegionHost(document.body, 'article', `timeline-node ${node.kind}`)
  element.remove()
  element.dataset.nodeId = node.id
  element.dataset.nodeKind = node.kind
  if (node.kind === 'tool') {
    const card = createConversationToolCard(element, node, { icon: toolIcon, translate: t })
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind === 'tool') card.update(next)
      },
      dispose: card.dispose,
    }
  }
  if (node.kind === 'slot') {
    const mount = mountSlotCard({ node, context: getSlotCardContext() })
    element.append(mount.element)
    return {
      kind: node.kind,
      element,
      fingerprint: entryFingerprint,
      update(next) {
        if (next.kind === 'slot') mount.update(next)
      },
      dispose: mount.dispose,
    }
  }
  const host = createRegionHost(element, 'div', 'conversation-content-host')
  let thinking: HTMLDetailsElement | null = null
  let body: HTMLDivElement | null = null
  let thinkingPreference: boolean | undefined
  let thinkingWasActive = false
  let disposed = false
  const rehome = () => {
    const home = body?.parentElement
    if (!home || !thinking) return
    if (thinking.parentElement !== home || thinking.nextElementSibling !== body)
      home.insertBefore(thinking, body)
  }
  const render = (next: UINode) => {
    if (disposed || next.kind !== node.kind) return
    let content: ReactNode
    switch (next.kind) {
      case 'user':
        content = (
          <>
            <p className="node-label">{t('timeline.userLabel')}</p>
            <div className="node-body">{legacyUserContent(next, t)}</div>
          </>
        )
        break
      case 'assistant': {
        const active = Boolean(next.thinking?.trim()) && next.streaming === true && next.text.trim() === ''
        if (thinkingWasActive && !active) thinkingPreference = false
        thinkingWasActive = active
        element.dataset.streaming = String(next.streaming === true)
        content = (
          <>
            <p className="node-label">{t('brand.agent')}</p>
            <details
              ref={(value) => {
                thinking = value
              }}
              className="thinking"
              hidden={!next.thinking?.trim()}
              open={thinkingPreference ?? active}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: native summary owns disclosure keyboard behavior. */}
              <summary
                onClick={() => {
                  thinkingPreference = !thinking?.open
                }}
              >
                {t('timeline.thinkingSummary')}
              </summary>
              <div className="thinking-content markdown">
                <ConversationMarkdown
                  source={next.thinking ?? ''}
                  part="thinking"
                  streaming={next.streaming === true}
                  onRelease={flushSync}
                  syntax="immediate"
                />
              </div>
            </details>
            <div
              ref={(value) => {
                body = value
              }}
              className="node-body markdown"
            >
              <ConversationMarkdown
                source={assistantText(next, t)}
                part="body"
                streaming={next.streaming === true}
                onRelease={flushSync}
                syntax="immediate"
              />
            </div>
          </>
        )
        break
      }
      case 'approval':
        element.setAttribute('aria-label', approvalLabel(next, t))
        element.dataset.state = next.state
        content = (
          <>
            <div className="approval-head">
              <span className="node-label">{t('timeline.approvalTitle')}</span>
              <span className="tool-status">{approvalStatus(next, t)}</span>
            </div>
            <div className="approval-summary">{next.summary}</div>
          </>
        )
        break
      case 'cost':
        content = (
          <details className="usage-disclosure call-usage">
            <summary aria-label={t('cost.callDetailsAria')}>{costSummary(next, t)}</summary>
            <dl className="usage-grid">
              {costDetails(next, t).map(([name, value]) => (
                <Fragment key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </Fragment>
              ))}
            </dl>
          </details>
        )
        break
      case 'artifact':
        content = (
          <>
            <p className="node-label">{t('timeline.artifactLabel')}</p>
            <div className="node-body">{next.name}</div>
          </>
        )
        break
      case 'compaction':
        content = (
          <>
            <p className="node-label">{t('timeline.compactionLabel')}</p>
            <div className="node-body">{compactionSummary(next, t)}</div>
          </>
        )
        break
      case 'contribute-conflict':
        element.setAttribute('role', 'note')
        content = (
          <>
            <p className="node-label">{t('timeline.conflictLabel')}</p>
            <div className="node-body">
              {next.key}
              {t('timeline.conflictJoiner')}
              {next.ops.join(t('timeline.conflictOpsJoiner'))}
            </div>
          </>
        )
        break
      default:
        content = (
          <>
            <p className="node-label">{t('timeline.unsupportedLabel')}</p>
            <div className="node-body" />
          </>
        )
    }
    renderRegion(host, content)
  }
  render(node)
  return {
    kind: node.kind,
    element,
    fingerprint: entryFingerprint,
    ...(thinking ? { thinking } : {}),
    rehome,
    update: render,
    dispose() {
      if (disposed) return
      disposed = true
      rehome()
      queueMicrotask(() => unmountRegion(host))
    },
  }
}
