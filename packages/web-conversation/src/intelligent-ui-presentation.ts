import type { ClientContext } from '@agnes/web-client'
import { mountIntelligentUi } from './intelligent-ui/mount.js'

export const inject = ['slots', 'session', 'locale', 'theme']
export function apply(ctx: ClientContext) {
  return ctx.presentationRoles.register({
    role: 'interaction',
    priority: 100,
    mount: () =>
      mountIntelligentUi({
        client: ctx.agnes,
        registry: ctx.slots,
        session: ctx.session,
        locale: ctx.locale,
        resources: ctx.resources,
        customModules: {
          theme: ctx.theme,
          list: (sessionId) => ctx.presentation.listComponents?.(sessionId) ?? Promise.resolve([]),
          subscribe: (listener) => ctx.presentation.subscribeComponents?.(listener) ?? (() => {}),
        },
        revealInline: () => ctx.presentation.revealConversation?.(),
        approval: () => ctx.presentation.focusApproval?.(),
      }),
  })
}
