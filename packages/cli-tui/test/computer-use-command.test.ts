import type { ComputerUseDoctorResult, ComputerUseStatusResult } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { completeToken, runSlash, slashCommand } from '../src/commands.js'

const blocked: ComputerUseStatusResult = {
  schemaVersion: 1,
  status: 'blocked',
  admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
  runtime: { state: 'not-started', startAttempted: false },
  blockers: [
    'release-provenance-incomplete',
    'compatibility-evidence-incomplete',
    'platform-acceptance-incomplete',
  ],
}

const failed: ComputerUseDoctorResult = {
  schemaVersion: 1,
  status: 'failed',
  admission: { state: 'ready', reason: 'windows-verified-driver' },
  checks: { state: 'failed', reason: 'windows-driver-health-or-identity-failed' },
}

function appWith(call: ReturnType<typeof vi.fn>): TuiApp {
  return { session: { client: { call } } } as unknown as TuiApp
}

describe('computer-use read-only TUI commands', () => {
  it('lists status and doctor entry points and forwards each to its authenticated RPC', async () => {
    const call = vi.fn(async (method: string) =>
      method === '_agnes/v1/computerUse.status' ? blocked : failed,
    )
    const app = appWith(call)

    const status = await runSlash(app, '/computer-use status')
    expect(status).toMatchObject({ presentation: 'transcript' })
    expect(status.text).toContain('Computer Use: blocked')
    expect(status.text).toContain('admission: blocked (p0-evidence-incomplete)')
    expect(status.text).toContain('runtime: not-started; start attempted: false')
    for (const blocker of blocked.blockers) expect(status.text).toContain(blocker)

    const doctor = await runSlash(app, '/doctor computer-use')
    expect(doctor).toMatchObject({ presentation: 'transcript' })
    expect(doctor.text).toContain('Computer Use doctor: failed')
    expect(doctor.text).toContain('admission: ready (windows-verified-driver)')
    expect(doctor.text).toContain('checks: failed (windows-driver-health-or-identity-failed)')

    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenNthCalledWith(1, '_agnes/v1/computerUse.status', {})
    expect(call).toHaveBeenNthCalledWith(2, '_agnes/v1/computerUse.doctor', {})
    expect(slashCommand('/computer-use')?.args).toBe('status')
    expect(slashCommand('/doctor')?.args).toBe('computer-use')
    expect(completeToken('/comp', '/unused')).toContain('/computer-use')
    expect(completeToken('/doc', '/unused')).toContain('/doctor')
  })

  it('renders an unreachable live doctor without substituting cached status', async () => {
    const call = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: 'unreachable' as const,
      admission: { state: 'ready' as const, reason: 'macos-verified-driver' as const },
      checks: { state: 'unavailable' as const, reason: 'live-driver-doctor-unavailable' as const },
    }))
    const result = await runSlash(appWith(call), '/doctor computer-use')
    expect(result.text).toContain('Computer Use doctor: unreachable')
    expect(result.text).toContain('checks: unavailable (live-driver-doctor-unavailable)')
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.doctor', {})
  })

  it('fails closed for mutation, probe, repair, trailing, and unknown subcommands without any RPC', async () => {
    const call = vi.fn(async () => blocked)
    const app = appWith(call)
    for (const command of [
      '/computer-use',
      '/computer-use install',
      '/computer-use start',
      '/computer-use probe',
      '/computer-use repair',
      '/computer-use status extra',
      '/computer-use unknown',
      '/doctor',
      '/doctor install',
      '/doctor computer-use repair',
      '/doctor unknown',
    ]) {
      const result = await runSlash(app, command)
      expect(result.text).toMatch(/usage|read-only/)
    }
    expect(call).not.toHaveBeenCalled()
  })
})
