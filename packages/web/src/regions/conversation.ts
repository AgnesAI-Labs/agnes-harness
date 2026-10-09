import {
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import { createAntdRoot } from '@agnes/web-ui'
import { Conversation, type ConversationChildContainers, type ConversationHandle } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import {
  type EmptyStateRegionMount,
  CONVERSATION_SLOT,
  CONVERSATION_DSH_CHILDREN,
  DSH_CONVERSATION_SESSION_CHILDREN,
  CONVERSATION_CHILD_SLOTS,
  CONVERSATION_HEADER_DSH_CHILDREN,
} from './contracts.js'
import { mountDshShellRegion } from './shell.js'

/** Make the conversation shell a session-scoped replacement boundary before mounting its children. */
export interface ConversationRegionOptions {
  session?: SessionService
  locale?: LocaleService
  onMount?(children: ConversationChildContainers): void
  onUnmount?(): void
}

export interface ConversationRegionMount extends EmptyStateRegionMount, ConversationHandle {}

export function ConversationSessionHeaderBuiltin({
  sessionId,
}: {
  sessionId?: string
}): ReturnType<typeof createElement> {
  const owner = { sessionId: sessionId ?? '' }
  return createElement(
    'header',
    { className: 'conversation-session-header', 'data-agnes-conversation-header': true },
    createElement(SlotOutlet, {
      name: 'conversation.session.header.lineage',
      props: { owner },
      hideWhenEmpty: true,
    }),
    createElement(SlotOutlet, {
      name: 'conversation.session.header.actions',
      props: { owner },
      hideWhenEmpty: true,
    }),
    createElement(SlotOutlet, {
      name: 'conversation.session.header.utilities',
      props: { owner },
      hideWhenEmpty: true,
    }),
    createElement(SlotOutlet, {
      name: 'conversation.session.header.corner',
      props: { owner },
      hideWhenEmpty: true,
    }),
  )
}

export function ConversationSessionBuiltin(): ReturnType<typeof createElement> {
  return createElement('span', {
    hidden: true,
    'data-agnes-conversation-session': true,
  })
}

export function mountConversationRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: ConversationRegionOptions = {},
): ConversationRegionMount {
  const ownedShell = registry.spec('root') ? undefined : mountDshShellRegion(registry)
  registry.declare(CONVERSATION_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const handle = { current: null as ConversationHandle | null }
  const removeMainConversationBuiltin = registry.register(
    {
      name: 'main.conversation',
      id: 'builtin-dsh-main-conversation',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: CONVERSATION_DSH_CHILDREN,
    },
    () =>
      createElement(Conversation, {
        ref: handle,
        ...(options.onMount ? { onMount: options.onMount } : {}),
        ...(options.onUnmount ? { onUnmount: options.onUnmount } : {}),
        ...(options.locale
          ? {
              translate: (key: string, vars?: Record<string, string | number>) =>
                options.locale?.t(key, vars) ?? key,
            }
          : {}),
        slots: {
          session: createElement(SlotOutlet, { name: 'conversation.session', hideWhenEmpty: true }),
          sessionHeader: createElement(SlotOutlet, {
            name: 'conversation.session.header',
            hideWhenEmpty: true,
          }),
        },
      }),
  )
  const removeSessionBuiltin = registry.register(
    {
      name: 'conversation.session',
      id: 'builtin-conversation-session',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: DSH_CONVERSATION_SESSION_CHILDREN,
    },
    () => createElement(ConversationSessionBuiltin),
  )
  const removeBuiltin = registry.register(
    {
      name: CONVERSATION_SLOT as string,
      id: 'builtin-conversation',
      owner: '@agnes/web-conversation',
      priority: 0,
      children: {
        [CONVERSATION_CHILD_SLOTS.messageActions]: { kind: 'list', scope: 'session-maybe' },
        [CONVERSATION_CHILD_SLOTS.attachments]: { kind: 'list', scope: 'session-maybe' },
        [CONVERSATION_CHILD_SLOTS.toolCard]: { kind: 'list', scope: 'session-maybe' },
        [CONVERSATION_CHILD_SLOTS.feedback]: { kind: 'list', scope: 'session-maybe' },
      },
    },
    () => createElement(SlotOutlet, { name: 'main', entryKey: 'default', hideWhenEmpty: true }),
  )
  const removeHeaderBuiltin = registry.register(
    {
      name: 'conversation.session.header',
      id: 'builtin-conversation-session-header',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: CONVERSATION_HEADER_DSH_CHILDREN,
    },
    ({ sessionId }: { sessionId?: string }) =>
      createElement(ConversationSessionHeaderBuiltin, {
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
  )
  container.replaceChildren()
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        { registry, ...(options.session ? { session: options.session } : {}) },
        createElement(SlotOutlet, { name: CONVERSATION_SLOT }),
      ),
    )
  })
  let disposed = false
  return {
    setEmptyStateVisible(visible) {
      handle.current?.setEmptyStateVisible(visible)
    },
    isTranscriptNearBottom() {
      return handle.current?.isTranscriptNearBottom() ?? false
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeHeaderBuiltin()
      removeSessionBuiltin()
      removeMainConversationBuiltin()
      removeBuiltin()
      ownedShell?.dispose()
    },
  }
}
