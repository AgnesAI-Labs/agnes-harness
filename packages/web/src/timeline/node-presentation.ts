import type { UINode } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import type { ApprovalNode, UserNode } from './contracts.js'

export const APPROVAL_LABEL_KEYS: Record<ApprovalNode['state'], string> = {
  pending: 'timeline.approval.pending',
  decided: 'timeline.approval.decided',
  expired: 'timeline.approval.expired',
}

export const APPROVAL_DECISION_KEYS = new Map<string, string>([
  ['allowed-once', 'timeline.decision.allowedOnce'],
  ['allowed-session', 'timeline.decision.allowedSession'],
  ['allowed-permanent', 'timeline.decision.allowedPermanent'],
  ['rejected', 'timeline.decision.rejected'],
  ['cancelled', 'timeline.decision.cancelled'],
])

/** Why the decision ended as it did. A ledger from before reasons existed has none and falls back to the verdict. */
export const APPROVAL_REASON_KEYS = new Map<string, string>([
  ['user_rejected', 'timeline.reason.userRejected'],
  ['timeout', 'timeline.reason.timeout'],
  ['no_approver', 'timeline.reason.noApprover'],
  ['stopped', 'timeline.reason.stopped'],
  ['policy_denied', 'timeline.reason.policyDenied'],
  ['subagent_scope', 'timeline.reason.subagentScope'],
])

export const textContent = (node: UserNode): string =>
  node.content
    .filter(
      (block): block is Extract<(typeof node.content)[number], { type: 'text' }> => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')

/** 轨迹面板是纯文本视图：含图消息在这里用一行说明代替缩略图，逐张占一行。 */
export function legacyUserContent(node: UserNode, t: Translate): string {
  const images = node.content.filter((block) => block.type === 'image')
  return [textContent(node), ...images.map(() => t('timeline.imageUnavailable'))].filter(Boolean).join('\n')
}

/** What an assistant node says; an attempt whose streamed text died with its process says so. */
export function assistantText(node: Extract<UINode, { kind: 'assistant' }>, t: Translate): string {
  if (node.lostChars === undefined || node.text !== '') return node.text
  return t('timeline.lostOutput', { count: node.lostChars })
}

// 流式期间每个 preview 都会对全部节点重算一次 fingerprint，全文拼接是 O(会话总长) 的
// 字符串分配。流式正文与思考只追加（PreviewMerger 按 offset 累加后覆盖到节点上，落定时
// streaming 翻转必然改变 fingerprint），用户行内容按行 id 不可变，所以「长度 + 尾部采样」
// 足以区分真实变化。唯一盲区是等长且尾部 64 字符相同的改写：只可能出现在工具 args/result
// 预览这类瞬时文本上，接受。注意 tool.summary 不参与采样：状态文案存在等长替换。
export const FINGERPRINT_TAIL = 64

export const sampledPart = (value: string | undefined): string =>
  `${(value ?? '').length}:${value ? value.slice(-FINGERPRINT_TAIL) : ''}`

export function fingerprint(node: UINode): string {
  switch (node.kind) {
    case 'user': {
      const body = textContent(node)
      const images = node.content
        .filter((block) => block.type === 'image')
        .map(
          (block) =>
            `${block.mimeType}:${block.data.length}:${block.data.slice(0, 16)}:${block.data.slice(-16)}`,
        )
        .join('|')
      return `${node.kind}:${node.id}:${sampledPart(body)}:${images}`
    }
    case 'assistant':
      return `${node.kind}:${node.id}:${sampledPart(node.thinking)}:${sampledPart(node.text)}:${
        node.streaming === true
      }:${node.lostChars ?? ''}`
    case 'tool':
      return `${node.kind}:${node.id}:${node.name}:${node.status}:${node.summary}:${sampledPart(
        node.argsPreview,
      )}:${sampledPart(node.resultPreview)}`
    case 'approval':
      return `${node.kind}:${node.id}:${node.state}:${node.summary}:${node.decision?.verdict ?? ''}:${node.decision?.reason ?? ''}`
    case 'contribute-conflict':
      return `${node.kind}:${node.id}:${node.key}:${JSON.stringify(node.ops)}`
    case 'compaction':
      return `${node.kind}:${node.id}:${node.summary ?? ''}:${node.range.join('-')}`
    case 'cost':
      // Cost nodes are filled incrementally: the same node id can first arrive without credits,
      // then receive token/billing details from the gateway. Include the complete payload so the
      // existing entry updates instead of being incorrectly treated as unchanged.
      return `${node.kind}:${node.id}:${JSON.stringify(node)}`
    case 'artifact':
      return `${node.kind}:${node.id}:${node.name}`
    case 'slot':
      return `${node.kind}:${node.id}:${node.fill.extId}`
  }
  return ''
}
