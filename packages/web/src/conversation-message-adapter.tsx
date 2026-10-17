import type { UINode, UITurn } from '@agnes/protocol'
import {
  type ClientResourceService,
  conversationCards,
  factChainLinks,
  type LocaleService,
  type SessionService,
  type SlotEntry,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import {
  conversationToolCardKind,
  keepConversationCardVisible,
} from '@agnes/web-conversation/conversation-card-layout'
import { RegisteredConversationCard } from '@agnes/web-conversation/conversation-registry'
import { DefaultToolCards } from '@agnes/web-conversation/default-tool-cards'
import { toolIconReact } from '@agnes/web-conversation/tool-icon'
import { Button } from '@agnes/web-ui'
import {
  ConversationMarkdown,
  ConversationMessages,
  type ConversationMessagesProps,
  ConversationToolCard,
  ConversationTurnActions,
  interactionToolPresentation,
} from '@agnes/web-ui/conversation'
import { MessageFeedback } from '@agnes/web-units/message-feedback'
import { type ReactNode, useCallback, useSyncExternalStore } from 'react'
import type { ClaimResolver } from './client-modules/boot.js'
import { openPlugins } from './pages/plugins/route.js'
import { workflowStepRecord } from './workflow-step.js'

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
  actionsInBar = false,
}: {
  node: UINode
  native: ReactNode
  registry: SlotRegistry
  /** The turn's answer shows its action contributions in the turn's action bar instead. */
  actionsInBar?: boolean
}) {
  const name = node.kind === 'tool' ? 'tool.call.toolview' : 'conversation.chat.node'
  const entryKey = node.kind === 'tool' ? node.name : node.kind
  const childNames =
    node.kind === 'tool'
      ? (['tool.call.images', 'tool.view.cordis'] as const)
      : ([
          ...(node.kind === 'assistant' && !actionsInBar
            ? ['conversation.chat.assistant-actions' as const]
            : []),
          'conversation.chat.commandview',
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
  const readAttachment = useCallback(
    async (artifact: import('@agnes/protocol').ArtifactRef, signal: AbortSignal) => {
      signal.throwIfAborted()
      if (!resources || !sessionScope || session?.getSnapshot() !== sessionScope)
        throw new Error('attachment session unavailable')
      const resource = await resources.files.load({ laneId: 'main', artifact, signal })
      if (signal.aborted || session?.getSnapshot() !== sessionScope) {
        resource.release()
        throw new Error('attachment session changed')
      }
      return resource
    },
    [resources, sessionScope, session],
  )
  // Presentation contributions can replace native nodes with their own visible receipt.
  useSyncExternalStore(conversationCards.subscribe, conversationCards.getSnapshot)
  const folded = new Set(
    conversationCards.entries().flatMap((entry) => entry.hiddenNodeIds?.(nodes ?? [], turns ?? []) ?? []),
  )
  const shownNodeIds = folded.size
    ? (visibleNodeIds ?? (nodes ?? []).map((node) => node.id)).filter((id) => !folded.has(id))
    : visibleNodeIds
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
  // Each turn's answer: its rating and action contributions sit in that turn's one action bar.
  const answers = new Map<string, Extract<UINode, { kind: 'assistant' }>>()
  for (const turn of turns ?? []) {
    const answer = nodes?.find((node) => node.id === turn.finalAssistantId)
    if (answer?.kind === 'assistant') answers.set(answer.id, answer)
  }
  const props: ConversationMessagesProps = {
    readAttachment,
    keepNodeVisible: (node) => keepConversationCardVisible(node) || rawEchoes.has(node.id),
    t: (key, vars) => locale?.t(key, vars) ?? key,
    nodes: nodes ?? [],
    ...(turns ? { turns } : {}),
    ...(shownNodeIds ? { visibleNodeIds: shownNodeIds } : {}),
    renderTurnDeliverables: (turn) => (
      <>
        <RegisteredConversationCard
          card={{
            kind: 'conversation.turn-tail',
            data: { turn, nodes: nodes ?? [] },
          }}
          context={{ t: (key) => locale?.t(key) ?? key }}
        />
        {registry && (
          <SlotOutlet name="conversation.chat.turnTail" owner={{ turn, nodes: nodes ?? [] }} hideWhenEmpty />
        )}
      </>
    ),
    processStep: (node) => workflowStepRecord(node.text),
    renderTurnActions: (turn, finalText, settled) => {
      const answer = turn.finalAssistantId ? answers.get(turn.finalAssistantId) : undefined
      const rated =
        sessionScope &&
        session?.getSnapshot() === sessionScope &&
        settled &&
        !turn.inherited &&
        answer &&
        !answer.streaming &&
        answer.seq > 0
      return (
        <ConversationTurnActions
          key={turn.id}
          turn={turn}
          finalText={finalText}
          settled={settled}
          t={(key, vars) => locale?.t(key, vars) ?? key}
          {...(locale ? { localeTag: locale.locale } : {})}
          {...(onFork ? { onFork } : {})}
          leading={
            <RegisteredConversationCard
              card={{ kind: 'conversation.turn-actions', data: { turn, nodes: nodes ?? [] } }}
              context={{ t: (key) => locale?.t(key) ?? key }}
            />
          }
          extra={
            <>
              {rated && (
                <MessageFeedback
                  sessionId={sessionScope}
                  target={{ messageSeq: answer.seq, turn: turn.turn }}
                  openEvidence={(candidateId) => {
                    factChainLinks.open({
                      sessionId: sessionScope,
                      laneId: 'main',
                      anchor: { kind: 'authoring', candidateId },
                    })
                  }}
                  openReview={() => openPlugins('review')}
                />
              )}
              {answer && registry?.spec('conversation.chat.assistant-actions') && (
                <span className="turn-action-slot" data-agnes-dsh-children="conversation.chat.node">
                  <SlotOutlet
                    name="conversation.chat.assistant-actions"
                    props={{ owner: { node: answer, nodeId: answer.id, kind: answer.kind } }}
                    hideWhenEmpty
                  />
                </span>
              )}
            </>
          }
        />
      )
    },
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
    renderTool: (node, turnStatus) => (
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
                turnStatus={turnStatus}
                resultAppendix={rawEchoes.get(node.id)?.join('\n\n')}
                icon={toolIconReact(node.name)}
                presentation={interactionToolPresentation(node, (key, vars) => locale?.t(key, vars) ?? key)}
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
      const base = (
        <RegisteredConversationCard
          card={{ kind: 'conversation.node', data: node }}
          context={{ t: (key) => locale?.t(key) ?? key, data: native }}
          fallback={native}
        />
      )
      const factAnchor =
        node.kind === 'tool'
          ? { kind: 'tool' as const, toolUseId: node.toolUseId }
          : node.kind === 'artifact'
            ? { kind: 'artifact' as const, seq: node.seq, ref: node.ref }
            : undefined
      const content = (
        <>
          {base}
          {node.kind === 'tool' && node.review && (
            <p data-testid="tool-review-decision">
              {locale?.t(
                node.review.source === 'human-override'
                  ? 'facts.reviewHumanRule'
                  : node.review.decision === 'allow'
                    ? 'facts.reviewAllowed'
                    : node.review.decision === 'deny'
                      ? 'facts.reviewDenied'
                      : 'facts.reviewEscalated',
              )}
              : {node.review.reason}
            </p>
          )}
          {factAnchor && sessionScope && (
            <Button
              type="link"
              size="small"
              data-testid={node.kind === 'tool' ? 'tool-fact-chain' : 'artifact-fact-chain'}
              onClick={() =>
                factChainLinks.open({ sessionId: sessionScope, laneId: 'main', anchor: factAnchor })
              }
            >
              {locale?.t(node.kind === 'tool' ? 'facts.toolLink' : 'facts.artifactLink')}
            </Button>
          )}
        </>
      )
      return registry ? (
        <DshNodeLeaf
          key={node.id}
          node={node}
          native={content}
          registry={registry}
          actionsInBar={answers.has(node.id)}
        />
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
