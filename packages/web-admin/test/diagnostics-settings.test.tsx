/** @vitest-environment happy-dom */

import type { DiagnosticsExportResult } from '@agnes/protocol'
import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import { SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DiagnosticsPanel } from '../src/settings/diagnostics.js'

import { DiagnosticsRequestError, diagnosticsApi } from '../src/settings/diagnostics-api.js'
import { errorDrillId, groupErrors } from '../src/settings/diagnostics-errors.js'
import { errorKind } from '../src/settings/diagnostics-kinds.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
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
const id0 = diagnosticId
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
  limits: { audit: 100, errors: 1000 },
  telemetry: { enabled: true, includeContent: true, endpointHosts: ['collector.example:4318'] },
}
async function mount(
  api: ReturnType<typeof diagnosticsApi>,
  download = vi.fn(),
  frame: { rootTitle?: string; routeId?: string } = {},
) {
  const host = document.createElement('form')
  host.id = 'config-form'
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      createElement(
        SettingsSubpageFrame,
        { header: null, ...frame },
        createElement(DiagnosticsPanel, { api, download }),
      ),
    ),
  )
  return host
}
const click = (host: ParentNode, testId: string) =>
  act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click())
it.each([false, true])(
  'filters and copies real IDs, exports the selected redacted DTO, and feature detects self-check (%s)',
  async (doctorAvailable) => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/doctor'))
        return Response.json({
          checks: [
            { id: 'node', status: 'ok', fixHintKey: 'doctor.fix.node' },
            { id: 'accounts', status: 'ok', fixHintKey: 'doctor.fix.accounts' },
          ],
          status: 'ok',
        })
      return Response.json(init?.method ? bundle : { bundle, doctorAvailable })
    })
    const download = vi.fn()
    const host = await mount(diagnosticsApi(fetcher), download)
    expect(host.querySelector('form')).toBeNull()
    // The page holds one entry row; the kinds are listed one level down, each opening its own page.
    expect(host.querySelector('[data-testid="diagnostics-error"]')).toBeNull()
    await click(host, 'diagnostics-errors-row')
    const row = host.querySelector('[data-testid="diagnostics-error"]')!
    expect(row.querySelector('[data-testid="diagnostics-error-time"]')).not.toBeNull()
    expect(row.getAttribute('data-kind')).toBe('other')
    expect(row.textContent).toContain('Once')
    expect(host.querySelector('[data-testid="diagnostics-error-code"]')).toBeNull()
    await click(host, 'diagnostics-error')
    expect(host.querySelector('[data-testid="diagnostics-error-code"]')?.textContent).toBe('-32602')
    expect(!!host.querySelector('[data-testid="diagnostics-doctor"]')).toBe(doctorAvailable)
    const write = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue()
      .mockRejectedValueOnce(new Error('Clipboard blocked'))
    await click(host, 'diagnostics-copy')
    expect(host.querySelector('[data-testid="diagnostics-notice"]')?.textContent).toContain('Copy failed')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-notice"] button')?.click(),
    )
    expect(host.querySelector('[data-testid="diagnostics-notice"]')).toBeNull()
    expect(write).toHaveBeenCalledWith(diagnosticId)
    await click(host, 'settings-subpage-back')
    await click(host, 'settings-subpage-back')
    // OTLP is a subpage of 集成.
    expect(host.querySelector('[data-testid="otlp-state"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="otlp-settings"]')?.click())
    expect(host.querySelector<HTMLInputElement>('[data-testid="otlp-endpoint"]')?.value).toBe(
      'http://collector.example:4318',
    )
    expect(host.querySelector('[data-testid="otlp-privacy"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="otlp-worker"]')?.textContent).toContain(
      'No background worker is currently running',
    )
    await click(host, 'settings-subpage-back')
    await click(host, 'diagnostics-errors-row')
    const input = host.querySelector<HTMLInputElement>('#diagnostics-query')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'not-an-id')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, diagnosticId)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    )
    expect(host.querySelector('[data-testid="diagnostics-found"]')?.textContent).toContain('Found 1 record')
    await click(host, 'settings-subpage-back')
    await click(host, 'settings-subpage-back')
    // Export says what the bundle contains first, then exports the selected error.
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-export"]')?.click(),
    )
    expect(download).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="diagnostics-export-details"]')?.textContent).toContain(
      'Included: versions',
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
        'Node.js runtimeReady24',
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
      expect(selfCheck.querySelector('[data-testid="doctor-check-node"]')?.getAttribute('data-state')).toBe(
        'warn',
      )
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
      expect(selfCheck.querySelector('[role="alert"]')?.textContent).toContain(
        'Permission for this operation was denied. Ask an administrator to review the applicable policy before retrying.',
      )
    }
  },
)

