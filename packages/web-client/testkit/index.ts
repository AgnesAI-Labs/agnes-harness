/** Node-only author fixture. Uses the real clientModule facade; only profileCaller is replaced.
 * Use serially: the fixture owns temporary DOM globals until dispose(). */
import { Context } from '@agnes/cordis'
import { Window } from 'happy-dom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AgnesClientService,
  type ClientModule,
  type ClientProfileCaller,
  CommandService,
  clientModule,
  homeEntries,
  LocaleService,
  type ModuleIdentity,
  SessionService,
  SlotRegistry,
  ThemeService,
} from '../src/index.js'

export async function createClientPanelTestHost(
  module: ClientModule,
  identity: ModuleIdentity,
  profileCaller: ClientProfileCaller,
  locale: 'zh-CN' | 'en' = 'en',
) {
  const window = new Window()
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  const ctx = new Context()
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  const restore = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
  try {
    await ctx.plugin(SlotRegistry)
    // No session: profile pages must work without one.
    const client = { sessions: { get: () => undefined } } as never
    new AgnesClientService(ctx, client, undefined, undefined, profileCaller)
    new CommandService(ctx, async () => false)
    new SessionService(ctx, undefined, client)
    new ThemeService(ctx, 'light')
    new LocaleService(ctx, locale)
    await ctx.plugin(clientModule(module), identity)
  } catch (error) {
    await ctx.fiber.dispose()
    root.unmount()
    await window.happyDOM.close()
    restore()
    throw error
  }
  return {
    container,
    window,
    act,
    async render(id: string) {
      const page = homeEntries.get(id)
      if (!page) throw new Error(`Home entry not registered: ${id}`)
      await act(async () =>
        root.render(React.createElement(page.component, { context: { t: (key) => key } })),
      )
    },
    async dispose() {
      try {
        await act(async () => root.unmount())
        await ctx.fiber.dispose()
        await window.happyDOM.close()
      } finally {
        restore()
      }
    },
  }
}

export { React }
