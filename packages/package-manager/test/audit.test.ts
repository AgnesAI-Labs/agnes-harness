import fs, { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as system from '@agnes/system-node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendPackageAudit, type PackageAuditEvent } from '../src/audit.js'

let root: string
const event: PackageAuditEvent = {
  eventId: 'event-one',
  at: '2026-09-14T00:00:00Z',
  actor: 'local',
  profile: 'local-dev',
  operation: 'install',
  id: 'acme/pkg',
  source: 'local',
  sourceHash: '0'.repeat(64),
  version: '1.0.0',
  capabilityDiff: { old: null, next: null },
  integrity: null,
  old: 'removed',
  next: 'installed-disabled-untrusted',
  result: 'committed',
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-audit-中文 space%-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
const file = () => join(root, '.agnes-package-audit.jsonl')
function seed(contents: string): void {
  const fd = system.createPrivateFileSync(file())
  try {
    writeFileSync(fd, contents)
  } finally {
    closeSync(fd)
  }
}

it('flushes an event before mirroring it and keeps replay idempotent', () => {
  const sink = { write: vi.fn(() => expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual(event)) }
  appendPackageAudit(root, event, sink)
  appendPackageAudit(root, event, sink)
  expect(sink.write).toHaveBeenCalledTimes(1)
  expect(readFileSync(file(), 'utf8')).toBe(`${JSON.stringify(event)}\n`)
})
it('keeps the local event when the optional mirror fails', () => {
  appendPackageAudit(root, event, {
    write() {
      throw new Error('mirror unavailable')
    },
  })
  expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual(event)
})
it.each(['{"partial":', '[]\n'])('preserves corrupt or incomplete existing data: %s', (contents) => {
  seed(contents)
  expect(() => appendPackageAudit(root, event)).toThrow(/audit/)
  expect(readFileSync(file(), 'utf8')).toBe(contents)
})
it('rejects a conflicting same-ID record without changing the log', () => {
  const contents = `${JSON.stringify({ ...event, operation: 'other' })}\n`
  seed(contents)
  expect(() => appendPackageAudit(root, event)).toThrow(/conflicting/)
  expect(readFileSync(file(), 'utf8')).toBe(contents)
})
it('does not call the mirror when local storage fails', () => {
  const sink = { write: vi.fn() }
  mkdirSync(file())
  expect(() => appendPackageAudit(root, event, sink)).toThrow()
  expect(sink.write).not.toHaveBeenCalled()
})

it('propagates flush failures and retries flushing a present record without duplicating it', () => {
  const sink = { write: vi.fn() }
  const flush = vi.fn().mockImplementationOnce(() => {
    throw new Error('flush failed')
  })
  // guards-allow-platform: inject failure at the active platform's flush boundary after real writes.
  if (process.platform === 'win32') {
    const append = system.windowsAppendPrivateFileSync
    vi.spyOn(system, 'windowsAppendPrivateFileSync').mockImplementation((path, bytes, sync) => {
      append(path, bytes, false)
      if (sync) flush()
    })
  } else vi.spyOn(fs, 'fsyncSync').mockImplementation(flush)
  expect(() => appendPackageAudit(root, event, sink)).toThrow('flush failed')
  expect(sink.write).not.toHaveBeenCalled()
  expect(readFileSync(file(), 'utf8')).toBe(`${JSON.stringify(event)}\n`)
  flush.mockImplementationOnce(() => {
    throw new Error('retry flush failed')
  })
  expect(() => appendPackageAudit(root, event, sink)).toThrow('retry flush failed')
  appendPackageAudit(root, event, sink)
  expect(flush).toHaveBeenCalledTimes(3)
  expect(sink.write).not.toHaveBeenCalled()
  expect(readFileSync(file(), 'utf8')).toBe(`${JSON.stringify(event)}\n`)
})
