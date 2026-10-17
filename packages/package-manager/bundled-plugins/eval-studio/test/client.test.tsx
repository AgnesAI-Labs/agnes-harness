/** @vitest-environment happy-dom */

import { workbenchPanels } from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'

// @ts-expect-error Shipped browser ESM is tested directly, without a release build.
import * as ui from '../src/client.js'
// @ts-expect-error Offline JavaScript SDK fixture has no TypeScript declaration.
import * as offline from '../src/offline.mjs'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  document.body.replaceChildren()
})
it('releases both registrations and private page state on disable, and rolls back partial registration', async () => {
  let count = 0,
    dispose: () => void = () => {}
  const ctx = {
    locale: { locale: 'en', register: () => () => {} },
    homeEntries: {
      register() {
        count++
        return () => {
          count--
        }
      },
    },
    effect(factory: () => () => void) {
      dispose = factory()
    },
  }
  ui.default.apply(ctx)
  expect(count).toBe(1)
  expect(workbenchPanels.get('eval-studio')).toBeDefined()
  dispose()
  expect(count).toBe(0)
  expect(workbenchPanels.get('eval-studio')).toBeUndefined()
  const off = workbenchPanels.register({
    id: 'eval-studio',
    order: 0,
    edge: 'right',
    titleKey: 'test',
    component: () => null,
  })
  try {
    expect(() => ui.default.apply(ctx)).toThrow()
    expect(count).toBe(0)
  } finally {
    off()
  }
})
it.each(['en', 'zh-CN'])(
  'renders localized evidence, accessible dynamic case picker, and persistent invalid-import feedback in %s',
  async (locale) => {
    const store = ui.createReportStore()
    const reports = await offline.demo()
    store.put('baseline', reports[0])
    store.put('candidate', reports[1])
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(createElement(ui.EvalPage, { ctx: { locale: { locale } }, store }))
      })
      expect(host.textContent).toContain(locale === 'en' ? 'Fixture effects' : 'Fixture 效果')
      expect(host.querySelector('[role="radiogroup"]')).not.toBeNull()
      expect(host.querySelector('[role="combobox"]')).not.toBeNull()
      expect(host.querySelector('textarea')?.getAttribute('aria-label')).toBe(
        locale === 'en' ? 'Report JSON' : '报告 JSON',
      )
      const button = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === (locale === 'en' ? 'Import report' : '导入报告'),
      )
      if (!button) throw new Error('Missing import button')
      await act(async () => {
        button.click()
      })
      expect(host.textContent).toContain(locale === 'en' ? 'Cannot import' : '无法导入')
      await act(async () => {
        store.clear()
      })
      expect(host.textContent).toContain(locale === 'en' ? 'No report imported' : '尚未导入报告')
    } finally {
      await act(async () => {
        root.unmount()
      })
    }
  },
)
