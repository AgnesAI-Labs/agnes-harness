import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUDIT_KINDS, createFileAudit, createMemoryAudit, isAuditKind } from '../src/audit.js'

const windows = process.platform === 'win32' // guards-allow-platform: actual audit permission semantics.

const CURRENT_KINDS = [
  'profile.resolved',
  'package.installed',
  'package.trusted',
  'package.enabled',
  'package.removed',
  'package.rolledback',
  'workspace.trusted',
  'workspace.rejected',
  'workspace.verified',
  'seams.assembled',
  'provider.assembled',
  'provider.env_swept',
  'extension.loaded',
  'extension.registered',
  'extension.service-call',
  'extension.failed',
  'extension.reloaded',
  'extension.revoked',
  'extension.revoke_failed',
  'extension.isolated',
  'extension.isolation-failed',
  'extension.isolation-fallback',
  'extensions.loaded',
  'secret.resolved',
  'startup.failed',
  'daemon.request_failed',
  'plugin.tree.reverted',
  'host.ready',
  'host.closed',
  'host.teardown_finished',
  'session.close_failed',
  'session.recovered',
  'preset.deprecated',
] as const

describe('audit kind closure', () => {
  it('contains exactly the host, managed-extension, recovery, and pending package/workspace kinds', () => {
    expect([...AUDIT_KINDS].sort()).toEqual([...CURRENT_KINDS].sort())
    for (const kind of CURRENT_KINDS) expect(isAuditKind(kind)).toBe(true)
    expect(isAuditKind('extension.typo')).toBe(false)
  })

  it('makes the memory sink enforce the same closure without redacting test evidence', () => {
    const audit = createMemoryAudit()
    audit.write({ kind: 'session.recovered', detail: { sessionKey: 'session-visible-in-memory' } })
    expect(audit.events[0]).toMatchObject({
      kind: 'session.recovered',
      detail: { sessionKey: 'session-visible-in-memory' },
    })
    expect(() => audit.write({ kind: 'extension.typo' })).toThrow(/unknown audit kind/)
  })
})

describe('file audit', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agnes-audit-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends canonical JSONL, owns its timestamp, redacts deeply, and flushes on close', async () => {
    const file = join(dir, 'audit', 'host.jsonl')
    const audit = createFileAudit(file)
    audit.write({
      at: '1970-01-01T00:00:00.000Z',
      kind: 'secret.resolved',
      detail: {
        ref: 'secret://agnes/gateway',
        token: 'abc',
        nested: { password: 'pw', safe: 'visible' },
        list: [{ apiKey: 'key-value' }, 'plain'],
        message: 'provider echoed sk-abcdefghijklmnopqrstuvwxyz',
      },
    })
    audit.write({ kind: 'host.ready', detail: { hash: `sha256-${'0'.repeat(64)}` } })
    await audit.close?.()

    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(Object.keys(lines[0] ?? {})).toEqual(['at', 'kind', 'detail'])
    expect(lines[0]).toMatchObject({
      kind: 'secret.resolved',
      detail: {
        ref: 'secret://agnes/gateway',
        token: '<redacted>',
        nested: { password: '<redacted>', safe: 'visible' },
        list: [{ apiKey: '<redacted>' }, 'plain'],
        message: '<redacted>',
      },
    })
    expect(lines[0]?.at).not.toBe('1970-01-01T00:00:00.000Z')
    expect(lines[0]?.at).toMatch(/^\d{4}-/)
    expect(lines[1]).toMatchObject({ kind: 'host.ready', detail: { hash: `sha256-${'0'.repeat(64)}` } })
  })

  it('applies a custom redactor on top of the mandatory baseline', async () => {
    const file = join(dir, 'audit', 'host.jsonl')
    const audit = createFileAudit(file, {
      redact: (event) => ({ ...event, detail: { ...event.detail, note: '<custom>' } }),
    })
    audit.write({ kind: 'host.ready', detail: { note: 'hide me', password: 'still baseline' } })
    await audit.close?.()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      detail: { note: '<custom>', password: '<redacted>' },
    })
  })

  it('rejects unknown input and redactor-produced kinds before appending them', () => {
    const file = join(dir, 'audit', 'host.jsonl')
    const audit = createFileAudit(file)
    expect(() => audit.write({ kind: 'nope' })).toThrow(/unknown audit kind/)
    expect(readFileSync(file, 'utf8')).toBe('')

    const changed = createFileAudit(join(dir, 'audit', 'changed.jsonl'), {
      redact: (event) => ({ ...event, kind: 'changed-by-redactor' }),
    })
    expect(() => changed.write({ kind: 'host.ready' })).toThrow(/unknown audit kind/)
  })

  it.runIf(!windows)('keeps the audit directory private and repairs an existing file mode', async () => {
    const file = join(dir, 'audit', 'host.jsonl')
    mkdirSync(join(dir, 'audit'), { mode: 0o777 })
    writeFileSync(file, '', { mode: 0o666 })
    chmodSync(join(dir, 'audit'), 0o777)
    chmodSync(file, 0o666)
    const audit = createFileAudit(file)
    audit.write({ kind: 'host.ready' })
    await audit.close?.()
    expect(statSync(join(dir, 'audit')).mode & 0o077).toBe(0)
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it.runIf(windows)('creates a private Windows audit directory and file', async () => {
    const file = join(dir, 'audit', 'host.jsonl')
    const audit = createFileAudit(file)
    try {
      audit.write({ kind: 'host.ready' })
      expect({
        directory: hasPrivateDaclSync(join(dir, 'audit')),
        file: hasPrivateDaclSync(file),
      }).toEqual({ directory: true, file: true })
    } finally {
      await audit.close?.()
    }
  })
  it.runIf(windows)('refuses widened Windows permissions without deleting the existing audit', async () => {
    const file = join(dir, 'audit', 'host.jsonl')
    const audit = createFileAudit(file)
    audit.write({ kind: 'host.ready' })
    await audit.close?.()
    const before = readFileSync(file)
    const system = process.env.SystemRoot
    if (!system) throw new Error('SystemRoot required')
    execFileSync(join(system, 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:R'], {
      windowsHide: true,
      stdio: 'pipe',
    })
    expect(() => createFileAudit(file)).toThrow()
    expect(() => audit.write({ kind: 'host.ready' })).toThrow()
    await expect(audit.close?.()).rejects.toBeDefined()
    expect(readFileSync(file)).toEqual(before)
    expect(hasPrivateDaclSync(file)).toBe(false)
  })
})
