import {
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import { createRegionRenderer } from '@agnes/web-ui'
import {
  Conversation,
  type ConversationChildContainers,
  type ConversationHandle,
} from '@agnes/web-units/shell'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import {
  CONVERSATION_CHILD_SLOTS,
  CONVERSATION_DSH_CHILDREN,
  CONVERSATION_HEADER_DSH_CHILDREN,
  CONVERSATION_SLOT,
  DSH_CONVERSATION_SESSION_CHILDREN,
  type EmptyStateRegionMount,
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
export function ConversationSessionHeaderBuiltin({ sessionId }: { sessionId?: string }): ReactElement {
  const owner = { sessionId: sessionId ?? '' }
  return (
    <header className={'conversation-session-header'} data-agnes-conversation-header={true}>
      <SlotOutlet name={'conversation.session.header.lineage'} props={{ owner }} hideWhenEmpty={true} />
      <SlotOutlet name={'conversation.session.header.actions'} props={{ owner }} hideWhenEmpty={true} />
      <SlotOutlet name={'conversation.session.header.utilities'} props={{ owner }} hideWhenEmpty={true} />
      <SlotOutlet name={'conversation.session.header.corner'} props={{ owner }} hideWhenEmpty={true} />
    </header>
  )
}
export function ConversationSessionBuiltin(): ReactElement {
  return <span hidden={true} data-agnes-conversation-session={true} />
}
export function mountConversationRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: ConversationRegionOptions = {},
): ConversationRegionMount {
  const ownedShell = registry.spec('root') ? undefined : mountDshShellRegion(registry)
  if (!registry.spec(CONVERSATION_SLOT))
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
    () => (
      <Conversation
        ref={handle}
        {...(options.onMount ? { onMount: options.onMount } : {})}
        {...(options.onUnmount ? { onUnmount: options.onUnmount } : {})}
        {...(options.locale
          ? {
              translate: (key: string, vars?: Record<string, string | number>) =>
                options.locale?.t(key, vars) ?? key,
            }
          : {})}
        slots={{
          session: <SlotOutlet name={'conversation.session'} hideWhenEmpty={true} />,
          sessionHeader: <SlotOutlet name={'conversation.session.header'} hideWhenEmpty={true} />,
        }}
      />
    ),
  )
  const removeSessionBuiltin = registry.register(
    {
      name: 'conversation.session',
      id: 'builtin-conversation-session',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: DSH_CONVERSATION_SESSION_CHILDREN,
    },
    () => <ConversationSessionBuiltin />,
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
    () => <SlotOutlet name={'main'} entryKey={'default'} hideWhenEmpty={true} />,
  )
  const removeHeaderBuiltin = registry.register(
    {
      name: 'conversation.session.header',
      id: 'builtin-conversation-session-header',
      owner: '@agnes/web-conversation',
      priority: 1,
      children: CONVERSATION_HEADER_DSH_CHILDREN,
    },
    ({ sessionId }: { sessionId?: string }) => (
      <ConversationSessionHeaderBuiltin {...(sessionId === undefined ? {} : { sessionId })} />
    ),
  )
  container.replaceChildren()
  const root = createRegionRenderer(container)
  flushSync(() => {
    root.render(
      <SlotsProvider registry={registry} {...(options.session ? { session: options.session } : {})}>
        <SlotOutlet name={CONVERSATION_SLOT} />
      </SlotsProvider>,
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
