import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { domainFailureFromUnknown, REDACTED_ERROR_MESSAGE } from '@agnes/error-sanitization'
import { createSqliteStorage } from '@agnes/host'
import { describe, expect, it } from 'vitest'

describe('domainFailureFromUnknown at the worker seam', () => {
  it('keeps a public reason and drops the rest of detail', () => {
    expect(
      domainFailureFromUnknown({
        code: 'E_PRESET_UNRESOLVED',
        message: 'E_PRESET_UNRESOLVED: the profile declares no provider.routes',
        detail: { reason: 'no-routes', extra: 'drop-me' },
      }),
    ).toEqual({
      code: 'E_PRESET_UNRESOLVED',
      message: 'E_PRESET_UNRESOLVED: the profile declares no provider.routes',
      reason: 'no-routes',
    })
  })
})

describe('E_SCAN_TRUNCATED at the worker seam', () => {
  it('keeps where the scan was aimed in the message, and nothing that looks like a secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-scan-failure-'))
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    try {
      await storage.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
      const row = {
        ts: '2026-09-24T00:00:00Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
        type: 'user/message',
        data: {},
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: 'principal',
        trust: 'trusted',
        lane: 'main',
        v: 1,
      }
      await storage.commit('k', {
        events: Array.from({ length: 1_234 }, () => row) as never,
        expectedWriterRunId: 'r1',
      })
      const raised = await storage.scan('k', { toSeq: 1_234 }).catch((e: unknown) => e)
      const failure = domainFailureFromUnknown(raised)
      expect(failure).toEqual({
        code: 'E_SCAN_TRUNCATED',
        message:
          'E_SCAN_TRUNCATED: scan matched more than 500 rows (pageMax=500 requested=all fromSeq=start toSeq=1234 order=asc)',
      })
      expect(failure.message).not.toBe(`E_SCAN_TRUNCATED: ${REDACTED_ERROR_MESSAGE}`)
    } finally {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
