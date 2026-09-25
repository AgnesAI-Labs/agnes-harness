import type { UINode, UITurn } from '@agnes/protocol'
import { bindAutoDismissDisclosure } from '@agnes/web-admin-frame'
import {
  type ClientResourceService,
  type LocaleService,
  type SessionService,
  type SlotEntry,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import { ConversationMessages, type ConversationMessagesProps } from '@agnes/web-ui/assistant-ui'
import { createConversationMessageActions, createConversationToolCard } from '@agnes/web-units'
import { type ReactNode, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { ClaimResolver } from './client-modules/boot.js'
import { createMarkdownRenderer } from './markdown.js'
import { toolIcon } from './tool-icon.js'
import { createCostDetails } from './usage.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>
type CostNode = Extract<UINode, { kind: 'cost' }>
type SlotNode = Extract<UINode, { kind: 'slot' }>
const noSessionSubscription = () => () => undefined

function TurnActions({
  turn,
  finalText,
  settled,
  onFork,
}: {
  turn: UITurn
  finalText: string
  settled: boolean
  onFork?: (turn: UITurn) => Promise<void>
}) {
  const host = useRef<HTMLDivElement>(null)
  const actions = useRef<ReturnType<typeof createConversationMessageActions>>()
  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const instance = createConversationMessageActions({
      ...(onFork ? { onFork } : {}),
      bindAutoDismiss: bindAutoDismissDisclosure,
    })
    actions.current = instance
    element.append(instance.element)
    return () => {
      instance.dispose()
      instance.element.remove()
      actions.current = undefined
    }
  }, [onFork])
  useLayoutEffect(() => actions.current?.update({ turn, finalText, settled }))
  return <div ref={host} data-agnes-turn-actions="" />
}

function MarkdownLeaf({ text }: { text: string }) {
  const element = useRef<HTMLDivElement>(null)
  const renderer = useRef<ReturnType<typeof createMarkdownRenderer>>()
  useLayoutEffect(() => {
    const host = element.current
    if (!host) return
    renderer.current = createMarkdownRenderer(host, '')
    return () => {
      renderer.current?.dispose()
      renderer.current = undefined
    }
  }, [])
  useLayoutEffect(() => renderer.current?.update(text), [text])
  return <div ref={element} data-agnes-markdown-leaf="" />
}

function ToolLeaf({ node }: { node: ToolNode }) {
  const element = useRef<HTMLDivElement>(null)
  const card = useRef<ReturnType<typeof createConversationToolCard>>()
  const initialNode = useRef(node)
  useLayoutEffect(() => {
    const host = element.current
    if (!host) return
    card.current = createConversationToolCard(host, initialNode.current, { icon: toolIcon })
    return () => {
      card.current = undefined
    }
  }, [])
  useLayoutEffect(() => card.current?.update(node), [node])
  return <div ref={element} data-agnes-tool-card="" />
}

function CostLeaf({ node }: { node: CostNode }) {
  const element = useRef<HTMLDivElement>(null)
  const update = useRef<ReturnType<typeof createCostDetails>>()
  useLayoutEffect(() => {
    const host = element.current
    if (!host) return
    update.current = createCostDetails(host)
    return () => {
      update.current = undefined
    }
  }, [])
  useLayoutEffect(() => update.current?.(node), [node])
  return <div ref={element} data-agnes-cost-details="" />
}

function SlotLeaf({
  node,
  registry,
  claim,
}: {
  node: SlotNode
  registry: SlotRegistry | undefined
  claim: ClaimResolver | undefined
}) {
  const fallback = <span>此卡片的插件未就绪</span>
  return (
    <div data-slot-node={node.fill.slot} data-agnes-region="slot-card">
      {registry && claim ? (
        <SlotOutlet
          name="tool.card.inline"
          props={{ fill: node.fill }}
          filterEntry={(entry: SlotEntry) => claim(entry, node.fill.extId)}
          fallback={fallback}
        />
      ) : (
        <div data-slot-state="empty">{fallback}</div>
      )}
    </div>
  )
}

