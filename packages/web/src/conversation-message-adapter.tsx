import type { UINode, UITurn } from '@agnes/protocol'
import {
  type ApplicationWorkRequest,
  applicationWorkText,
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
  type TurnErrorActions,
} from '@agnes/web-ui/conversation'
import { MessageFeedback } from '@agnes/web-units/message-feedback'
import { createContext, type ReactNode, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { ClaimResolver } from './client-modules/boot.js'
import { openPlugins } from './pages/plugins/route.js'
import { ApplicationAttribution, ApplicationWorkChip } from './workbench/application-actions.js'
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
  // The teaching model echoes raw receipts, including business JSON. Keep the full echo
  // in the tool's existing disclosure instead of repeating it as an assistant answer.
  if (preceding?.kind === 'tool') return preceding
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

type TurnContributionKind = 'renderTurnActions' | 'renderTurnDeliverables'
type Presentation = Pick<ConversationMessagesProps, TurnContributionKind> & {
  answers: ReadonlyMap<string, Extract<UINode, { kind: 'assistant' }>>
}
type NodePresentation = {
  answerIds: ReadonlySet<string>
  echoIds: ReadonlySet<string>
  echoTexts: ReadonlyMap<string, readonly string[]>
  workRequests: ReadonlyMap<string, ApplicationWorkRequest>
}
const NodePresentationContext = createContext<NodePresentation | undefined>(undefined)
const PresentationContext = createContext<Presentation | undefined>(undefined)
function usePresentation(): Presentation {
  const current = useContext(PresentationContext)
  if (!current) throw new Error('Conversation presentation unavailable')
  return current
}

// Select from the current render, then retain the element below this boundary when only
// unrelated history changes. New plugin leaves never see a previous projection on mount.
function SelectedContribution<T>({
  select,
  render,
}: {
  select: (current: NodePresentation) => T
  render: (value: T) => ReactNode
}) {
  const current = useContext(NodePresentationContext)
  if (!current) throw new Error('Conversation node presentation unavailable')
  const value = select(current)
  return useMemo(() => render(value), [render, value])
}

// Answer text changes do not invalidate the native nodes' membership/echo selections.
function SelectedAnswer({
  nodeId,
  render,
}: {
  nodeId: string
  render: (serialized: string | undefined) => ReactNode
}) {
  const serialized = JSON.stringify(usePresentation().answers.get(nodeId))
  return useMemo(() => render(serialized), [render, serialized])
}

// These plugin contributions may read the entire window, so they receive every projection.
function TurnContribution({ kind, args }: { kind: TurnContributionKind; args: [UITurn, string, boolean] }) {
  const current = usePresentation()
  return kind === 'renderTurnActions'
    ? current.renderTurnActions?.(...args)
    : current.renderTurnDeliverables?.(args[0])
}

type WebConversationMessagesProps = {
  registry?: SlotRegistry
  claim?: ClaimResolver
  session?: SessionService
  locale?: LocaleService
  resources?: ClientResourceService
  nodes?: readonly UINode[]
  turns?: readonly UITurn[]
  visibleNodeIds?: readonly string[]
  onFork?: (turn: UITurn) => Promise<void>
  /** Host operations a failed turn's error row can offer; the adapter adds availability. */
  turnErrorActions?: TurnErrorActions
  /** Compatibility selector; both values now use the same React-owned Markdown. */
  markdownRenderer?: 'legacy' | 'xmarkdown'
}

export function WebConversationMessages(props: WebConversationMessagesProps) {
  const { registry } = props
  const sessionScope = useSyncExternalStore(
    registry ? registry.subscribeSession.bind(registry) : noSessionSubscription,
    () => registry?.sessionId,
  )
  return <ScopedConversationMessages key={sessionScope ?? ''} {...props} sessionScope={sessionScope} />
}

function ScopedConversationMessages({
  registry,
  claim,
  session,
  locale,
  resources,
  turns,
  nodes,
  visibleNodeIds,
  onFork,
  turnErrorActions: hostTurnErrorActions,
  sessionScope,
}: WebConversationMessagesProps & { sessionScope: string | undefined }) {
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
  const cardVersion = useSyncExternalStore(conversationCards.subscribe, conversationCards.getSnapshot)
  // Catalog replacement can change text without changing the language tag.
  const localeChanges = useMemo(() => {
    let revision = 0
    return {
      getSnapshot: () => revision,
      subscribe: (listener: () => void) =>
        locale?.subscribe(() => {
          revision++
          listener()
        }) ?? (() => undefined),
    }
  }, [locale])
  const localeVersion = useSyncExternalStore(localeChanges.subscribe, localeChanges.getSnapshot)
  const localeTag = locale?.locale
  const translate = useCallback(
    (key: string, vars?: Readonly<Record<string, string | number>>) => {
      // Both a language change and an in-place catalog update invalidate native labels.
      void localeTag
      void localeVersion
      return locale?.t(key, vars) ?? key
    },
    [locale, localeTag, localeVersion],
  )
  const folded = new Set(
    conversationCards.entries().flatMap((entry) => entry.hiddenNodeIds?.(nodes ?? [], turns ?? []) ?? []),
  )
  // A failed turn can be sent again only from a live, idle, writable session. The host supplies
  // the operations; whether they can run now is session state that is read here, where it updates.
  const readiness = useSyncExternalStore(
    session ? session.readiness.subscribe.bind(session.readiness) : noSessionSubscription,
    () => session?.readiness.getSnapshot().status,
  )
  const sessionRunning = (turns ?? []).some((turn) => turn.status === 'running' || turn.status === 'waiting')
  const retryDisabledReason = sessionRunning
    ? translate('turn.error.action.running')
    : readiness === 'connecting'
      ? translate('turn.error.action.offline')
      : undefined
  const turnErrorActions = useMemo<TurnErrorActions | undefined>(() => {
    if (!hostTurnErrorActions) return undefined
    const next: TurnErrorActions = {}
    // A retry needs a loaded session; the composer's own guards still run at send time.
    if (readiness === 'ready' && hostTurnErrorActions.onRetry) next.onRetry = hostTurnErrorActions.onRetry
    if (hostTurnErrorActions.onOpenSettings) next.onOpenSettings = hostTurnErrorActions.onOpenSettings
    if (retryDisabledReason) next.retryDisabledReason = retryDisabledReason
    if (sessionScope) next.sessionId = sessionScope
    return next
  }, [hostTurnErrorActions, readiness, retryDisabledReason, sessionScope])
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
  const answerKey = JSON.stringify([...answers.keys()])
  const answerIds = useMemo(() => new Set<string>(JSON.parse(answerKey)), [answerKey])
  const echoKey = JSON.stringify([...echoedTools.keys()])
  const rawKey = JSON.stringify([...rawEchoes])
  const echoIds = useMemo(() => new Set<string>(JSON.parse(echoKey)), [echoKey])
  const echoTexts = useMemo(() => new Map<string, string[]>(JSON.parse(rawKey)), [rawKey])
  const workRequests = new Map<string, ApplicationWorkRequest>()
  const displayNodes = (nodes ?? []).map((node) =>
    node.kind !== 'user'
      ? node
      : {
          ...node,
          content: node.content.map((block) => {
            if (block.type !== 'text') return block
            const work = applicationWorkText(block.text)
            if (work.request) workRequests.set(node.id, work.request)
            return work.request ? { ...block, text: work.text } : block
          }),
        },
  )
  const workKey = JSON.stringify([...workRequests])
  const stableWorkRequests = useMemo(
    () => new Map<string, ApplicationWorkRequest>(JSON.parse(workKey)),
    [workKey],
  )
  // Streaming changes answers and whole-window plugin inputs on every frame. Native node
  // selections change only when membership, echoes or application work requests change.
  const nodePresentation = useMemo<NodePresentation>(
    () => ({ answerIds, echoIds, echoTexts, workRequests: stableWorkRequests }),
    [answerIds, echoIds, echoTexts, stableWorkRequests],
  )
  const nextContributions: Presentation = {
    answers,
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
    renderTurnActions: (turn) => (
      <RegisteredConversationCard
        card={{ kind: 'conversation.turn-actions', data: { turn, nodes: nodes ?? [] } }}
        context={{ t: (key) => locale?.t(key) ?? key }}
      />
    ),
  }

  const keepNodeVisible = useCallback(
    (node: UINode) => {
      // A catalog revision may change a native card's visibility without changing its node.
      void cardVersion
      return keepConversationCardVisible(node) || echoTexts.has(node.id)
    },
    [cardVersion, echoTexts],
  )
  const native = useMemo<Omit<ConversationMessagesProps, 'nodes' | 'turns' | 'visibleNodeIds'>>(() => {
    return {
      readAttachment,
      renderTurnAttribution: () => <ApplicationAttribution session={session} />,
      t: translate,
      ...(turnErrorActions ? { turnErrorActions } : {}),
      processStep: (node) => workflowStepRecord(node.text),
      renderMarkdown: (text, part, state) => (
        <SelectedContribution
          select={(current) => part === 'body' && !!state?.nodeId && current.echoIds.has(state.nodeId)}
          render={(echo) =>
            echo ? null : (
              <ConversationMarkdown
                key={`${state?.nodeId ?? ''}:${part}`}
                source={text}
                part={part}
                streaming={state?.streaming ?? false}
                t={translate}
              />
            )
          }
        />
      ),
      renderTool: (node, turnStatus) => (
        <SelectedContribution
          select={(current) => current.echoTexts.get(node.id)?.join('\n\n')}
          render={(appendix) => (
            <RegisteredConversationCard
              card={{
                kind: conversationToolCardKind(node) ?? 'tool',
                data: node,
              }}
              context={{
                t: translate,
                data: (
                  <>
                    <DefaultToolCards
                      node={node}
                      {...(locale ? { t: (key: string) => locale.t(key) } : {})}
                      {...(session ? { session } : {})}
                      {...(resources ? { resources } : {})}
                    />
                    {conversationToolCardKind(node) === 'child-agent' &&
                      !node.delegatedRole &&
                      node.resultPreview && (
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
                      resultAppendix={appendix}
                      icon={toolIconReact(node.name)}
                      presentation={interactionToolPresentation(
                        node,
                        (key, vars) => locale?.t(key, vars) ?? key,
                      )}
                      t={translate}
                    />
                  </>
                ),
              }}
            />
          )}
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
      renderNode: (node, native) => (
        <SelectedContribution
          select={(current) => current.answerIds.has(node.id)}
          render={(actionsInBar) => {
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
                {node.kind === 'user' && (
                  <SelectedContribution
                    select={(current) => current.workRequests.get(node.id)}
                    render={(request) => (request ? <ApplicationWorkChip request={request} /> : null)}
                  />
                )}
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
                actionsInBar={actionsInBar}
              />
            ) : (
              content
            )
          }}
        />
      ),
      renderTurnActions: (turn, finalText, settled) => (
        <SelectedAnswer
          nodeId={turn.finalAssistantId ?? ''}
          render={(serialized) => {
            const answer =
              serialized === undefined
                ? undefined
                : (JSON.parse(serialized) as Extract<UINode, { kind: 'assistant' }>)
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
                t={translate}
                {...(locale ? { localeTag: locale.locale } : {})}
                {...(onFork ? { onFork } : {})}
                leading={<TurnContribution kind="renderTurnActions" args={[turn, finalText, settled]} />}
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
          }}
        />
      ),
      renderTurnDeliverables: (turn) => (
        <TurnContribution kind="renderTurnDeliverables" args={[turn, '', false]} />
      ),
    }
  }, [
    readAttachment,
    translate,
    registry,
    claim,
    session,
    locale,
    resources,
    sessionScope,
    onFork,
    turnErrorActions,
  ])
  const messages = (
    <ConversationMessages
      key={sessionScope ?? ''}
      {...native}
      keepNodeVisible={keepNodeVisible}
      nodes={displayNodes}
      {...(turns ? { turns } : {})}
      {...(shownNodeIds ? { visibleNodeIds: shownNodeIds } : {})}
    />
  )
  return (
    <PresentationContext.Provider value={nextContributions}>
      <NodePresentationContext.Provider value={nodePresentation}>
        {registry ? (
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
        )}
      </NodePresentationContext.Provider>
    </PresentationContext.Provider>
  )
}
