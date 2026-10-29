/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { UITimeline } from '@agnes/protocol'
import {
  type ClientContext,
  composerCommands,
  conversationCards,
  LocaleService,
  type PresentationProvider,
  PresentationRoleRegistry,
  SessionService,
  SlotRegistry,
  workbenchPanels,
} from '@agnes/web-client'
import { renderSessionActions } from '@agnes/web-conversation/session-actions'
import { intelligentUiCatalog, renderRegion, unmountRegion } from '@agnes/web-ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
// @ts-expect-error Generated shipped ESM is exercised directly without a release build.
import * as goal from '../../package-manager/bundled-plugins/goal-ui/src/client.js'
// @ts-expect-error Generated shipped ESM is exercised directly without a release build.
import * as interaction from '../../package-manager/bundled-plugins/interaction-ui/src/client.js'
import { expectLocalizedDom } from './helpers/localized-dom.js'

it.each([
  ['goal', goal, 'goal', 'goal', 'en'],
  ['goal', goal, 'goal', 'goal', 'zh-CN'],
  ['interaction', interaction, 'intelligent-ui', 'intelligent-turn-views', 'en'],
  ['interaction', interaction, 'intelligent-ui', 'intelligent-turn-views', 'zh-CN'],
] as const)(
  'registers, yields, restores and revokes the complete %s presentation',
  async (role, official, panelId, cardId, language) => {
    const ctx = new Context(),
      slots = new SlotRegistry(ctx),
      roles = new PresentationRoleRegistry()
    const session = new SessionService(ctx)
    const previousLanguage = document.documentElement.lang
    document.documentElement.lang = language
    const locale = new LocaleService(ctx, language)
    const client = { sessions: { get: () => undefined } }
    // Services are non-enumerable just as on a real Cordis client fiber.
    const services: ClientContext = Object.create(
      null,
      Object.fromEntries(
        Object.entries({
          slots,
          session,
          locale,
          agnes: client,
          resources: {},
          composerCommands,
          conversationCards,
          workbenchPanels,
          theme: {},
          presentation: {},
          presentationRoles: {
            register: (provider: PresentationProvider) =>
              roles.register('official', {
                ...provider,
                mount: () => provider.mount(services),
              }),
          },
        }).map(([name, value]) => [name, { value }]),
      ),
    )
    if (role === 'interaction') slots.declare('conversation.view', { kind: 'list', scope: 'session' })
    const stop = official.apply(services)
    let stopReplacement: (() => void) | undefined
    const host = document.createElement('div')
    document.body.append(host)
    try {
      expect(workbenchPanels.get(panelId)).toBeDefined()
      if (role === 'goal')
        expect(
          composerCommands.get('goal')?.route({ text: '/goal pause', sessionId: 'history', busy: true }),
        ).toBe('steer')
      expect(conversationCards.get(cardId)).toBeDefined()
      if (role === 'goal') {
        // Historical node input, with no live slots, uses the public reader.
        const timeline = {
          sessionId: 'history',
          nodes: [
            {
              kind: 'slot',
              fill: {
                extId: 'agnes/goal',
                slot: 'status.line',
                payload: {
                  text: 'Paused',
                  level: 'info',
                  goal: {
                    id: 'g',
                    revision: 1,
                    phase: 'paused',
                    objective: 'Historical goal',
                    rounds: 1,
                    maxRounds: 10,
                    creditsUsed: 0,
                  },
                },
              },
            },
          ],
        } as unknown as UITimeline
        const command = vi.fn()
        flushSync(() => renderSessionActions(host, timeline, false, command, (key) => locale.t(key)))
        expect(host.querySelector('[data-testid="goal-toggle"]')).not.toBeNull()
        flushSync(() => host.querySelector<HTMLButtonElement>('[data-testid="goal-toggle"]')!.click())
        await vi.waitFor(() => expect(document.body.textContent).toContain('Historical goal'))
        flushSync(() => document.querySelector<HTMLButtonElement>('[data-testid="goal-resume"]')!.click())
        expect(command).toHaveBeenCalledWith('/goal resume')
      } else {
        const Panel = workbenchPanels.get(panelId)!.component
        flushSync(() => renderRegion(host, createElement(Panel, { context: { t: (key) => locale.t(key) } })))
        expect(host.textContent).toContain(intelligentUiCatalog[language]['ui.empty'])
      }
      expectLocalizedDom(document.body)
      stopReplacement = roles.register('replacement', {
        role,
        priority: 0,
        mount() {
          const off = workbenchPanels.register({
            id: 'replacement',
            order: 0,
            edge: 'right',
            titleKey: 'replacement',
            component: () => null,
          })
          return off
        },
      })
      expect(workbenchPanels.get(panelId)).toBeUndefined()
      if (role === 'goal') expect(composerCommands.get('goal')).toBeUndefined()
      else
        for (const id of ['question-dock', 'question-turn-actions', 'question-answer-node'])
          expect(conversationCards.get(id)).toBeUndefined()
      expect(conversationCards.get(cardId)).toBeUndefined()
      expect(slots.entriesOfSlot('conversation.view')).toHaveLength(0)
      stopReplacement()
      stopReplacement = undefined
      expect(workbenchPanels.get(panelId)).toBeDefined()
      expect(conversationCards.get(cardId)).toBeDefined()
      if (role === 'interaction') expect(slots.entriesOfSlot('conversation.view')).toHaveLength(1)
      stop()
      expect(workbenchPanels.get(panelId)).toBeUndefined()
      expect(conversationCards.get(cardId)).toBeUndefined()
      expect(slots.entriesOfSlot('conversation.view')).toHaveLength(0)
    } finally {
      stopReplacement?.()
      stop()
      unmountRegion(host)
      host.remove()
      document.documentElement.lang = previousLanguage
    }
  },
)

