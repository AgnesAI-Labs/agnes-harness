/** @vitest-environment happy-dom */
import type { DiagnosticsExportResult } from '@agnes/protocol'
import { SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DiagnosticsPanel, errorKind, groupErrors } from '../src/settings/diagnostics.js'

import { DiagnosticsRequestError, diagnosticsApi } from '../src/settings/diagnostics-api.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        settings: { enabled: true, endpoint: 'http://collector.example:4318', redaction: 'content' },
        health: { status: 'idle', queued: 0, dropped: 0, failures: 0 },
      }),
    ),
  )
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
  const host = document.createElement('form')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      createElement(
        SettingsSubpageFrame,
        { header: null },
        createElement(DiagnosticsPanel, { api, download }),
      ),
    ),
  )
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
    expect(host.querySelector('form')).toBeNull()
    // One line per error: time, message and code; its details open in place.
    const row = host.querySelector('[data-testid="diagnostics-error"]')!
    expect(row.querySelector('[data-testid="diagnostics-error-time"]')).not.toBeNull()
    expect(row.querySelector('.agnes-settings-code-chip')?.textContent).toBe('-32602')
    expect(host.querySelector('[data-testid="diagnostics-error-code"]')).toBeNull()
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-error-toggle"]')?.click(),
    )
    expect(host.querySelector('[data-testid="diagnostics-error-code"]')?.textContent).toBe('-32602')
    expect(!!host.querySelector('[data-testid="diagnostics-doctor"]')).toBe(doctorAvailable)
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-copy"]')?.click())
    expect(write).toHaveBeenCalledWith(diagnosticId)
    // OTLP is a subpage of 集成.
    expect(host.querySelector('[data-testid="otlp-state"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="otlp-settings"]')?.click())
    expect(host.querySelector<HTMLInputElement>('[data-testid="otlp-endpoint"]')?.value).toBe(
      'http://collector.example:4318',
    )
    expect(host.querySelector('[data-testid="otlp-privacy"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="otlp-worker"]')?.textContent).toContain(
      'No Worker is currently running',
    )
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="settings-subpage-back"]')?.click(),
    )
    const input = host.querySelector<HTMLInputElement>('#diagnostics-query')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, diagnosticId)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    )
    // Export says what the bundle contains first, then exports the selected error.
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-export"]')?.click(),
    )
    expect(download).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="diagnostics-export-details"]')?.textContent).toContain(
      'Review deployment metadata',
    )
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="diagnostics-export-confirm"]')?.click(),
    )
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ diagnosticId })
    expect(download).toHaveBeenCalledWith(bundle)
    if (doctorAvailable) {
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-doctor-run"]')?.click(),
      )
      const selfCheck = host.querySelector('[data-testid="diagnostics-doctor"]')
      if (!selfCheck) throw new Error('Missing self-check block')
      expect(selfCheck.querySelector('[data-testid="doctor-check-node"]')?.textContent).toBe(
        'Node.js runtimeReady',
      )
      expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ probeAccounts: false })
      await act(async () =>
        selfCheck.querySelector<HTMLButtonElement>('[data-testid="doctor-probe-accounts"]')?.click(),
      )
      expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ probeAccounts: true })
      fetcher.mockResolvedValueOnce(
        Response.json({
          checks: [{ id: 'node', status: 'warn', fixHintKey: 'doctor.fix.node' }],
          status: 'warn',
        }),
      )
      await act(async () =>
        selfCheck.querySelector<HTMLButtonElement>('[data-testid="diagnostics-doctor-run"]')?.click(),
      )
      expect(
        selfCheck
          .querySelector('[data-testid="doctor-check-node"] .agnes-settings-tag')
          ?.getAttribute('data-tone'),
      ).toBe('warn')
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-summary-copy"]')?.click(),
      )
      expect(write.mock.calls.at(-1)?.[0]).toContain('Node.js runtime: Needs attention')
      expect(write.mock.calls.at(-1)?.[0]).not.toContain(diagnosticId)

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

it('groups repeats into one row with a count, and sorts errors into the filter kinds', () => {
  const at = '2026-10-08T00:00:00Z'
  const record = (id: string, name: string, cause?: string) => ({
    diagnosticId: `${id.repeat(8)}-1111-4111-8111-111111111111`,
    at,
    code: -32000,
    name,
    ...(cause ? { cause } : {}),
  })
  const groups = groupErrors([
    record('a', 'E_POLICY'),
    record('b', 'E_CAPABILITY'),
    record('c', 'E_CAPABILITY'),
  ])
  expect(groups.map((group) => [group.latest.name, group.count])).toEqual([
    ['E_CAPABILITY', 2],
    ['E_POLICY', 1],
  ])
  expect(groups[0]?.latest.diagnosticId.startsWith('cccccccc')).toBe(true)
  expect(errorKind(record('a', 'E_POLICY'))).toBe('permission')
  expect(errorKind(record('a', 'PROVIDER_UNAVAILABLE'))).toBe('provider')
  expect(errorKind(record('a', 'PLUGIN_LOAD'))).toBe('plugin')
  expect(errorKind(record('a', 'INVALID_PARAMS'))).toBe('all')
})
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        settings: { enabled: false },
        health: { status: 'disabled', queued: 0, dropped: 0, failures: 0 },
      }),
    ),
  )
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
  expect(idle.querySelector('[data-testid="diagnostics-worker"]')?.textContent).toContain(
    'No Worker is currently running',
  )
  expect(idle.querySelector('[data-testid="otlp-state"]')?.textContent).toContain('Disabled')
})
