/** @vitest-environment happy-dom */
import type { DiagnosticsExportResult } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DiagnosticsPanel } from '../src/settings/diagnostics.js'

import { DiagnosticsRequestError, diagnosticsApi } from '../src/settings/diagnostics-api.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
const diagnosticId = '11111111-1111-4111-8111-111111111111'
const bundle: DiagnosticsExportResult = {
  schemaVersion: 1,
  collectedAt: '2026-10-08T00:00:00Z',
  agh: { version: 'test' },
  runtime: { platform: 'test', arch: 'test', osRelease: 'test', node: '24', pid: 1, uptimeMs: 0 },
  profile: { hash: 'a'.repeat(64) },
  generations: {
    available: true,
    current: 'b'.repeat(64),
    items: [{ idHash: 'b'.repeat(64), state: 'active', boundSessions: 2 }],
  },
  doctor: [{ name: 'worker', status: 'ok' }],
  errors: [{ diagnosticId, at: '2026-10-08T00:00:00Z', code: -32602, name: 'INVALID_PARAMS' }],
  audit: [],
  limits: { audit: 100, errors: 4096 },
  telemetry: { enabled: true, includeContent: true, endpointHosts: ['collector.example:4318'] },
}
async function mount(api: ReturnType<typeof diagnosticsApi>, download = vi.fn()) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(createElement(DiagnosticsPanel, { api, download })))
  return host
}
it.each([false, true])(
  'filters and copies real IDs, exports the selected redacted DTO, and feature detects self-check (%s)',
  async (doctorAvailable) => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/doctor'))
        return Response.json({
          checks: [{ id: 'node', status: 'ok', fixHintKey: 'doctor.fix.node' }],
          status: 'ok',
        })
      return Response.json(init?.method ? bundle : { bundle, doctorAvailable })
    })
    const download = vi.fn()
    const host = await mount(diagnosticsApi(fetcher), download)
    expect(host.textContent).toContain('collector.example:4318')
    const errorCode = host.querySelector('[data-testid="diagnostics-error-code"]')!
    expect(errorCode.textContent).toBe('-32602')
    expect(errorCode.closest<HTMLDetailsElement>('details')?.open).toBe(false)
    expect(host.querySelector('[data-testid="diagnostics-content-warning"]')).not.toBeNull()
    expect(host.querySelector<HTMLDetailsElement>('[data-testid="diagnostics-runtime-details"]')?.open).toBe(
      false,
    )
    expect(!!host.querySelector('[data-testid="diagnostics-doctor"]')).toBe(doctorAvailable)
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-copy"]')?.click())
    expect(write).toHaveBeenCalledWith(diagnosticId)
    const input = host.querySelector<HTMLInputElement>('#diagnostics-query')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, diagnosticId)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-export"]')?.click(),
    )
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ diagnosticId })
    expect(download).toHaveBeenCalledWith(bundle)
    if (doctorAvailable) {
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-doctor-run"]')?.click(),
      )
      const selfCheck = host.querySelector('[data-testid="diagnostics-doctor"]')
      if (!selfCheck) throw new Error('Missing self-check block')
      expect(host.querySelector('.agnes-settings-card')).toBe(selfCheck)
      expect(selfCheck.querySelector('[data-testid="doctor-check-node"]')?.textContent).toBe(
        'Node.js runtimeReady',
      )
      expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ probeAccounts: false })
      await act(async () =>
        selfCheck.querySelector<HTMLButtonElement>('[data-testid="doctor-probe-accounts"]')?.click(),
      )
      expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ probeAccounts: true })
      fetcher.mockResolvedValueOnce(
        Response.json(
          { error: { data: { messageKey: 'appServer.errors.forbidden' }, message: 'private error' } },
          { status: 403 },
        ),
      )
      await act(async () =>
        selfCheck.querySelector<HTMLButtonElement>('[data-testid="diagnostics-doctor-run"]')?.click(),
      )
      expect(selfCheck.querySelector('[role="alert"]')?.textContent).toBe(
        'You do not have permission for this operation.',
      )
    }
  },
)
it('renders safe translated failures, rejects invalid DTOs, and cancels an unmounted read', async () => {
  const api = diagnosticsApi(async () =>
    Response.json(
      {
        error: { message: 'private stack and password', data: { messageKey: 'appServer.errors.forbidden' } },
      },
      { status: 403 },
    ),
  )
  const host = await mount(api)
  expect(host.querySelector('[data-testid="diagnostics-failure"]')?.textContent).not.toContain('private')
  expect(host.querySelector('[data-testid="diagnostics-failure"]')).not.toBeNull()
  await expect(
    diagnosticsApi(async () => Response.json({ ...bundle, password: 'secret' })).export(),
  ).rejects.toBeInstanceOf(DiagnosticsRequestError)
  let signal: AbortSignal | undefined
  await mount(
    diagnosticsApi(async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }),
  )
  await act(async () => roots.pop()?.unmount())
  expect(signal?.aborted).toBe(true)
  const idle = await mount(
    diagnosticsApi(async () =>
      Response.json({
        bundle: {
          ...bundle,
          doctor: [],
          generations: {
            ...bundle.generations,
            items: [{ ...bundle.generations.items[0]!, boundSessions: 0 }],
          },
          telemetry: { enabled: false, includeContent: false, endpointHosts: [] },
        },
        doctorAvailable: false,
      }),
    ),
  )
  expect(idle.querySelector('[data-testid="diagnostics-runtime"]')?.textContent).toContain(
    'No Worker is currently running',
  )
  expect(idle.querySelector('[data-testid="diagnostics-endpoint"]')?.textContent).toBe('Not configured')
})
