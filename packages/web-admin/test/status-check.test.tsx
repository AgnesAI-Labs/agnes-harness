/** @vitest-environment happy-dom */
import { setAdvancedSettingsShown } from '@agnes/web-ui'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DiagnosticsApi } from '../src/settings/diagnostics-api.js'
import { mountStatusCheck } from '../src/settings/status-check.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
// Advanced settings are on unless the reader turned them off.
beforeEach(() => setAdvancedSettingsShown(false))
afterEach(() => {
  setAdvancedSettingsShown(false)
  document.body.replaceChildren()
})

it('opens the status check on its own, and leads to the full page only with advanced settings on', async () => {
  const doctor = vi.fn(async () => ({ status: 'ok', checks: [] }))
  const details = vi.fn()
  const check = mountStatusCheck({ details, api: { doctor } as unknown as DiagnosticsApi })
  try {
    expect(document.querySelector('[data-testid="doctor-panel"]')).toBeNull()
    await act(async () => check.open())
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="diagnostics-health-summary"]')).not.toBeNull(),
    )
    expect(doctor).toHaveBeenCalledOnce()
    // Without advanced settings there is nowhere further to send the reader.
    expect(document.querySelector('[data-testid="status-check-details"]')).toBeNull()
    await act(async () => setAdvancedSettingsShown(true))
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="status-check-details"]')?.click(),
    )
    expect(details).toHaveBeenCalledOnce()
  } finally {
    await act(async () => check.dispose())
  }
})
