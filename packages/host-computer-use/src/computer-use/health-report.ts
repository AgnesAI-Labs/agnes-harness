import type { DriverCallResult } from './fake/types.js'

export type ComputerUseHealthSelectors = Readonly<{
  include?: readonly string[]
  skip?: readonly string[]
}>

/** Permission-independent checks that are safe to run while an ordinary session worker boots. */
export const COMPUTER_USE_CORE_HEALTH_CHECKS = Object.freeze([
  'binary_version',
  'platform_supported',
  'session_active',
])

function healthReport(
  result: DriverCallResult,
  platform: 'win32' | 'darwin' | 'linux',
  version: string,
): Readonly<{ overall: 'ok' | 'degraded'; checks: ReadonlyMap<string, string> }> {
  if (result.isError) throw new Error('Computer Use driver health report failed')
  const report = result.structuredContent
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Computer Use driver health report is malformed')
  const row = report as Record<string, unknown>
  if (
    row.schema_version !== '1' ||
    row.platform !== platform ||
    row.driver_version !== version ||
    (row.overall !== 'ok' && row.overall !== 'degraded') ||
    !Array.isArray(row.checks)
  )
    throw new Error('Computer Use driver health identity is invalid')
  const checks = new Map<string, string>()
  for (const value of row.checks) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Computer Use driver health check is malformed')
    const check = value as Record<string, unknown>
    if (typeof check.name !== 'string' || typeof check.status !== 'string' || checks.has(check.name))
      throw new Error('Computer Use driver health check is malformed')
    checks.set(check.name, check.status)
  }
  return Object.freeze({ overall: row.overall, checks })
}

/** Validates the stable v1 health envelope and every core row before a driver becomes active. */
export function assertComputerUseCoreHealth(
  result: DriverCallResult,
  platform: 'win32' | 'darwin' | 'linux',
  version: string,
): void {
  const { checks } = healthReport(result, platform, version)
  for (const name of COMPUTER_USE_CORE_HEALTH_CHECKS)
    if (checks.get(name) !== 'pass') throw new Error(`Computer Use driver core health failed: ${name}`)
}

/** Validates the exact filtered doctor response. Installation deliberately uses the narrower core
 * gate above so a missing OS permission can report degraded without making a signed driver
 * uninstallable; an explicit doctor run must never turn a degraded or filtered failure into pass. */
export function assertComputerUseDoctorHealth(
  result: DriverCallResult,
  platform: 'win32' | 'darwin' | 'linux',
  version: string,
  selectors: ComputerUseHealthSelectors,
): void {
  const { overall, checks } = healthReport(result, platform, version)
  if (overall !== 'ok') throw new Error('Computer Use driver doctor reported degraded health')
  const platformInapplicable =
    platform === 'darwin'
      ? new Set<string>()
      : new Set(['bundle_identity', 'tcc_accessibility', 'tcc_screen_recording'])
  const include = selectors.include === undefined ? undefined : new Set(selectors.include)
  const skip = new Set(selectors.skip ?? [])
  for (const name of include ?? [])
    if (!checks.has(name)) throw new Error(`Computer Use driver doctor omitted requested check: ${name}`)
  for (const [name, status] of checks) {
    // The driver answers a filtered-out check with a `skip` row rather than omitting it; any other
    // status there means the filter was not honoured. Include wins over skip, as in the catalog.
    if (include ? !include.has(name) : skip.has(name)) {
      if (status === 'skip') continue
      throw new Error(
        `Computer Use driver doctor returned ${include ? 'an unrequested' : 'a skipped'} check: ${name}`,
      )
    } else if (status !== 'pass' && !(status === 'skip' && platformInapplicable.has(name)))
      throw new Error(`Computer Use driver doctor failed: ${name}`)
  }
}
