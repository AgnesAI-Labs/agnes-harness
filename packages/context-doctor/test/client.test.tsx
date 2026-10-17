/** @vitest-environment happy-dom */
import { type ClientContext, workbenchPanels } from '@agnes/web-client'
import { createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client.js'
import { catalog } from '../src/locales.mjs'

it.each(['en', 'zh-CN'] as const)(
  'renders readable failure/retry, unknowns and keyboard navigation; cleans up (%s)',
  async (lang) => {
    document.documentElement.lang = lang
    const locale = createDocumentLocaleSource({ 'context-doctor': catalog })
    const listeners = new Set<() => void>()
    const projections = new Set<() => void>()
    const subscribe = (set: Set<() => void>) => (listener: () => void) => {
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    }
    let id = 'selected'
    let failed = true
    const releaseLocale = vi.fn()
    const call = vi.fn(async (_name: string, _input: Record<string, unknown>) => {
      if (failed) throw new Error('/private/backend/error')
      return { version: 1, status: 'live', snapshot: { request: { toolNamesCount: 9876 } } }
    })
    const stop = apply({
      agnes: { services: { call } },
      session: {
        subscribe: subscribe(listeners),
        getSnapshot: () => id,
        projection: { subscribe: subscribe(projections) },
      },
      locale: { register: () => releaseLocale },
    } as unknown as ClientContext)
    const panel = workbenchPanels.get('context-doctor')
    if (!panel) throw new Error('Panel missing')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      flushSync(() =>
        root.render(
          createElement(
            UiLocaleProvider,
            { source: locale.source },
            createElement(panel.component, { context: { t: (key) => key } }),
          ),
        ),
      )
      await vi.waitFor(() =>
        expect(host.querySelector('[role="alert"]')?.textContent).toBe(catalog[lang].failed),
      )
      expect(host.textContent).not.toContain('/private')
      failed = false
      const refresh = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === catalog[lang].refresh,
      )
      if (!refresh) throw new Error('Refresh missing')
      flushSync(() => refresh.click())
      await vi.waitFor(() => expect(host.textContent).toContain('9876'))
      expect(host.textContent).toContain(catalog[lang].unknown)
      const choices = host.querySelectorAll<HTMLInputElement>('input[type="radio"]')
      expect(choices.length).toBe(2)
      choices[0]?.focus()
      flushSync(() =>
        choices[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
      )
      expect(choices[1]?.checked).toBe(true)
      expect(host.textContent).toContain(catalog[lang].retention)
      // Session switch clears prior values synchronously and a missing backend has a readable failure.
      failed = true
      id = 'other'
      flushSync(() => {
        for (const listener of listeners) listener()
      })
      expect(host.textContent).not.toContain('9876')
      await vi.waitFor(() =>
        expect(host.querySelector('[role="alert"]')?.textContent).toBe(catalog[lang].failed),
      )
      expect(call.mock.calls.every((args) => args.length === 2)).toBe(true)
    } finally {
      flushSync(() => root.unmount())
      stop()
      locale.dispose()
      host.remove()
    }
    expect(workbenchPanels.get('context-doctor')).toBeUndefined()
    expect(releaseLocale).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
    expect(projections.size).toBe(0)
  },
)