it.each([
  ['goal', goal, []],
  ['interaction', interaction, ['conversation.view']],
] as const)(
  'loads the shipped %s descriptor through the real Cordis client facade and revokes synchronously',
  async (role, official, allowedSlots) => {
    const {
      AgnesClientService,
      CommandService,
      clientModule,
      presentationRoles,
      revokeContributionOwner,
      ThemeService,
    } = await import('@agnes/web-client')
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    const client = { sessions: { get: () => undefined } } as never
    new AgnesClientService(ctx, client)
    new CommandService(ctx)
    new SessionService(ctx, undefined, client)
    new LocaleService(ctx, 'en')
    new ThemeService(ctx, 'light')
    const owner = `${role}-actual-fiber`
    const fiber = ctx.plugin(clientModule(official), {
      packageId: `@agnes/${role}-ui`,
      clientId: `${role}-ui`,
      presentationRoles: [role],
      revision: 'fixture',
      rowId: owner,
      allowedSlots: [...allowedSlots],
      slotCatalogVersion: 'dsh-client-slots/v1',
      binding: { owner, lifetime: 'profile', availability: 'active' },
    } as never)
    let stopReplacement: (() => void) | undefined
    try {
      await fiber
      expect(workbenchPanels.get(role === 'goal' ? 'goal' : 'intelligent-ui')).toBeDefined()
      stopReplacement = presentationRoles.register('community-fiber', {
        role,
        priority: 0,
        mount: () => () => {},
      })
      expect(workbenchPanels.get(role === 'goal' ? 'goal' : 'intelligent-ui')).toBeUndefined()
      stopReplacement()
      stopReplacement = undefined
      expect(workbenchPanels.get(role === 'goal' ? 'goal' : 'intelligent-ui')).toBeDefined()
      revokeContributionOwner(owner)
      expect(workbenchPanels.get(role === 'goal' ? 'goal' : 'intelligent-ui')).toBeUndefined()
    } finally {
      stopReplacement?.()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  },
)

it.each(['interaction-first', 'conversation-first'] as const)(
  'mounts and remounts the official conversation and interaction independently (%s)',
  async (order) => {
    const { clientModule, presentationRoles } = await import('@agnes/web-client')
    const { startClientModules } = await import('../src/client-modules/boot.js')
    const { apply: conversation } = await import(
      '../../package-manager/bundled-plugins/conversation-ui/src/presentation.js'
    )
    const host = document.createElement('div')
    document.body.append(host)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }))
    const runtime = await startClientModules({
      agnes: { sessions: { get: () => undefined } } as never,
      rosterSource: { list: async () => ({ revision: '', modules: [], statuses: [] }) },
      conversationContainer: host,
    })
    const modules = {
      conversation: { apply: conversation, roles: ['conversation', 'composer'] },
      interaction: { apply: interaction.apply, roles: ['interaction'] },
    }
    let replace: (() => void) | undefined
    try {
      for (const name of order === 'interaction-first'
        ? (['interaction', 'conversation'] as const)
        : (['conversation', 'interaction'] as const)) {
        const mod = modules[name]
        await runtime.ctx.plugin(clientModule({ apply: mod.apply }), {
          packageId: `@agnes/${name}-ui`,
          clientId: `${name}-ui`,
          revision: 'fixture',
          presentationRoles: mod.roles,
          slotCatalogVersion: 'dsh-client-slots/v1',
          binding: { owner: `ordering-${name}`, lifetime: 'profile', availability: 'active' },
        } as never)
      }
      runtime.session.setSession('history')
      await vi.waitFor(() => {
        expect(host.querySelector('#transcript-content')).not.toBeNull()
        expect(runtime.registry.entriesOfSlot('conversation.view').map((entry) => entry.id)).toEqual([
          'builtin-conversation-view',
          'builtin-intelligent-ui',
        ])
      })
      replace = presentationRoles.register('fixture-frame', {
        role: 'conversation',
        priority: 0,
        mount: () => () => {},
      })
      expect(runtime.registry.spec('conversation.view')).toBeUndefined()
      expect(workbenchPanels.get('intelligent-ui')).toBeDefined()
      replace()
      replace = undefined
      await vi.waitFor(() => {
        expect(host.querySelector('#transcript-content')).not.toBeNull()
        expect(runtime.registry.entriesOfSlot('conversation.view').map((entry) => entry.id)).toEqual([
          'builtin-conversation-view',
          'builtin-intelligent-ui',
        ])
      })
      expect(presentationRoles.resolution('conversation').effective?.packageId).toBe('@agnes/conversation-ui')
    } finally {
      replace?.()
      await runtime.dispose()
      host.remove()
      fetcher.mockRestore()
    }
  },
)