it('groups repeats of a kind newest first, and sorts known names and causes into kinds', () => {
  const at = '2026-10-08T00:00:00Z'
  const record = (id: string, name: string) => ({
    diagnosticId: `${id.repeat(8)}-1111-4111-8111-111111111111`,
    at,
    code: -32000,
    name,
  })
  const groups = groupErrors([
    record('a', 'CLAIM_DENIED'),
    record('b', 'CAPABILITY_DENIED'),
    record('c', 'CAPABILITY_DENIED'),
  ])
  expect(groups.map((group) => [group.latest.name, group.count])).toEqual([
    ['CAPABILITY_DENIED', 2],
    ['CLAIM_DENIED', 1],
  ])
  expect(groups[0]?.latest.diagnosticId.startsWith('cccccccc')).toBe(true)
  expect(groups[0]?.first.diagnosticId.startsWith('bbbbbbbb')).toBe(true)
  expect(errorKind({ name: 'CAPABILITY_DENIED' })).toBe('permission')
  expect(errorKind({ name: 'INVALID_PARAMS', cause: 'CONFIG_CREDENTIAL_REJECTED' })).toBe('provider')
  expect(errorKind({ name: 'INTERNAL_ERROR', cause: 'E_GENERATION_SKILLS' })).toBe('plugin')
  expect(errorKind({ name: 'INVALID_PARAMS' })).toBe('other')
})
it('opens the errors and each error as pages, finds an error by ID inside its page, and falls back from a gone one', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 19, 12))
  try {
    const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
    const errors: DiagnosticsExportResult['errors'] = [
      {
        diagnosticId: id(1),
        at: new Date(2026, 9, 10, 9).toISOString(),
        code: -32602,
        name: 'INVALID_PARAMS',
      },
      {
        diagnosticId: id(2),
        at: new Date(2026, 9, 19, 9).toISOString(),
        code: -32006,
        name: 'CAPABILITY_DENIED',
      },
    ]
    const api = diagnosticsApi(async (_url, init) =>
      Response.json(
        init?.method
          ? { ...bundle, errors: [errors[0]!] }
          : { bundle: { ...bundle, errors }, doctorAvailable: false },
      ),
    )
    const route = { rootTitle: 'Runtime', routeId: 'diagnostics' }
    const host = await mount(api, vi.fn(), route)
    const header = () => host.querySelector('[data-testid="settings-subpage-header"]')?.textContent ?? ''
    const value = (testId: string) =>
      host.querySelector(`[data-testid="${testId}"] .agnes-settings-value`)?.textContent
    expect(value('diagnostics-errors-row')).toBe('Today 1 kinds · 1 times')
    expect(host.querySelector('[data-testid="diagnostics-error"]')).toBeNull()
    await click(host, 'diagnostics-errors-row')
    expect(location.search).toBe('?settings=diagnostics/errors')
    expect(header()).toContain('Runtime')
    expect(header()).toContain('Recent errors')
    expect(host.querySelector('[data-testid="settings-subpage-header"] #diagnostics-query')).not.toBeNull()
    expect(host.querySelector('[data-testid="diagnostics-errors"]')?.getAttribute('aria-busy')).toBe('false')
    const rows = [...host.querySelectorAll('[data-testid="diagnostics-error"]')]
    expect(rows).toHaveLength(2)
    const message = rows[1]!.querySelector('.agnes-settings-item-label')?.textContent ?? ''
    await act(async () => (rows[1] as HTMLButtonElement).click())
    expect(location.search).toBe(`?settings=diagnostics/errors/${errorDrillId(errors[0]!)}`)
    for (const part of ['Runtime', 'Recent errors', message]) expect(header()).toContain(part)
    expect(host.querySelector('[data-testid="diagnostics-error-id"]')?.textContent).toBe(id(1))
    expect(host.querySelector('[data-testid="diagnostics-error-code"]')?.textContent).toBe('-32602')
    expect(host.querySelector('[data-testid="diagnostics-copy"]')).not.toBeNull()
    await click(host, 'settings-subpage-back')
    expect(location.search).toBe('?settings=diagnostics/errors')
    expect(host.querySelectorAll('[data-testid="diagnostics-error"]')).toHaveLength(2)
    // A found error opens its page at once, on the found ID.
    const input = host.querySelector<HTMLInputElement>('#diagnostics-query')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, id(1))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(location.search).toBe(`?settings=diagnostics/errors/${errorDrillId(errors[0]!)}`)
    expect(host.querySelector('[data-testid="diagnostics-error-id"]')?.textContent).toBe(id(1))
    await click(host, 'settings-subpage-back')
    expect(host.querySelectorAll('[data-testid="diagnostics-error"]')).toHaveLength(1)
    expect(host.querySelector('[data-testid="diagnostics-found"]')).not.toBeNull()
    await click(host, 'diagnostics-clear')
    expect(host.querySelectorAll('[data-testid="diagnostics-error"]')).toHaveLength(2)
    // An address naming an error that is not there leaves for the list instead of an empty page.
    await act(async () => roots.pop()?.unmount())
    document.body.replaceChildren()
    history.replaceState(null, '', '?settings=diagnostics/errors/err-gone')
    const gone = await mount(api, vi.fn(), route)
    expect(gone.querySelector('[data-testid="settings-subpage-err-gone"]')).toBeNull()
    expect(gone.querySelectorAll('[data-testid="diagnostics-error"]')).toHaveLength(2)
    expect(location.search).toBe('?settings=diagnostics/errors')
    // One that is there opens.
    await act(async () => roots.pop()?.unmount())
    document.body.replaceChildren()
    history.replaceState(null, '', `?settings=diagnostics/errors/${errorDrillId(errors[1]!)}`)
    const there = await mount(api, vi.fn(), route)
    expect(there.querySelector('[data-testid="diagnostics-error-id"]')?.textContent).toBe(id(2))
  } finally {
    vi.useRealTimers()
  }
})
it('does not open a found error once the user has left the list while the lookup ran', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const api = diagnosticsApi(async (_url, init) => {
    if (!init?.method) return Response.json({ bundle, doctorAvailable: false })
    await held
    return Response.json(bundle)
  })
  const host = await mount(api, vi.fn(), { rootTitle: 'Runtime', routeId: 'diagnostics' })
  await click(host, 'diagnostics-errors-row')
  const input = host.querySelector<HTMLInputElement>('#diagnostics-query')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, diagnosticId)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await click(host, 'settings-subpage-back')
  expect(location.search).toBe('')
  await act(async () => release())
  expect(location.search).toBe('')
  expect(host.querySelector('[data-subpage]')?.getAttribute('data-subpage')).toBeUndefined()
  expect(host.querySelector('[data-testid^="settings-subpage-err-"]')).toBeNull()
  expect(host.querySelector<HTMLElement>('.agnes-settings-subpage-main')?.hidden).toBe(false)
  expect(host.querySelector('[data-testid="diagnostics-errors-row"]')).not.toBeNull()
})
it('keeps an error page open when the kind filter excludes its kind', async () => {
  const errors: DiagnosticsExportResult['errors'] = [
    { diagnosticId, at: '2026-10-08T00:00:00Z', code: -32006, name: 'CAPABILITY_DENIED' },
  ]
  const host = await mount(
    diagnosticsApi(async () => Response.json({ bundle: { ...bundle, errors }, doctorAvailable: false })),
    vi.fn(),
    { rootTitle: 'Runtime', routeId: 'diagnostics' },
  )
  await click(host, 'diagnostics-errors-row')
  await click(host, 'diagnostics-error')
  await click(host, 'settings-subpage-back')
  await act(async () =>
    host
      .querySelector<HTMLInputElement>('[data-testid="diagnostics-filter-kind"] input[value="provider"]')
      ?.click(),
  )
  expect(host.querySelector('[data-testid="diagnostics-error"]')).toBeNull()
  // The browser's forward button, or a route event, returns to the error's page.
  history.pushState(null, '', `?settings=diagnostics/errors/${errorDrillId(errors[0]!)}`)
  await act(async () => {
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  expect(host.querySelector('[data-testid="diagnostics-error-id"]')?.textContent).toBe(diagnosticId)
  expect(host.querySelector('[data-testid="settings-subpage-back"]')).not.toBeNull()
})
it('names a kind of error by an address-safe id that is stable for the kind and differs between kinds', () => {
  const base = { diagnosticId: id0, at: '2026-10-08T00:00:00Z', code: -32602, name: 'INVALID_PARAMS' }
  const same = errorDrillId({
    ...base,
    diagnosticId: '22222222-2222-4222-8222-222222222222',
    at: '2026-10-09T00:00:00Z',
  })
  expect(errorDrillId(base)).toBe(same)
  const ids = [
    base,
    { ...base, code: -32000 },
    { ...base, cause: 'CONFIG_CREDENTIAL_REJECTED' },
    { ...base, name: 'CAPABILITY_DENIED' },
    { ...base, name: 'INVALID_PARAMS\u0000', cause: 'x' },
    { ...base, name: 'Ünï/ç 错误 ?&=#%' },
  ].map(errorDrillId)
  expect(new Set(ids).size).toBe(ids.length)
  for (const value of ids) expect(value).toMatch(/^[A-Za-z0-9_-]+$/)
})
it('lists kinds by day with filters and the real limit, and says what a lookup found or missed', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 19, 12))
  try {
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString()
    const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
    const errors: DiagnosticsExportResult['errors'] = [
      {
        diagnosticId: id(1),
        at: at(18, 22),
        code: -32602,
        name: 'INVALID_PARAMS',
        cause: 'CONFIG_CREDENTIAL_REJECTED',
      },
      { diagnosticId: id(2), at: at(19, 9), code: -32006, name: 'CAPABILITY_DENIED' },
      { diagnosticId: id(3), at: at(19, 11), code: -32006, name: 'CAPABILITY_DENIED' },
    ]
    let found: DiagnosticsExportResult['errors'] = []
    let fail = false
    const host = await mount(
      diagnosticsApi(async (_url, init) => {
        if (fail)
          return Response.json(
            { error: { data: { messageKey: 'appServer.errors.forbidden' } } },
            { status: 403 },
          )
        return Response.json(
          init?.method
            ? { ...bundle, errors: found }
            : { bundle: { ...bundle, errors }, doctorAvailable: false },
        )
      }),
    )
    const text = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''
    const entry = () => text('diagnostics-errors-row')
    expect(host.querySelector('[data-testid="diagnostics-summary"]')).toBeNull()
    expect(entry()).toContain('Today 1 kinds · 2 times')
    await click(host, 'diagnostics-errors-row')
    const kinds = () =>
      [...host.querySelectorAll('[data-testid="diagnostics-error"]')].map((row) =>
        row.getAttribute('data-kind'),
      )
    expect(text('diagnostics-summary')).toContain('3 records, in 2 kinds.')
    expect(
      [...host.querySelectorAll('[data-testid="diagnostics-day"]')].map((day) => day.textContent),
    ).toEqual(['TodayOctober 19 · 1 kinds · 2 times', 'YesterdayOctober 18 · 1 kinds · 1 times'])
    expect(kinds()).toEqual(['permission', 'provider'])
    expect(text('diagnostics-error')).toContain('First')
    expect(text('diagnostics-retained')).toBe(
      'Only the latest 1,000 records are kept; older ones can no longer be found.',
    )
    const filters = host.querySelector('[data-testid="diagnostics-filter-kind"]')!
    expect(filters.textContent).toBe('All2Permissions1Providers1Plugins0Other0')
    await act(async () => filters.querySelector<HTMLInputElement>('input[value="provider"]')?.click())
    expect(kinds()).toEqual(['provider'])
    await act(async () => filters.querySelector<HTMLInputElement>('input[value="all"]')?.click())
    await click(host, 'diagnostics-error')
    expect(host.querySelectorAll('[data-testid="diagnostics-copy-occurrence"]')).toHaveLength(2)
    await click(host, 'settings-subpage-back')
    const input = host.querySelector<HTMLInputElement>('#diagnostics-query')!
    const lookup = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      )
    }
    // Not found says only that the ID is not here; clearing returns to the list.
    await lookup(id(9))
    expect(text('diagnostics-not-found')).toContain('No record with this ID')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-not-found"] button')?.click(),
    )
    expect(text('diagnostics-summary')).toContain('3 records')
    // Found opens that kind's page on the found ID; back, the list holds only that kind, counted as it counts it.
    found = [errors[1]!]
    await lookup(id(2))
    expect(text('diagnostics-error-id')).toBe(id(2))
    await click(host, 'settings-subpage-back')
    expect(kinds()).toEqual(['permission'])
    expect(text('diagnostics-error')).toContain('2 times')
    // The row still describes the kind: its latest time, not the looked-up record's.
    expect(host.querySelector('[data-testid="diagnostics-error-time"]')?.getAttribute('datetime')).toBe(
      errors[2]!.at,
    )
    expect(host.querySelector('[data-testid="diagnostics-summary"]')).toBeNull()
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-found"] button')?.click(),
    )
    expect(kinds()).toEqual(['permission', 'provider'])
    // A failed read offers a retry that reads again.
    fail = true
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-refresh"]')?.click(),
    )
    expect(text('diagnostics-failure')).toContain(
      'Permission for this operation was denied. Ask an administrator to review the applicable policy before retrying.',
    )
    expect(entry()).toContain('Could not read error records')
    fail = false
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-failure"] button')?.click(),
    )
    expect(kinds()).toEqual(['permission', 'provider'])
    errors.length = 0
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-refresh"]')?.click(),
    )
    expect(text('diagnostics-empty')).toContain('No recent errors')
    expect(entry()).toContain('No recent errors')
    // Only older errors: the entry counts kinds without naming today.
    errors.push({ diagnosticId: id(1), at: at(18, 22), code: -32602, name: 'INVALID_PARAMS' })
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-refresh"]')?.click(),
    )
    expect(
      host.querySelector('[data-testid="diagnostics-errors-row"] .agnes-settings-value')?.textContent,
    ).toBe('1 kinds')
  } finally {
    vi.useRealTimers()
  }
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
  expect(host.querySelector('[data-testid="diagnostics-errors-row"]')?.textContent).toContain(
    'Could not read error records',
  )
  await click(host, 'diagnostics-errors-row')
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
    'No background worker is currently running',
  )
  expect(idle.querySelector('[data-testid="otlp-state"]')?.textContent).toContain('Disabled')
})