function DshNodeLeaf({
  node,
  native,
  registry,
}: {
  node: UINode
  native: ReactNode
  registry: SlotRegistry
}) {
  const name = node.kind === 'tool' ? 'tool.call.toolview' : 'conversation.chat.node'
  const entryKey = node.kind === 'tool' ? node.name : node.kind
  const childNames =
    node.kind === 'tool'
      ? (['tool.call.images', 'tool.view.cordis'] as const)
      : ([
          ...(node.kind === 'assistant' ? ['conversation.chat.assistant-actions' as const] : []),
          'conversation.chat.commandview',
          'conversation.chat.turnTail',
          'conversation.message.images',
          'conversation.trajectory.images',
        ] as const)
  const observedNames: readonly string[] = [name, ...childNames]
  useSyncExternalStore(
    (listener) => {
      const stops = observedNames.map((slotName) => registry.subscribeBatched(slotName, listener))
      return () => {
        for (const stop of stops) stop()
      }
    },
    () => observedNames.map((slotName) => registry.getVersion(slotName)).join(':'),
  )
  const claimed = registry.entriesOfSlot(name).some((entry) => entry.options.key === entryKey)
  const props =
    node.kind === 'tool'
      ? { owner: { callId: node.toolUseId, toolName: node.name, block: node } }
      : { owner: { node, nodeId: node.id, kind: node.kind } }
  return (
    <>
      <div data-agnes-timeline-native="1" hidden={claimed}>
        {native}
      </div>
      <div data-agnes-dsh-slot={name} hidden={!claimed}>
        <SlotOutlet name={name} entryKey={entryKey} props={props} hideWhenEmpty />
      </div>
      <div data-agnes-dsh-children={name}>
        {childNames.map((childName) =>
          registry.spec(childName) ? (
            <SlotOutlet
              key={childName}
              name={childName}
              {...(childName === 'tool.view.cordis' || childName === 'conversation.chat.commandview'
                ? { entryKey }
                : {})}
              props={props}
              hideWhenEmpty
            />
          ) : null,
        )}
      </div>
    </>
  )
}

/** Independent Web harness for W3b; production transcript switching belongs to B-4. */
export function WebConversationMessages({
  registry,
  claim,
  session,
  locale,
  resources,
  turns,
  visibleNodeIds,
  onFork,
}: {
  registry?: SlotRegistry
  claim?: ClaimResolver
  session?: SessionService
  locale?: LocaleService
  resources?: ClientResourceService
  turns?: readonly UITurn[]
  visibleNodeIds?: readonly string[]
  onFork?: (turn: UITurn) => Promise<void>
}) {
  const sessionScope = useSyncExternalStore(
    registry ? registry.subscribeSession.bind(registry) : noSessionSubscription,
    () => registry?.sessionId,
  )
  const props: ConversationMessagesProps = {
    ...(turns ? { turns } : {}),
    ...(visibleNodeIds ? { visibleNodeIds } : {}),
    renderTurnActions: (turn, finalText, settled) => (
      <TurnActions
        key={turn.id}
        turn={turn}
        finalText={finalText}
        settled={settled}
        {...(onFork ? { onFork } : {})}
      />
    ),
    renderMarkdown: (text) => <MarkdownLeaf text={text} />,
    renderTool: (node) => <ToolLeaf node={node} />,
    renderCost: (node) => <CostLeaf node={node} />,
    renderSlot: (node) => <SlotLeaf key={node.id} node={node} registry={registry} claim={claim} />,
    renderNode: (node, native) =>
      registry ? <DshNodeLeaf key={node.id} node={node} native={native} registry={registry} /> : native,
  }
  const messages = <ConversationMessages key={sessionScope ?? ''} {...props} />
  return registry ? (
    <SlotsProvider
      registry={registry}
      {...(session ? { session } : {})}
      {...(locale ? { locale } : {})}
      {...(resources ? { resources } : {})}
    >
      {messages}
    </SlotsProvider>
  ) : (
    messages
  )
}
