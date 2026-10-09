import {
  type ClientResourceService,
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import { createAntdRoot } from '@agnes/web-ui'
import { Transcript, type TranscriptHandle } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import type { ClaimResolver } from '../client-modules/boot.js'
import { createTimelineRenderer } from '../timeline.js'
import { TimelineNodeHost } from '../timeline-node-host.js'
import { type EmptyStateRegionMount, TRANSCRIPT_DEPENDENCIES, TRANSCRIPT_SLOT } from './contracts.js'

/** Render the transcript component behind a session-scoped, replaceable SlotOutlet. */
export interface TranscriptRegionMount extends EmptyStateRegionMount, TranscriptHandle {}

export function mountTranscriptRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: {
    /** Select the React host; callers that omit it retain the legacy renderer. */
    nodeHost?: 'react'
    /** XMarkdown is available only with the explicit React host probe. */
    markdownRenderer?: 'legacy' | 'xmarkdown'
    claim?: ClaimResolver
    newContentButton?: HTMLButtonElement
    onFork?: (turn: import('@agnes/protocol').UITurn) => Promise<void>
    session?: SessionService
    locale?: LocaleService
    resources?: ClientResourceService
  } = {},
): TranscriptRegionMount {
  if (!registry.spec('conversation.view'))
    registry.declare(
      'conversation.view',
      { kind: 'list', scope: 'session' },
      'web-shell',
      'conversation.session',
    )
  if (!registry.spec(TRANSCRIPT_SLOT))
    registry.declare(TRANSCRIPT_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const handle = { current: null as TranscriptHandle | null }
  const removeBuiltin = registry.register(
    {
      name: TRANSCRIPT_SLOT as string,
      id: 'builtin-transcript',
      owner: '@agnes/web-transcript',
      priority: 0,
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      },
    },
    () =>
      options.nodeHost === 'react'
        ? createElement(TimelineNodeHost, {
            ref: handle,
            registry,
            ...(options.markdownRenderer ? { markdownRenderer: options.markdownRenderer } : {}),
            ...(options.claim ? { claim: options.claim } : {}),
            ...(options.newContentButton ? { newContentButton: options.newContentButton } : {}),
            ...(options.onFork ? { onFork: options.onFork } : {}),
            ...(options.session ? { session: options.session } : {}),
            ...(options.locale ? { locale: options.locale } : {}),
            ...(options.resources ? { resources: options.resources } : {}),
          })
        : createElement(Transcript, {
            ref: handle,
            dependencies: {
              ...TRANSCRIPT_DEPENDENCIES,
              createRenderer(rendererOptions) {
                return createTimelineRenderer({
                  ...rendererOptions,
                  registry,
                  ...(options.session ? { session: options.session } : {}),
                  ...(options.locale ? { locale: options.locale } : {}),
                  ...(options.resources ? { resources: options.resources } : {}),
                })
              },
            },
            ...options,
          }),
  )
  const removeViewBuiltin = registry.register(
    {
      name: 'conversation.view',
      id: 'builtin-conversation-view',
      owner: '@agnes/web-transcript',
      priority: 0,
    },
    () => createElement(SlotOutlet, { name: TRANSCRIPT_SLOT }),
  )
  // These are child declarations of the two keyed transcript parents. The
  // declaration-only entries keep the parent/child lifecycle tied to this
  // transcript mount while their keys stay outside real node/tool keys.
  const removeChatChildren = registry.register(
    {
      name: 'conversation.chat.node',
      key: '__agnes-native-child-declarations__',
      id: 'builtin-conversation-chat-children',
      owner: '@agnes/web-transcript',
      priority: -1,
      children: {
        'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
        'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
        'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
        'conversation.message.images': { kind: 'single', scope: 'session' },
        'conversation.trajectory.images': { kind: 'single', scope: 'session' },
      },
    },
    () => null,
  )
  const removeToolChildren = registry.register(
    {
      name: 'tool.call.toolview',
      key: '__agnes-native-child-declarations__',
      id: 'builtin-tool-view-children',
      owner: '@agnes/web-transcript',
      priority: -1,
      children: {
        'tool.call.images': { kind: 'single', scope: 'session' },
        'tool.view.cordis': { kind: 'keyed', scope: 'session' },
      },
    },
    () => null,
  )
  container.replaceChildren()
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        {
          registry,
          ...(options.session ? { session: options.session } : {}),
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.resources ? { resources: options.resources } : {}),
        },
        createElement(SlotOutlet, {
          name: 'conversation.view',
          fallback: createElement(SlotOutlet, { name: TRANSCRIPT_SLOT }),
        }),
      ),
    )
  })
  let disposed = false
  return {
    render(nodes, turns, meta) {
      handle.current?.render(nodes, turns, meta)
    },
    reset() {
      handle.current?.reset()
    },
    pinToBottom() {
      handle.current?.pinToBottom()
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeToolChildren()
      removeChatChildren()
      removeViewBuiltin()
      removeBuiltin()
    },
  }
}