const checkIds = [
  'node',
  'native',
  'home',
  'permissions',
  'credentials',
  'disk',
  'sandbox',
  'mcp',
  'connection',
  'accounts',
  'plugins',
] as const
const healthy: DoctorResult = {
  status: 'ok',
  checks: checkIds.map((id) => ({ id, status: 'ok', fixHintKey: `doctor.fix.${id}` })),
}
function healthApi(report: DoctorResult, worker = 'unavailable', service = 'ok') {
  return diagnosticsApi(async (url) =>
    Response.json(
      String(url).endsWith('/doctor')
        ? report
        : {
            bundle: {
              ...bundle,
              doctor: [
                { name: 'worker', status: worker },
                { name: 'daemon', status: service },
              ],
            },
            doctorAvailable: true,
          },
    ),
  )
}
it('groups each check once, excludes unavailable workers, and shows only supplied values and actionable fixes', async () => {
  const report: DoctorResult = {
    ...healthy,
    checks: healthy.checks.map((check) => ({
      ...check,
      ...(check.id === 'disk' ? { availableBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 } : {}),
      ...(check.id === 'accounts' ? { status: 'warn', count: 0, probed: false } : {}),
      ...(check.id === 'plugins' || check.id === 'native' ? { status: 'fail' } : {}),
    })),
  }
  const host = await mount(healthApi(report, 'unavailable', 'warn'))
  expect(host.querySelector('.agnes-doctor-footer')?.getAttribute('data-state')).toBe('warn')
  expect(host.querySelector('.agnes-doctor-service')?.textContent).toContain('Needs attention')
  expect(host.querySelector('.agnes-doctor-ecg')).toBeNull()
  expect(host.querySelector('.agnes-doctor-footer [data-testid=diagnostics-summary-copy]')).not.toBeNull()
  expect(host.querySelector('.agnes-doctor-footer [data-testid=diagnostics-export]')).not.toBeNull()
  expect(host.querySelectorAll('.agnes-doctor-card')).toHaveLength(1)
  expect(
    host.querySelector('[data-testid=doctor-check-accounts] [data-testid=doctor-probe-accounts]'),
  ).not.toBeNull()
  const groups = [...host.querySelectorAll('[data-doctor-group]')]
  expect(
    groups.map((group) => [
      group.getAttribute('data-doctor-group'),
      group.querySelector('[data-testid="doctor-group-count"]')?.textContent,
    ]),
  ).toEqual([
    ['environment', '1/2'],
    ['data', '4/4'],
    ['isolation', '2/2'],
    ['connection', '1/3'],
  ])
  expect(groups[0]?.querySelector('small')?.getAttribute('data-tone')).toBe('warn')
  expect(groups[1]?.querySelector('small')?.getAttribute('data-tone')).toBe('ok')
  for (const id of [...checkIds, 'worker'])
    expect(host.querySelectorAll(`[data-testid="doctor-check-${id}"]`)).toHaveLength(1)
  const row = (id: string) => {
    const element = host.querySelector(`[data-testid="doctor-check-${id}"]`)
    if (!element) throw new Error(`Missing check ${id}`)
    return element
  }
  expect(row('node').textContent).toContain('24')
  expect(row('disk').textContent).toContain('2 GiB available of 8 GiB')
  expect(row('accounts').textContent).toContain('0 configured')
  expect(row('accounts').getAttribute('title')).toBe('Connection has not been tested in this check.')
  expect(row('home').querySelector('[data-testid="doctor-check-value"]')).toBeNull()
  expect(row('worker').textContent).toContain('Unavailable')
  expect(row('worker').getAttribute('data-state')).toBe('unavailable')
  const fixes = [...host.querySelectorAll('[data-testid="doctor-fix"]')]
  expect(fixes).toHaveLength(3)
  expect(fixes.find((fix) => fix.textContent?.includes('Native helpers'))?.textContent).toContain(
    'Rebuild the native helpers',
  )
  expect(fixes.find((fix) => fix.textContent?.includes('Native helpers'))?.querySelector('a')).toBeNull()
  expect(fixes.flatMap((fix) => [...fix.querySelectorAll('a')].map((a) => a.getAttribute('href')))).toEqual([
    '?settings=model',
    '?settings=plugins',
  ])
  const route = vi.fn()
  host.addEventListener('agnes:settings-route', (event) => route((event as CustomEvent).detail))
  await act(async () => host.querySelector<HTMLAnchorElement>('a[href="?settings=model"]')?.click())
  expect(route).toHaveBeenCalledWith('model')
  const ok = await mount(healthApi(healthy, 'ok'))
  expect(ok.querySelector('[data-testid="doctor-fix"]')).toBeNull()
  expect(ok.querySelector('.agnes-doctor-service')?.textContent).toContain('Running')
  expect(
    ok.querySelector('[data-doctor-group="environment"] [data-testid="doctor-group-count"]')?.textContent,
  ).toBe('3/3')
})
it('keeps pending groups in place, announces completion, refreshes time, probes accounts and retries failures', async () => {
  vi.useFakeTimers()
  try {
    let finish: ((value: DoctorResult) => void) | undefined
    const api = healthApi(healthy)
    api.doctor = vi.fn(
      () =>
        new Promise<DoctorResult>((resolve) => {
          finish = resolve
        }),
    )
    const host = await mount(api)
    const run = host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-doctor-run"]')
    if (!run) throw new Error('Missing check action')
    expect(host.querySelectorAll('[data-doctor-group]')).toHaveLength(4)
    expect(host.querySelectorAll('[data-state="pending"]')).toHaveLength(12)
    expect(run.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('[data-testid="doctor-announcement"]')?.textContent).toBe('')
    await act(async () => finish?.(healthy))
    expect(run.getAttribute('aria-busy')).toBe('false')
    expect(host.querySelector('[data-testid="doctor-announcement"]')?.textContent).toContain(
      'Status check complete.',
    )
    expect(host.querySelector('[data-testid="doctor-checked-at"]')?.textContent).toBe('Just now')
    await act(async () => vi.advanceTimersByTime(120000))
    expect(host.querySelector('[data-testid="doctor-checked-at"]')?.textContent).toBe('2 minutes ago')
    await act(async () => run.click())
    expect(host.querySelectorAll('[data-state="pending"]')).toHaveLength(12)
    await act(async () => finish?.(healthy))
    expect(host.querySelector('[data-testid="doctor-checked-at"]')?.textContent).toBe('Just now')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="doctor-probe-accounts"]')?.click(),
    )
    expect(api.doctor).toHaveBeenLastCalledWith(expect.any(AbortSignal), true)
    await act(async () =>
      finish?.({
        status: 'fail',
        checks: healthy.checks.map((check) =>
          check.id === 'accounts' ? { ...check, status: 'fail', probed: true, count: 1 } : check,
        ),
      }),
    )
    const account = host.querySelector('[data-testid="doctor-check-accounts"]')
    if (!account) throw new Error('Missing account check')
    expect(account.textContent).toContain('Check failed')
    expect(account.getAttribute('title')).toBeNull()
    vi.mocked(api.doctor).mockRejectedValueOnce(new Error('private failure'))
    await act(async () => run.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Diagnostics could not be loaded. Try again.',
    )
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="doctor-retry"]')?.click())
    await act(async () => finish?.(healthy))
    expect(host.querySelector('[role="alert"]')).toBeNull()
    const failedApi = healthApi(healthy)
    failedApi.doctor = vi.fn().mockRejectedValue(new Error('private failure'))
    const failed = await mount(failedApi)
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain('Diagnostics could not be loaded')
    expect(failed.querySelectorAll('[data-state="pending"]')).toHaveLength(12)
    expect(failed.querySelector('[data-testid="doctor-fix"]')).toBeNull()
    expect(failed.querySelector('[data-testid="doctor-checked-at"]')).toBeNull()
    expect(failed.querySelector('[data-testid="doctor-retry"]')).not.toBeNull()
    await act(async () => roots.pop()?.unmount())
    await act(async () => run.click())
    const pendingSignal = vi.mocked(api.doctor).mock.calls.at(-1)?.[0]
    await act(async () => roots.pop()?.unmount())
    expect(pendingSignal?.aborted).toBe(true)
    await act(async () => finish?.(healthy))
    expect(host.textContent).toBe('')
  } finally {
    vi.useRealTimers()
  }
})

