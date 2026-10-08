import { expect, it, vi } from 'vitest'
import {
  macosLiveAppIdentityBinary,
  macosLiveAppIdentitySync,
  parseMacOSLiveAppIdentity,
} from '../../src/computer-use/macos-live-app-identity.js'

const valid = `alive 1700000000.000001 1700000001.000002 com.apple.Notes APPLE12345 ${'a'.repeat(64)}\n`

it('parses a bounded live Security.framework identity', () => {
  expect(parseMacOSLiveAppIdentity(valid)).toEqual({
    platform: 'darwin',
    processStartTime: 'darwin:1700000000.000001:1700000001.000002',
    bundleId: 'com.apple.Notes',
    teamId: 'APPLE12345',
    signatureSha256: 'a'.repeat(64),
  })
})

it('accepts a strict-validated Apple platform app without a Developer Team ID', () => {
  expect(
    parseMacOSLiveAppIdentity(
      `alive 1700000000.000001 1700000001.000002 com.apple.finder - ${'b'.repeat(64)}\n`,
    ),
  ).toEqual({
    platform: 'darwin',
    processStartTime: 'darwin:1700000000.000001:1700000001.000002',
    bundleId: 'com.apple.finder',
    signatureSha256: 'b'.repeat(64),
  })
})

it.each([
  '',
  `alive 1.000001 2.000002 com.apple.Notes APPLE12345 ${'a'.repeat(63)}`,
  `alive 1.000001 2.000002 com.apple.Notes 'bad team' ${'a'.repeat(64)}`,
  `alive 1.1 2.2 com.apple.Notes APPLE12345 ${'a'.repeat(64)}`,
  `alive 1.000001 2.000002 com.apple.Notes APPLE12345 ${'a'.repeat(64)} extra`,
])('rejects malformed identity output %#', (output) => {
  expect(() => parseMacOSLiveAppIdentity(output)).toThrow('identity')
})

it('invokes only the fixed helper and decimal pid', () => {
  const run = vi.fn(() => ({ status: 0, stdout: valid }))
  expect(macosLiveAppIdentitySync(42, { run })).toMatchObject({ bundleId: 'com.apple.Notes' })
  expect(run).toHaveBeenCalledWith(macosLiveAppIdentityBinary(false), ['42'])
})

it('uses dist/native for development and native beside bundled entrypoints', () => {
  expect(macosLiveAppIdentityBinary(false)).toMatch(/dist[/\\]native[/\\]macos-live-app-identity$/u)
  expect(macosLiveAppIdentityBinary(true)).toMatch(/native[/\\]macos-live-app-identity$/u)
  expect(macosLiveAppIdentityBinary(false)).not.toMatch(/host[/\\]native[/\\]macos-live-app-identity$/u)
})

it('fails closed on helper errors and invalid pids', () => {
  expect(() => macosLiveAppIdentitySync(0, { run: vi.fn() })).toThrow('positive')
  expect(() =>
    macosLiveAppIdentitySync(42, { run: () => ({ status: 2, stdout: 'unknown invalid-signature\n' }) }),
  ).toThrow('unavailable')
})
