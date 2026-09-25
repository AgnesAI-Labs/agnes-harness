import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProfileTelemetryConsent } from '@agnes/host'
import * as system from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { consentCommand } from '../src/commands/consent.js'

describe.runIf(process.platform === 'win32')('Windows consent files', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'agnes-consent-win-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  })
  function consent(tier: string): string {
    return consentCommand(parseArgs(['consent', tier]), {
      home: root,
      cwd: root,
      env: {},
      agnesVersion: '0',
      log: () => undefined,
    })
  }
  it('privately saves the overlay and preserves consent transition rules', () => {
    expect(() => consent('FULL')).toThrow(/cannot transition directly/)
    consent('ANON')
    const dir = join(root, 'profiles', 'local-dev')
    expect(readProfileTelemetryConsent(dir)).toBe('ANON')
    expect(system.hasPrivateDaclSync(dir)).toBe(true)
    expect(system.hasPrivateDaclSync(join(dir, 'consent.yaml'))).toBe(true)
    consent('FULL')
    expect(readProfileTelemetryConsent(dir)).toBe('FULL')
  })
  it('preserves the previous tier and removes its temporary when replacement fails', () => {
    consent('ANON')
    vi.spyOn(system, 'renameWriteThroughSync').mockImplementation(() => {
      throw new Error('injected replacement failure')
    })
    expect(() => consent('FULL')).toThrow('injected replacement failure')
    const dir = join(root, 'profiles', 'local-dev')
    expect(readProfileTelemetryConsent(dir)).toBe('ANON')
    expect(fs.readdirSync(dir)).toEqual(['consent.yaml'])
  })
  it('refuses an existing broad profile directory without rewriting its permissions', () => {
    const dir = join(root, 'profiles', 'local-dev')
    fs.mkdirSync(dir, { recursive: true })
    // A new directory under the user's temporary directory inherits only the user, SYSTEM and
    // Administrators, which the private-directory rule may adopt as it is. Grant Everyone read
    // access so the directory is actually broad.
    acl(dir, '/grant', '*S-1-1-0:R')
    const before = acl(dir)
    expect(system.hasPrivateDaclSync(dir)).toBe(false)
    expect(() => consent('ANON')).toThrow()
    expect(system.hasPrivateDaclSync(dir)).toBe(false)
    expect(acl(dir)).toEqual(before)
    expect(fs.readdirSync(dir)).toEqual([])
  })
  it('preserves old bytes when private creation is unavailable', () => {
    consent('ANON')
    vi.spyOn(system, 'createPrivateFileSync').mockImplementation(() => {
      throw new Error('private creation unavailable')
    })
    expect(() => consent('FULL')).toThrow('private creation unavailable')
    const dir = join(root, 'profiles', 'local-dev')
    expect(readProfileTelemetryConsent(dir)).toBe('ANON')
    expect(fs.readdirSync(dir)).toEqual(['consent.yaml'])
  })
})

function acl(path: string, ...args: string[]): Buffer {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot is required for the Windows ACL test')
  return execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [path, ...args], {
    windowsHide: true,
    stdio: 'pipe',
  })
}
