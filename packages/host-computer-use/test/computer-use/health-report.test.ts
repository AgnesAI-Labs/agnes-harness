import { expect, it } from 'vitest'
import {
  assertComputerUseCoreHealth,
  assertComputerUseDoctorHealth,
} from '../../src/computer-use/health-report.js'

function report(overrides: Record<string, unknown> = {}) {
  return {
    content: [],
    isError: false,
    structuredContent: {
      schema_version: '1',
      platform: 'darwin',
      driver_version: '0.28.1',
      overall: 'degraded',
      checks: [
        { name: 'binary_version', status: 'pass', message: 'ok' },
        { name: 'platform_supported', status: 'pass', message: 'ok' },
        { name: 'session_active', status: 'pass', message: 'ok' },
        { name: 'tcc_accessibility', status: 'fail', message: 'grant required' },
      ],
      ...overrides,
    },
  } as never
}

it('accepts a macOS degraded report only when all core health rows pass', () => {
  expect(() => assertComputerUseCoreHealth(report(), 'darwin', '0.28.1')).not.toThrow()
})

it('rejects failed, cross-platform, duplicate and missing core health reports', () => {
  expect(() => assertComputerUseCoreHealth(report({ overall: 'failed' }), 'darwin', '0.28.1')).toThrow()
  expect(() => assertComputerUseCoreHealth(report({ platform: 'win32' }), 'darwin', '0.28.1')).toThrow()
  expect(() =>
    assertComputerUseCoreHealth(
      report({
        checks: [
          { name: 'binary_version', status: 'pass' },
          { name: 'binary_version', status: 'pass' },
          { name: 'platform_supported', status: 'pass' },
          { name: 'session_active', status: 'pass' },
        ],
      }),
      'darwin',
      '0.28.1',
    ),
  ).toThrow('malformed')
  expect(() =>
    assertComputerUseCoreHealth(
      report({ checks: [{ name: 'binary_version', status: 'pass' }] }),
      'darwin',
      '0.28.1',
    ),
  ).toThrow('platform_supported')
})

it('requires filtered doctor rows to match the requested selection and all pass', () => {
  const selected = report({
    overall: 'ok',
    checks: [{ name: 'binary_version', status: 'pass', message: 'ok' }],
  })
  expect(() =>
    assertComputerUseDoctorHealth(selected, 'darwin', '0.28.1', {
      include: ['binary_version'],
      skip: ['binary_version'],
    }),
  ).not.toThrow()
  expect(() =>
    assertComputerUseDoctorHealth(selected, 'darwin', '0.28.1', {
      include: ['binary_version', 'session_active'],
    }),
  ).toThrow('omitted requested check')
  expect(() =>
    assertComputerUseDoctorHealth(selected, 'darwin', '0.28.1', { skip: ['binary_version'] }),
  ).toThrow('returned a skipped check')
  expect(() => assertComputerUseDoctorHealth(report(), 'darwin', '0.28.1', {})).toThrow('degraded health')
})

// cua-driver 0.28.1 on macOS (live run, 2026-09-22) does not omit a filtered-out check: it returns
// the row with status `skip` and "Skipped by include/skip filter.". Before this was accepted, every
// `agnes doctor computer-use --include/--skip` against the real driver failed.
it('accepts a filtered-out check only as the skip row the live driver returns', () => {
  const names = [
    'binary_version',
    'platform_supported',
    'session_active',
    'bundle_identity',
    'tcc_accessibility',
    'tcc_screen_recording',
    'ax_capability',
    'screen_capture_capability',
  ]
  const filtered = (ran: string[], statuses: Record<string, string> = {}) =>
    report({
      overall: 'ok',
      checks: names.map((name) => ({
        name,
        status: statuses[name] ?? (ran.includes(name) ? 'pass' : 'skip'),
        message: ran.includes(name) ? 'ok' : 'Skipped by include/skip filter.',
      })),
    })
  const included = ['binary_version', 'ax_capability']
  const unskipped = names.filter((name) => name !== 'screen_capture_capability')

  expect(() =>
    assertComputerUseDoctorHealth(filtered(included), 'darwin', '0.28.1', { include: included }),
  ).not.toThrow()
  expect(() =>
    assertComputerUseDoctorHealth(filtered(unskipped), 'darwin', '0.28.1', {
      skip: ['screen_capture_capability'],
    }),
  ).not.toThrow()
  // A filtered-out row that still ran means the driver ignored the filter.
  expect(() =>
    assertComputerUseDoctorHealth(filtered([...included, 'session_active']), 'darwin', '0.28.1', {
      include: included,
    }),
  ).toThrow('returned an unrequested check: session_active')
  expect(() =>
    assertComputerUseDoctorHealth(filtered(names), 'darwin', '0.28.1', {
      skip: ['screen_capture_capability'],
    }),
  ).toThrow('returned a skipped check: screen_capture_capability')
  // A requested row is still judged on its own status: skipped or failed is never a pass.
  expect(() =>
    assertComputerUseDoctorHealth(filtered(included, { ax_capability: 'skip' }), 'darwin', '0.28.1', {
      include: included,
    }),
  ).toThrow('doctor failed: ax_capability')
  expect(() =>
    assertComputerUseDoctorHealth(filtered(unskipped, { tcc_accessibility: 'fail' }), 'darwin', '0.28.1', {
      skip: ['screen_capture_capability'],
    }),
  ).toThrow('doctor failed: tcc_accessibility')
})

it('accepts only the official Windows checks that are explicitly inapplicable on Windows', () => {
  const windows = report({
    platform: 'win32',
    overall: 'ok',
    checks: [
      { name: 'binary_version', status: 'pass' },
      { name: 'platform_supported', status: 'pass' },
      { name: 'session_active', status: 'pass' },
      { name: 'bundle_identity', status: 'skip' },
      { name: 'tcc_accessibility', status: 'skip' },
      { name: 'tcc_screen_recording', status: 'skip' },
      { name: 'ax_capability', status: 'pass' },
      { name: 'screen_capture_capability', status: 'pass' },
    ],
  })
  expect(() => assertComputerUseDoctorHealth(windows, 'win32', '0.28.1', {})).not.toThrow()
  expect(() =>
    assertComputerUseDoctorHealth(
      report({
        platform: 'win32',
        overall: 'ok',
        checks: [{ name: 'screen_capture_capability', status: 'skip' }],
      }),
      'win32',
      '0.28.1',
      {},
    ),
  ).toThrow('screen_capture_capability')
})