it.each(['saved', 'failed'] as const)(
  'ignores a late %s export after the diagnostics API changes',
  async (outcome) => {
    let finish!: (response: Response) => void
    let finishRead!: (response: Response) => void
    let oldSignal: AbortSignal | null | undefined
    const oldApi = diagnosticsApi(async (_url, init) => {
      if (init?.method) {
        oldSignal = init.signal
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      }
      return Response.json({ bundle, doctorAvailable: false })
    })
    const download = vi.fn()
    const host = await mount(oldApi, download)
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-export"]')?.click(),
    )
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="diagnostics-export-confirm"]')?.click(),
    )
    expect(finish).toBeTypeOf('function')
    const nextApi = diagnosticsApi(
      async () =>
        new Promise<Response>((resolve) => {
          finishRead = resolve
        }),
    )
    await act(async () =>
      roots
        .at(-1)
        ?.render(
          createElement(
            SettingsSubpageFrame,
            { header: null },
            createElement(DiagnosticsPanel, { api: nextApi, download }),
          ),
        ),
    )
    expect(oldSignal?.aborted).toBe(true)
    await act(async () =>
      finish(outcome === 'saved' ? Response.json(bundle) : Response.json({}, { status: 500 })),
    )
    expect(download).not.toHaveBeenCalled()
    // The read failure shows on the entry row; the list page holding diagnostics-failure is closed.
    expect(host.querySelector('[data-testid="diagnostics-errors-row"]')?.textContent).not.toContain(
      'Could not read error records',
    )
    expect(host.querySelector('[data-testid="diagnostics-failure"]')).toBeNull()
    expect(
      document.querySelector('[data-testid="diagnostics-export-confirm"]')?.getAttribute('aria-busy'),
    ).toBe('true')
    await act(async () => finishRead(Response.json({ bundle, doctorAvailable: false })))
  },
)
