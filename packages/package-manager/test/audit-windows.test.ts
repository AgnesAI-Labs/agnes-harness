import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, expect, it } from 'vitest'
import { appendPackageAudit, type PackageAuditEvent } from '../src/audit.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// guards-allow-platform: verify the real Windows file DACL, not POSIX mode bits.
it.runIf(process.platform === 'win32').each(['private', 'ordinary', 'inherited-private'])(
  'protects the audit in a %s directory, preserves idempotency and refuses unsafe existing files',
  (directoryKind) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-package-audit-'))
    roots.push(root)
    const profile = join(root, 'profile')
    if (directoryKind !== 'ordinary') createPrivateDirectorySync(profile)
    else mkdirSync(profile)
    const event: PackageAuditEvent = {
      eventId: 'windows-audit-test',
      at: '2026-09-15T00:00:00Z',
      actor: 'test',
      profile: 'test',
      operation: 'install',
      id: 'test/package',
      source: 'file',
      sourceHash: 'a'.repeat(64),
      version: '1.0.0',
      capabilityDiff: { old: null, next: null },
      integrity: null,
      old: 'removed',
      next: 'installed-disabled-untrusted',
      result: 'committed',
    }
    const file = join(profile, '.agnes-package-audit.jsonl')
    const previous = { ...event, eventId: 'legacy-record' }
    const legacy = directoryKind === 'inherited-private' ? `${JSON.stringify(previous)}\n` : ''
    if (legacy) {
      writeFileSync(file, legacy)
      expect(hasPrivateDaclSync(profile)).toBe(true)
      expect(hasPrivateDaclSync(file)).toBe(false)
    }
    let mirrored = 0
    const sink = {
      write: () => {
        mirrored++
      },
    }
    appendPackageAudit(profile, event, sink)
    const bytes = readFileSync(file)
    expect(bytes.toString()).toBe(`${legacy}${JSON.stringify(event)}\n`)
    if (directoryKind !== 'ordinary') expect(hasPrivateDaclSync(profile)).toBe(true)
    expect(hasPrivateDaclSync(file)).toBe(true)
    appendPackageAudit(profile, event, sink)
    expect(mirrored).toBe(1)
    expect(readFileSync(file)).toEqual(bytes)
    const alias = join(profile, 'alias')
    linkSync(file, alias)
    expect(() => appendPackageAudit(profile, event)).toThrow()
    expect(readFileSync(file)).toEqual(bytes)
    rmSync(alias)
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [
      file,
      '/grant',
      '*S-1-1-0:R',
    ])
    expect(hasPrivateDaclSync(file)).toBe(false)
    expect(() => appendPackageAudit(profile, event)).toThrow()
    expect(readFileSync(file)).toEqual(bytes)
  },
)
