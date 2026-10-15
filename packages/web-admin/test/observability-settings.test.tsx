/** @vitest-environment happy-dom */
import { SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ObservabilityPanel } from '../src/settings/observability.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.replaceChildren()
})

it('saves each OTLP change by itself: the switch, the collector after typing, headers as rows and limits in seconds', async () => {
  let settings: Record<string, unknown> = { enabled: false, redaction: 'metadata' }
  const saves: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { settings?: Record<string, unknown> }
      if (body.settings) {
        settings = body.settings
        saves.push(body.settings)
      }
      return Response.json({ settings, health: { status: 'disabled', queued: 0, dropped: 0, failures: 0 } })
    }),
  )
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () =>
    root?.render(createElement(SettingsSubpageFrame, { header: null }, createElement(ObservabilityPanel))),
  )
  await act(async () => {})
  expect(host.querySelector('[data-testid="otlp-state"]')?.textContent).toBe('Disabled')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="otlp-settings"]')?.click())
  // No save button: the switch saves at once.
  expect(host.querySelector('[data-testid="otlp-save"]')).toBeNull()
  await act(async () => host.querySelector<HTMLElement>('[data-testid="otlp-enabled"]')?.click())
  expect(saves.at(-1)).toMatchObject({ enabled: true })
  vi.useFakeTimers()
  const endpoint = host.querySelector<HTMLInputElement>('[data-testid="otlp-endpoint"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      endpoint,
      'https://c.example',
    )
    endpoint.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(saves).toHaveLength(1)
  await act(async () => vi.advanceTimersByTime(1000))
  vi.useRealTimers()
  await act(async () => {})
  expect(saves.at(-1)).toMatchObject({ enabled: true, endpoint: 'https://c.example' })
  // A header names an environment variable of the background service.
  const type = async (testId: string, text: string) =>
    act(async () => {
      const node = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(node, text)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
  await type('otlp-header-name', 'Authorization')
  await type('otlp-header-env', 'AGH_COLLECTOR_AUTH')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="otlp-header-add"]')?.click())
  expect(saves.at(-1)?.headers).toEqual({ authorization: { secretRef: 'env:AGH_COLLECTOR_AUTH' } })
  expect(host.querySelectorAll('[data-testid="otlp-header"]')).toHaveLength(1)
  // The limits are one level deeper; intervals are chosen in seconds and stored in milliseconds.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="otlp-limits"]')?.click())
  await act(async () => {
    const batch = host.querySelector<HTMLSelectElement>('[data-testid="otlp-batchMs"]')!
    batch.value = '5000'
    batch.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(saves.at(-1)).toMatchObject({ batchMs: 5000 })
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-testid="otlp-shutdown"] input[value="discard"]')?.click(),
  )
  expect(saves.at(-1)).toMatchObject({ shutdownPolicy: 'discard' })
})
