/** @vitest-environment happy-dom */
import { clearResources } from '@agnes/web-ui'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsGeneralExtras } from '../src/settings/personalization.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.documentElement.lang = ''
  clearResources()
})

it.each([
  ['en', 'Upload Session Log when using model APIs', 'Help improve Agnes models and products', true, false],
  ['zh-CN', '在使用模型API时上传Session Log', '帮助改进Agnes模型与产品', true, false],
  ['en', 'Upload Session Log when using model APIs', 'Help improve Agnes models and products', false, false],
  ['zh-CN', '在使用模型API时上传Session Log', '帮助改进Agnes模型与产品', true, true],
] as const)('shows the General switch in %s', async (lang, title, description, canSave, disabledByEnv) => {
  document.documentElement.lang = lang
  const saves: unknown[] = []
  let traceUploadEnabled = true
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/telemetry') {
      const body = JSON.parse(String(init?.body))
      if (body.settings) {
        saves.push(body)
        traceUploadEnabled = body.settings.traceUploadEnabled
      }
      return Response.json({
        settings: { analyticsEnabled: false, traceUploadEnabled },
        status: { disabledByEnv, endpointConfigured: true },
      })
    }
    if (url === '/admin/plugins/api/context')
      return Response.json({
        readOnly: !canSave,
        permissions: ['packages.activate'],
        profile: 'test',
        clientId: 'web-test',
      })
    return Response.json({}, { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root?.render(<SettingsGeneralExtras />))
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="telemetry-trace-upload"]')
  if (!toggle) throw new Error('Missing Session Log switch')
  expect(toggle.getAttribute('aria-label')).toBe(title)
  expect(host.querySelector('#telemetry-trace-description')?.textContent).toBe(description)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(toggle.disabled).toBe(!canSave || disabledByEnv)
  await act(async () => toggle.click())
  if (canSave && !disabledByEnv) {
    expect(saves).toEqual([{ settings: { traceUploadEnabled: false } }])
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  } else {
    expect(saves).toEqual([])
  }
})
