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
  ConversationInteractionResult,
  ConversationMarkdown,
  ConversationMessages,
  type ConversationMessagesProps,
  ConversationToolCard,
  ConversationTurnActions,
  interactionToolPresentation,
} from '@agnes/web-ui/assistant-ui'
import { type ReactNode, useSyncExternalStore } from 'react'
import type { ClaimResolver } from './client-modules/boot.js'
import { conversationToolCardKind, keepConversationCardVisible } from './conversation-card-layout.js'
import { RegisteredConversationCard } from './conversation-registry.js'
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
function interactionEcho(
  nodes: readonly UINode[],
  text: string,
  nodeId?: string,
): Extract<UINode, { kind: 'tool' }> | undefined {
  const demoResult = text.startsWith('[Demo model — local, deterministic, no API key] Tool result: ')
  const index = nodes.findIndex((node) => node.id === nodeId)
  const preceding =
    demoResult && index > 0 ? nodes.slice(0, index).findLast((node) => node.kind === 'tool') : undefined
  if (preceding?.kind === 'tool' && interactionToolPresentation(preceding)) return preceding
  return nodes.find(
    (node): node is Extract<UINode, { kind: 'tool' }> =>
      node.kind === 'tool' &&
      !!node.resultPreview &&
      !!interactionToolPresentation(node) &&
      (text.trim() === node.resultPreview.trim() ||
        (demoResult &&
          text
            .replace(/\s+/g, ' ')
            .trim()
            .endsWith(`Tool result: ${node.resultPreview.replace(/\s+/g, ' ').trim()}`))),
  )
}

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
  // Route exact interaction echoes into the tool's existing disclosure, keeping one details action.
  const echoedTools = new Map<string, Extract<UINode, { kind: 'tool' }>>()
  const rawEchoes = new Map<string, string[]>()
  for (const node of nodes ?? []) {
    if (node.kind !== 'assistant') continue
    const echo = interactionEcho(nodes ?? [], node.text, node.id)
    if (!echo) continue
    echoedTools.set(node.id, echo)
    rawEchoes.set(echo.id, [...(rawEchoes.get(echo.id) ?? []), node.text])
  }
  const answered = new Set<string>()
  const answerLabels = new Map<string, string>()
  const answerMessages = new Map<string, string>()
  const answerValues = new Map<string, Record<string, string | string[]>>()
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
        const values = parseAnswer(payload.question.id, payload.question.questions, text)
        if (values) {
          answered.add(payload.question.id)
          answerValues.set(payload.question.id, values)
          const label = new Intl.ListFormat(locale?.locale ?? 'en', {
            style: 'long',
            type: 'conjunction',
          }).format(Object.values(values).flat())
          answerLabels.set(tool.id, label)
          answerMessages.set(node.id, label)
        }
      }
    }
  }
  const props: ConversationMessagesProps = {
    keepNodeVisible: (node) => keepConversationCardVisible(node) || rawEchoes.has(node.id),
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
    renderMarkdown: (text, part, state) => {
      const markdown = (
        <ConversationMarkdown
          key={`${state?.nodeId ?? ''}:${part}`}
          source={text}
          part={part}
          streaming={state?.streaming ?? false}
          t={(key, vars) => locale?.t(key, vars) ?? key}
        />
      )
      const echo = part === 'body' && state?.nodeId ? echoedTools.get(state.nodeId) : undefined
      if (echo) return null
      return markdown
    },
    renderTool: (node) => (
      <RegisteredConversationCard
        card={{
          kind: conversationToolCardKind(node) ?? 'tool',
          data: node,
        }}
        context={{
          t: (key, vars) => locale?.t(key, vars) ?? key,
          data: (
            <>
              <DefaultToolCards
                node={node}
                answered={answered}
                answerValues={answerValues}
                {...(locale ? { t: (key: string) => locale.t(key) } : {})}
                {...(session ? { session } : {})}
                {...(resources ? { resources } : {})}
              />
              {conversationToolCardKind(node) === 'child-agent' && node.resultPreview && (
                <div
                  role="log"
                  data-testid="child-engine-output"
                  aria-live="polite"
                  aria-relevant="additions"
                  aria-label={locale?.t('cards.child.output') ?? 'cards.child.output'}
                >
                  {node.resultPreview}
                </div>
              )}
              <ConversationToolCard
                key={node.id}
                node={node}
                resultAppendix={rawEchoes.get(node.id)?.join('\n\n')}
                icon={toolIconReact(node.name)}
                presentation={interactionToolPresentation(
                  node,
                  (key, vars) => locale?.t(key, vars) ?? key,
                  answerLabels.get(node.id),
                )}
                t={(key, vars) => locale?.t(key, vars) ?? key}
              />
            </>
          ),
        }}
      />
    ),
    renderSlot: (node) => (
      <RegisteredConversationCard
        card={{ kind: 'plugin', data: node }}
        context={{
          t: (key) => locale?.t(key) ?? key,
          data: (
            <SlotLeaf
              key={node.id}
              node={node}
              registry={registry}
              claim={claim}
              t={(key) => locale?.t(key) ?? key}
            />
          ),
        }}
      />
    ),
    renderNode: (node, native) => {
      const answer = answerMessages.get(node.id)
      const content = answer ? (
        <ConversationInteractionResult
          summary={locale?.t('tool.interaction.answered', { answer }) ?? answer}
          t={(key, vars) => locale?.t(key, vars) ?? key}
        >
          {native}
        </ConversationInteractionResult>
      ) : (
        native
      )
      return registry ? (
        <DshNodeLeaf key={node.id} node={node} native={content} registry={registry} />
      ) : (
        content
      )
    },
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
