/** Node-only author fixture. Uses the real clientModule facade; only profileCaller is replaced.
 * Use serially: the fixture owns temporary DOM globals until dispose(). */

import { MessageChannel } from 'node:worker_threads'
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
  // Bundled React cannot use module.require('timers') and act() falls back to MessageChannel.
  // Native Node ports keep the test worker alive even after the DOM and React root are closed.
  const channels = new Set<MessageChannel>()
  class ScopedMessageChannel extends MessageChannel {
    constructor() {
      super()
      channels.add(this)
    }
  }
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    SVGElement: window.SVGElement,
    ShadowRoot: window.ShadowRoot,
    getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    MessageChannel: ScopedMessageChannel,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  const ctx = new Context()
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  const restore = () => {
    for (const channel of channels) {
      channel.port1.close()
      channel.port2.close()
    }
    channels.clear()
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
    try {
      await ctx.fiber.dispose()
      await act(async () => root.unmount())
      await window.happyDOM.close()
    } finally {
      restore()
    }
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
        try {
          await act(async () => root.unmount())
        } finally {
          try {
            await ctx.fiber.dispose()
          } finally {
            await window.happyDOM.close()
          }
        }
      } finally {
        restore()
      }
    },
  }
}

export { React }
