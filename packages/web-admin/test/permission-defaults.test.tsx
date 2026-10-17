/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PermissionDefaults } from '../src/settings/permission-defaults.js'

import { securityUxCatalog } from '../src/settings/security-locale.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => document.body.replaceChildren())

it.each([false, true])(
  'saves revision-aware defaults, confirms full access and respects read-only=%s',
  async (readOnly) => {
    let snapshot = {
      revision: 4,
      defaults: {
        preset: 'workspace-write',
        providers: {
          loop: { provider: 'default-loop', version: '1.0.0' },
          'model-adapter': { provider: 'default-model', version: '1.0.0' },
        },
        model: 'test',
      },
    }
    const writes: unknown[] = []
    const notified = vi.fn()
    window.addEventListener('agnes:session-configuration-changed', notified)
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/context'))
        return Response.json({
          profile: 'local-dev',
          clientId: 'fixture',
          authScope: 'auth.fixture',
          permissions: ['packages.read', 'packages.activate'],
          readOnly,
        })
      if (String(url).endsWith('/composition')) return Response.json({ preset: 'workspace-write' })
      if (init?.method === 'PUT') {
        const input = JSON.parse(String(init.body))
        writes.push(input)
        snapshot = { revision: snapshot.revision + 1, defaults: input.defaults }
        return Response.json(snapshot)
      }
      return Response.json(snapshot)
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          createElement(PermissionDefaults, {
            available: ['read-only', 'workspace-write', 'full-access'],
            fetcher,
          }),
        ),
      )
      const pick = (id: string) =>
        host.querySelector<HTMLInputElement>(`[data-testid="security-${id}"] input`)!
      expect(pick('workspace-write').checked).toBe(true)
      expect(pick('read-only').disabled).toBe(readOnly)
      await act(async () => pick('read-only').click())
      if (readOnly) {
        expect(writes).toEqual([])
        expect(notified).not.toHaveBeenCalled()
        return
      }
      expect(writes).toEqual([{ revision: 4, defaults: { ...snapshot.defaults, preset: 'read-only' } }])
      expect(pick('read-only').checked).toBe(true)
      await act(async () => pick('full-access').click())
      expect(writes).toHaveLength(1)
      expect(pick('full-access').checked).toBe(false)
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-testid="security-full-confirm"]')?.click(),
      )
      expect(writes[1]).toEqual({
        revision: 5,
        defaults: {
          preset: 'full-access',
          providers: {
            loop: { provider: 'default-loop', version: '1.0.0' },
            'model-adapter': { provider: 'default-model', version: '1.0.0' },
          },
          model: 'test',
        },
      })
      expect(pick('full-access').checked).toBe(true)
      expect(notified).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener('agnes:session-configuration-changed', notified)
      await act(async () => root.unmount())
    }
  },
)

it.each(['en', 'zh-CN'] as const)('describes default permission boundaries in %s', (locale) => {
  const copy = securityUxCatalog[locale]
  expect(copy?.['read-onlyHelp']).toContain(locale === 'en' ? 'public webpages' : '公开网页')
  expect(copy?.['workspace-writeHelp']).toContain(locale === 'en' ? 'commands need approval' : '命令需审批')
  expect(copy?.['full-accessHelp']).toContain(
    locale === 'en' ? 'installation trust confirmations' : '安装信任确认',
  )
})
