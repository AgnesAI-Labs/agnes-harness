import type { ClientContext, UiExtensionContext } from '@agnes/web-client'
import { conversationCards, homeNavigation, workbenchPanels } from '@agnes/web-client'
import { type ReactNode, useSyncExternalStore } from 'react'
import { cardCall, SessionDevices, ToolCard } from './cards.js'
import { MhsClient } from './client.js'
import { catalog, type TextKey } from './locales.js'
import { TOOL_NAMES, toolsFrom } from './model.js'
import { nativeExamples } from './native-examples.js'
import { MhsPage } from './page.js'
import type { MhsModuleContext, MhsPorts } from './ports.js'
import { profileServices } from './profile-services.js'
import { MhsProvider } from './react.js'
import { MhsStore, usedDeviceIds } from './store.js'

function supportsProfile(ctx: ClientContext): ctx is MhsModuleContext {
  if (!('profile' in ctx) || !('homeEntries' in ctx) || !('availability' in ctx)) return false
  const profile = ctx.profile as Partial<MhsModuleContext['profile']>,
    entries = ctx.homeEntries as Partial<MhsModuleContext['homeEntries']>,
    availability = ctx.availability as Partial<MhsModuleContext['availability']>
  return (
    !!profile &&
    typeof profile.services?.query === 'function' &&
    typeof profile.services?.effect === 'function' &&
    typeof profile.services?.readOperation === 'function' &&
    typeof profile.streams?.open === 'function' &&
    typeof entries?.register === 'function' &&
    typeof availability?.getSnapshot === 'function' &&
    typeof availability?.subscribe === 'function'
  )
}
/** A package adapter may inject ports while retaining the Host's scoped contribution registry. */
export function createMhsModule(ports: MhsPorts) {
  return {
    apply(ctx: MhsModuleContext) {
      if (ctx.availability.getSnapshot()?.availability !== 'active')
        throw new Error('MHS requires an active profile contribution')
      const client = new MhsClient(ports),
        store = new MhsStore(client)
      const cleanup: (() => void)[] = []
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        for (const off of cleanup.reverse()) off()
      }
      ctx.effect(() => dispose)
      try {
        cleanup.push(store.start())
        cleanup.push(ctx.locale.register('@agnes/mhs-ui', catalog))
        const openDevice = (device: string) => homeNavigation.open('mhs', { device })
        function Provider({ children }: { children: ReactNode }) {
          const locale = useSyncExternalStore(
            ctx.locale.subscribe,
            ctx.locale.getSnapshot,
            ctx.locale.getSnapshot,
          )
          return (
            <MhsProvider
              value={{
                client,
                store,
                t: (key: TextKey) => catalog[locale === 'zh-CN' ? 'zh-CN' : 'en'][key],
                openDevice,
              }}
            >
              {children}
            </MhsProvider>
          )
        }
        cleanup.push(
          ctx.homeEntries.register({
            id: 'mhs',
            placement: 'primary',
            order: 40,
            icon: 'radio',
            titleKey: 'mhs.title',
            badge: {
              subscribe: store.subscribe,
              getSnapshot: () => store.read().devices.filter((d) => d.available).length,
            },
            component: ({ context }) => (
              <Provider>
                <MhsPage selection={context.selection} />
              </Provider>
            ),
          }),
        )
        const matchesSession = (context: UiExtensionContext) =>
          !!store.read().sessionId && context.session?.sessionId === store.read().sessionId
        cleanup.push(
          workbenchPanels.register({
            id: 'mhs.devices',
            edge: 'right',
            order: 40,
            titleKey: 'mhs.devices',
            icon: 'radio',
            visibility: 'contextual',
            when: (context) => matchesSession(context) && store.read().calls.length > 0,
            count: {
              subscribe: store.subscribe,
              read: (context) => (matchesSession(context) ? usedDeviceIds(store.read().calls).size : 0),
            },
            component: () => (
              <Provider>
                <div className="mhs-root">
                  <SessionDevices />
                </div>
              </Provider>
            ),
          }),
        )
        for (const name of TOOL_NAMES)
          cleanup.push(
            ctx.slots.register(
              { name: 'tool.call.toolview', key: name, id: `mhs.${name}`, priority: 40 },
              ({ owner }: import('@agnes/web-client').DshSlotPropsFor<'tool.call.toolview'>) => {
                const call = toolsFrom([owner?.block])[0]
                return call ? (
                  <Provider>
                    <ToolCard call={call} />
                  </Provider>
                ) : null
              },
            ),
          )
        cleanup.push(
          conversationCards.register({
            id: 'mhs.tools',
            order: 40,
            matches: (card) => !!cardCall(card),
            component: ({ card, context }) => {
              const call = cardCall(card)
              return call ? (
                <Provider>
                  <ToolCard
                    call={call}
                    {...(call.callSeq !== undefined && context.session?.sessionId
                      ? {
                          onRecord: () => {
                            const sessionId = context.session?.sessionId
                            if (sessionId && call.callSeq !== undefined)
                              context.openRecord?.(sessionId, call.callSeq)
                          },
                        }
                      : {})}
                  />
                </Provider>
              ) : null
            },
          }),
        )
        cleanup.push(
          ctx.availability.subscribe(() => {
            if (ctx.availability.getSnapshot()?.availability !== 'active') dispose()
          }),
        )
      } catch (error) {
        dispose()
        throw error
      }
      return dispose
    },
  }
}
/** Standard installed-client entry. No direct WS or session fallback on unsupported Hosts. */
export function apply(ctx: ClientContext) {
  if (!supportsProfile(ctx))
    throw new Error('MHS requires profile services, authenticated streams and primary home contributions')
  return createMhsModule({
    services: profileServices(ctx.profile.services),
    streams: ctx.profile.streams,
    session: ctx.session,
    ...(ctx.profile.mhsDeveloper ? { developer: ctx.profile.mhsDeveloper } : {}),
    examples: ctx.profile.mhsExamples ?? nativeExamples(ctx),
  }).apply(ctx)
}
