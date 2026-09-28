import type { UINode, UITurn } from '@agnes/protocol'
import {
  type ClientResourceService,
  type LocaleService,
  type SessionService,
  type SlotEntry,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import {
  ConversationMarkdown,
  ConversationMessages,
  type ConversationMessagesProps,
  ConversationToolCard,
  ConversationTurnActions,
} from '@agnes/web-ui/assistant-ui'
import { type ReactNode, useSyncExternalStore } from 'react'
import type { ClaimResolver } from './client-modules/boot.js'
import { toolIconReact } from './tool-icon.js'

type SlotNode = Extract<UINode, { kind: 'slot' }>
const noSessionSubscription = () => () => undefined

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
  /** Compatibility selector; both values now use the same React-owned Markdown. */
  markdownRenderer?: 'legacy' | 'xmarkdown'
}) {
  const sessionScope = useSyncExternalStore(
    registry ? registry.subscribeSession.bind(registry) : noSessionSubscription,
    () => registry?.sessionId,
  )
  const props: ConversationMessagesProps = {
    ...(turns ? { turns } : {}),
    ...(visibleNodeIds ? { visibleNodeIds } : {}),
    renderTurnActions: (turn, finalText, settled) => (
      <ConversationTurnActions
        key={turn.id}
        turn={turn}
        finalText={finalText}
        settled={settled}
        {...(onFork ? { onFork } : {})}
      />
    ),
    renderMarkdown: (text, part, state) => (
      <ConversationMarkdown
        key={`${state?.nodeId ?? ''}:${part}`}
        source={text}
        part={part}
        streaming={state?.streaming ?? false}
      />
    ),
    renderTool: (node) => <ConversationToolCard node={node} icon={toolIconReact(node.name)} />,
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
