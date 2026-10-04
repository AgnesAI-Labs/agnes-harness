/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mountRegion,
  StateLights,
  type UiLocale,
  UiLocaleProvider,
  type UiLocaleSource,
} from '../src/index.js'
import { ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog } from '../src/locales/admin.js'
import { createCatalogTranslator } from '../src/ui-locale.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

afterEach(() => {
  document.body.replaceChildren()
})

function localeSource(initial: UiLocale): UiLocaleSource & { setLocale(locale: UiLocale): void } {
  let locale = initial
  let version = 0
  const listeners = new Set<() => void>()
  const source: UiLocaleSource & { setLocale(locale: UiLocale): void } = {
    getSnapshot: () => locale,
    getVersion: () => version,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    t(key, vars) {
      return createCatalogTranslator(adminLocaleCatalog, locale)(key, vars)
    },
    bind(namespace) {
      return namespace === ADMIN_LOCALE_NAMESPACE ? (key, vars) => source.t(key, vars) : (key) => key
    },
    setLocale(next) {
      locale = next
      version += 1
      for (const listener of listeners) listener()
    },
  }
  return source
}

describe('state lights', () => {
  it('formats the accessible title in the active locale and updates when it changes', () => {
    const source = localeSource('en')
    const host = document.createElement('div')
    document.body.append(host)
    act(() => {
      mountRegion(
        host,
        createElement(
          UiLocaleProvider,
          { source },
          createElement(StateLights, {
            states: [{ label: 'State', value: 'Running', tone: 'ok' }],
          }),
        ),
      )
    })

    const state = host.querySelector('.state-light')
    expect(state?.getAttribute('title')).toBe('State: Running')
    act(() => source.setLocale('zh-CN'))
    expect(host.querySelector('.state-light')?.getAttribute('title')).toBe('State：Running')
  })

  it('updates fallback catalog text when the locale source has no matching namespace', () => {
    const locale = localeSource('en')
    locale.bind = () => (key) => key
    const host = document.createElement('div')
    document.body.append(host)
    act(() => {
      mountRegion(
        host,
        createElement(
          UiLocaleProvider,
          { source: locale },
          createElement(StateLights, {
            states: [{ label: 'State', value: 'Running', tone: 'ok' }],
          }),
        ),
      )
    })

    expect(host.querySelector('.state-light')?.getAttribute('title')).toBe('State: Running')
    act(() => locale.setLocale('zh-CN'))
    expect(host.querySelector('.state-light')?.getAttribute('title')).toBe('State：Running')
  })
})
