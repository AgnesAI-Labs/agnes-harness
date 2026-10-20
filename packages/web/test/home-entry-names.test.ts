/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import {
  applicationIdentity,
  homeEntries,
  homeNavigation,
  reserveHomeEntry,
  resolveHomeEntry,
} from '@agnes/web-client'
import { fireEvent, waitFor } from '@testing-library/dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openApplicationHome } from '../src/application.js'
import { createReconciler, type ReadyClientModule } from '../src/client-modules/reconcile.js'
import { deferHomePage } from '../src/pages/deferred.js'
import { registerBuiltinHomeEntries } from '../src/pages/entries.js'
import { activeHomeEntry } from '../src/pages/host.js'
import { HomeEntriesNav } from '../src/regions/home-entries.js'
import { enT, zhLocaleService, zhT } from './helpers/locale.js'

vi.mock('../src/pages/admin-api.js', () => ({
  homeAdmin: async () => ({ api: { candidatesList: async () => ({ candidates: [] }) } }),
}))

describe('home entry names', () => {
  let dispose: (() => void) | undefined
  afterEach(() => {
    homeNavigation.close()
    applicationIdentity.set(undefined)
    dispose?.()
    dispose = undefined
  })

  it('names the agents page in both languages without a secondary category', () => {
    expect(enT('home.entry.agents')).toBe('Agents')
    expect(zhT('home.entry.agents')).toBe('智能体')
    dispose = registerBuiltinHomeEntries()
    expect(homeEntries.get('agents')?.subtitleKey).toBeUndefined()
  })
  it('shows only the adopted application in primary navigation while keeping both installed pages reachable', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const builtins = registerBuiltinHomeEntries()
    const entry = (id: string) => ({
      id,
      titleKey: id,
      icon: 'file',
      order: 40,
      placement: 'primary' as const,
      component: () => null,
    })
    const cleanups = [
      builtins,
      reserveHomeEntry('one', entry('one-home'), 'acme/one'),
      reserveHomeEntry('two', entry('two-home'), 'acme/two'),
      reserveHomeEntry('ordinary', entry('ordinary'), 'acme/tool'),
    ]
    const host = document.body.appendChild(document.createElement('div')),
      root = createRoot(host)
    const candidates = ['one', 'two'].map((id) => ({
      packageId: `acme/${id}`,
      applicationId: id,
      version: '1.0.0',
      available: true,
    }))
    const adopt = (id: string | undefined) =>
      applicationIdentity.set({
        revision: 1,
        candidates,
        assets: {},
        status: id ? 'active' : 'host',
        selection: id
          ? {
              packageId: `acme/${id}`,
              applicationId: id,
              integrity: 'v1',
              declarationDigest: 'a'.repeat(64),
              consentDigest: 'b'.repeat(64),
              bindingDigest: 'c'.repeat(64),
            }
          : null,
        effective: id ? { id, presentation: { navigation: { entries: [`acme/${id}#${id}-home`] } } } : null,
      })
    try {
      await act(async () => {
        adopt('two')
        root.render(createElement(HomeEntriesNav, { t: enT }))
      })
      expect(host.querySelector('[data-testid="home-entry-two-home"]')).toBeTruthy()
      expect(host.querySelector('[data-testid="home-entry-one-home"]')).toBeNull()
      expect(host.querySelector('[data-testid="home-entry-ordinary"]')).toBeTruthy()
      expect(resolveHomeEntry('acme/one#one-home')).toBeTruthy()
      homeNavigation.openRef('acme/one#one-home')
      expect(activeHomeEntry()?.id).toBe('one-home')
      await act(async () => adopt('one'))
      expect(host.querySelector('[data-testid="home-entry-one-home"]')).toBeTruthy()
      expect(host.querySelector('[data-testid="home-entry-two-home"]')).toBeNull()
      await act(async () => adopt(undefined))
      expect(host.querySelector('[data-testid="home-entry-one-home"]')).toBeNull()
      expect(host.querySelector('[data-testid="home-entry-two-home"]')).toBeNull()
      expect(host.querySelector('[data-testid="home-entry-plugins"]')).toBeTruthy()
      expect(host.querySelector('[data-testid="home-entry-agents"]')).toBeTruthy()
    } finally {
      await act(async () => {
        root.unmount()
        for (const off of cleanups.reverse()) off()
      })
      host.remove()
    }
  })
  it('loads a selected page and forwards the current context after it becomes available', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    let ready: ((value: { default: import('@agnes/web-client').HomeEntry['component'] }) => void) | undefined
    const Page = deferHomePage(
      () =>
        new Promise((resolve) => {
          ready = resolve
        }),
    )
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    try {
      expect(ready).toBeUndefined()
      await act(async () => root.render(createElement(Page, { context: { t: enT, data: {} } })))
      expect(host.textContent).toBe('')
      await act(async () =>
        ready?.({ default: ({ context }) => createElement('p', null, context.t('home.entry.plugins')) }),
      )
      expect(host.textContent).toBe(enT('home.entry.plugins'))
      await act(async () => root.render(createElement(Page, { context: { t: zhT, data: {} } })))
      expect(host.textContent).toBe(zhT('home.entry.plugins'))
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
  it.each(['en', 'zh-CN'] as const)(
    'renders declared primary navigation beside built-ins before loading code in %s',
    async (language) => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
      const ctx = new Context(),
        locale = zhLocaleService(ctx)
      locale.setLocale(language)
      const importer = vi.fn(async () => {
        throw new Error('must remain lazy')
      })
      const module: ReadyClientModule = {
        packageId: 'acme/console',
        rowId: 'web:acme/console',
        revision: 'v1',
        entryUrl: '/console.js',
        styleUrls: [],
        slots: [],
        extIds: [],
        binding: {
          owner: 'web:acme/console',
          packageId: 'acme/console',
          integrity: 'v1',
          profileId: 'test',
          activationId: 'current',
          lifetime: 'profile',
          availability: 'active',
        },
        homeEntries: [
          {
            id: 'console',
            placement: 'primary',
            navigation: { title: 'Console', titles: { 'zh-CN': '控制台' }, icon: 'not-declared', order: 40 },
          },
        ],
      }
      let modules = [module]
      const reconciler = createReconciler({
        ctx,
        locale,
        importer,
        source: { list: async () => ({ revision: 'v1', modules, statuses: [] }) },
      })
      dispose = registerBuiltinHomeEntries()
      const host = document.body.appendChild(document.createElement('div')),
        root = createRoot(host)
      try {
        await act(async () => {
          await reconciler.reconcileNow()
          root.render(createElement(HomeEntriesNav, { t: (key, vars) => locale.t(key, vars) }))
        })
        for (const id of ['plugins', 'agents', 'automation', 'console'])
          expect(host.querySelector(`[data-testid="home-entry-${id}"]`)).toBeTruthy()
        expect(host.querySelector('[data-testid="home-entry-console"]')?.textContent).toBe(
          language === 'zh-CN' ? '控制台' : 'Console',
        )
        expect(host.querySelector('[data-testid="home-entry-console"] svg')?.innerHTML).toContain('M14 2v5')
        expect(importer).not.toHaveBeenCalled()
        await act(async () => {
          applicationIdentity.set({
            revision: 1,
            selection: null,
            status: 'active',
            assets: {},
            candidates: [],
            effective: {
              id: 'console',
              presentation: {
                navigation: {
                  entries: ['acme/console#console'],
                  hideBuiltin: ['plugins'],
                },
              },
            },
          })
        })
        expect(
          [...host.querySelectorAll('[data-testid^="home-entry-"]')].map((node) =>
            node.getAttribute('data-testid'),
          ),
        ).toEqual(['home-entry-console', 'home-entry-agents', 'home-entry-automation'])
        expect(host.querySelector('[data-testid="home-entry-plugins"]')).toBeNull()
        await act(async () => applicationIdentity.set(undefined))
        expect(
          [...host.querySelectorAll('[data-testid^="home-entry-"]')].map((node) =>
            node.getAttribute('data-testid'),
          ),
        ).toEqual(['home-entry-plugins', 'home-entry-agents', 'home-entry-automation', 'home-entry-console'])
        modules = []
        await act(async () => {
          await reconciler.invalidate()
        })
        expect(host.querySelector('[data-testid="home-entry-console"]')).toBeNull()
        modules = [module]
        await act(async () => {
          await reconciler.invalidate()
        })
        expect(host.querySelector('[data-testid="home-entry-console"]')).toBeTruthy()
        expect(importer).not.toHaveBeenCalled()
        await act(async () => {
          applicationIdentity.set({
            revision: 1,
            status: 'active',
            selection: null,
            candidates: [],
            assets: {},
            effective: {
              id: 'a',
              presentation: {
                home: 'acme/console#console',
                navigation: { entries: ['acme/console#console'] },
              },
            },
          })
          openApplicationHome()
        })
        expect(homeNavigation.getSnapshot()?.pageRef).toBe('acme/console#console')
        await waitFor(() => expect(reconciler.snapshot().get('web:acme/console')?.phase).toBe('failed'))
        expect(resolveHomeEntry('acme/console#console')).toBeUndefined()
        const foreign = () => null
        const removeForeign = reserveHomeEntry(
          'foreign',
          { id: 'console', placement: 'primary', titleKey: 'B', icon: 'cpu', order: 40, component: foreign },
          'b',
        )
        try {
          expect(homeEntries.get('console')?.component).toBe(foreign)
          expect(activeHomeEntry()).toBeUndefined()
          await waitFor(() =>
            expect(host.querySelector('[data-testid^="home-entry-"]')?.getAttribute('data-testid')).toBe(
              'home-entry-plugins',
            ),
          )
          const ordinary = host.querySelector('[data-testid="home-entry-console"]')
          expect(ordinary?.getAttribute('aria-current')).toBeNull()
          if (!ordinary) throw new Error('ordinary page missing')
          await act(async () => {
            fireEvent.click(ordinary)
          })
          expect(homeNavigation.getSnapshot()?.pageRef).toBeUndefined()
          expect(activeHomeEntry()?.component).toBe(foreign)
          homeNavigation.close()
          openApplicationHome()
          expect(homeNavigation.getSnapshot()).toBeUndefined()
          expect(resolveHomeEntry('b#console')?.component).toBe(foreign)
        } finally {
          removeForeign()
        }
      } finally {
        await act(async () => {
          root.unmount()
          await ctx.fiber.dispose()
        })
        host.remove()
      }
    },
  )
})
