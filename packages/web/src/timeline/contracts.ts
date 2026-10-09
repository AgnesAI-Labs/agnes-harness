import { mountMessageFeedback } from '../message-feedback.js'
import type { UINode, UITurn } from '@agnes/protocol'
import {
  type ClientResourceService,
  type LocaleService,
  type SessionService,
  type SlotRegistry,
} from '@agnes/web-client'

export type TimelineRendererOptions = {
  /** Node entries are owned and ordered inside this content container. */
  transcript: HTMLElement
  /** Optional scrolling viewport around the content container. */
  scrollContainer?: HTMLElement
  newContentButton: HTMLButtonElement
  onFork?: (turn: UITurn) => Promise<void>
  /** Optional DSH registry used to project keyed conversation node renderers. */
  registry?: SlotRegistry
  session?: SessionService
  locale?: LocaleService
  resources?: ClientResourceService
}

/** Whether older records exist before the loaded window, and how to load a page of them. */
export type TimelineMeta = { hasEarlier: boolean; loadEarlier?: () => void }

export type TimelineRenderer = {
  render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TimelineMeta): void
  reset(): void
  dispose?(): void
  /** 程序化贴底（瞬时、不计为用户滚动）。会话区外的布局变化（审批卡显隐）后由宿主调用。 */
  pinToBottom(): void
}

export type UserNode = Extract<UINode, { kind: 'user' }>

export type ApprovalNode = Extract<UINode, { kind: 'approval' }>

export type TextRef = { element: HTMLElement; node: Text; value: string }

export type Entry = {
  messageFeedback?: ReturnType<typeof mountMessageFeedback>

  kind: UINode['kind']
  element: HTMLElement
  thinking?: HTMLDetailsElement
  fingerprint: string
  update(node: UINode): void
  /**
   * 把思考块放回自己的 article。
   * 回合投影会把「最后一个思考」临时搬进过程折叠（见 `turns.ts`），所以每条渲染路径都要先
   * 恢复归属再分发：否则无回合分组、游离节点或回合被撤下时，思考会留在旧容器里丢掉。
   */
  rehome?: () => void
  dispose?(): void
  dshNode?: DshNodeMount | undefined
}

export type DshNodeMount = {
  update(node: UINode): void
  dispose(): void
}
