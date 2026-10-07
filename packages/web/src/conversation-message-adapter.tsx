import { parseAnswer, type UINode, type UITurn } from '@agnes/protocol'
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
import { DefaultToolCards } from './default-tool-cards.js'
import { toolIconReact } from './tool-icon.js'

type SlotNode = Extract<UINode, { kind: 'slot' }>
const noSessionSubscription = () => () => undefined

function SlotLeaf({
  node,
  registry,
  claim,
  t,
}: {
  node: SlotNode
  registry: SlotRegistry | undefined
  claim: ClaimResolver | undefined
  t: (key: string) => string
}) {
  const fallback = <span>{t('slot.notReady')}</span>
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

/** Independent Web harness for transcript projection and interaction. */
export function WebConversationMessages({
  registry,
  claim,
  session,
  locale,
  resources,
  turns,
  nodes,
  visibleNodeIds,
  onFork,
}: {
  registry?: SlotRegistry
  claim?: ClaimResolver
  session?: SessionService
  locale?: LocaleService
  resources?: ClientResourceService
  nodes?: readonly UINode[]
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
  const answered = new Set<string>()
  for (const tool of nodes ?? []) {
    if (tool.kind !== 'tool') continue
    for (const fill of tool.slots ?? []) {
      const payload = fill.payload as import('@agnes/protocol/gen/slots').ToolCardInlinePayload
      if (!payload.question) continue
      for (const node of nodes ?? []) {
        if (node.kind !== 'user') continue
        const text = node.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        if (parseAnswer(payload.question.id, payload.question.questions, text))
          answered.add(payload.question.id)
      }
    }
  }
  const props: ConversationMessagesProps = {
    t: (key, vars) => locale?.t(key, vars) ?? key,
    ...(turns ? { turns } : {}),
    ...(visibleNodeIds ? { visibleNodeIds } : {}),
    renderTurnActions: (turn, finalText, settled) => (
      <ConversationTurnActions
        key={turn.id}
        turn={turn}
        finalText={finalText}
        settled={settled}
        t={(key, vars) => locale?.t(key, vars) ?? key}
        {...(locale ? { localeTag: locale.locale } : {})}
        {...(onFork ? { onFork } : {})}
      />
    ),
    renderMarkdown: (text, part, state) => (
      <ConversationMarkdown
        key={`${state?.nodeId ?? ''}:${part}`}
        source={text}
        part={part}
        streaming={state?.streaming ?? false}
        t={(key, vars) => locale?.t(key, vars) ?? key}
      />
    ),
    renderTool: (node) => (
      <>
        <DefaultToolCards
          node={node}
          answered={answered}
          {...(session ? { session } : {})}
          {...(resources ? { resources } : {})}
        />
        <ConversationToolCard
          key={node.id}
          node={node}
          icon={toolIconReact(node.name)}
          t={(key, vars) => locale?.t(key, vars) ?? key}
        />
      </>
    ),
    renderSlot: (node) => (
      <SlotLeaf
        key={node.id}
        node={node}
        registry={registry}
        claim={claim}
        t={(key) => locale?.t(key) ?? key}
      />
    ),
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
