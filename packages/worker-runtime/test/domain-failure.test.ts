import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { domainFailureFromUnknown, REDACTED_ERROR_MESSAGE } from '@agnes/error-sanitization'
import { createSqliteStorage } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { workerDomainFailure } from '../src/worker-errors.js'

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
      expect(workerDomainFailure(raised)).toEqual(failure)
    } finally {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

it('preserves attachment admission reasons on the wire with fixed text and no arbitrary detail', async () => {
  const { workerDomainFailure } = await import('../src/worker-errors.js')
  const { encodeFrame, JsonlDecoder } = await import('../src/framing.js')
  const failure = workerDomainFailure({
    code: 'E_ENVELOPE',
    message: 'native error with private filesystem data',
    detail: { code: 'ATTACHMENT_PIXELS', raw: 'private payload' },
  })
  expect(failure).toEqual({ code: -32602, message: 'INVALID_PARAMS', data: { code: 'ATTACHMENT_PIXELS' } })
  const frame = { kind: 'reply', requestId: 'synthetic', error: failure }
  expect(new JsonlDecoder().feed(encodeFrame(frame))).toEqual([frame])
  expect(JSON.stringify(failure)).not.toContain('private')
})

it.each([
  ...['E_PRESET_UNSUPPORTED', 'E_PRESET_UNRESOLVED', 'E_MODEL_UNSUPPORTED'].map((code) => ({
    code,
    reason: undefined,
    wire: -32008,
    message: 'PRESET_SWITCH_REJECTED',
    data: { code },
  })),
  {
    code: 'E_PRESET_UNSUPPORTED',
    reason: 'bundle-unavailable',
    wire: -32011,
    message: 'SEMANTIC_REJECTED',
    data: { code: 'BUNDLE_UNAVAILABLE', reason: 'selected bundle is not installed, enabled and trusted' },
  },
  {
    code: 'E_PRESET_UNSUPPORTED',
    reason: 'preset-not-allowed',
    wire: -32008,
    message: 'PRESET_SWITCH_REJECTED',
    data: { code: 'PRESET_SWITCH_REJECTED', reason: 'not in presets.allowed' },
  },
  {
    code: 'E_PRESET_UNSUPPORTED',
    reason: 'private-reason',
    wire: -32008,
    message: 'PRESET_SWITCH_REJECTED',
    data: { code: 'E_PRESET_UNSUPPORTED' },
  },
  {
    code: 'E_MODEL_UNSUPPORTED',
    reason: 'bundle-unavailable',
    wire: -32008,
    message: 'PRESET_SWITCH_REJECTED',
    data: { code: 'E_MODEL_UNSUPPORTED' },
  },
])(
  'preserves $code ($reason) as a safe RPC refusal across the worker and daemon',
  async ({ code, reason, wire, message, data }) => {
    const { workerDomainFailure } = await import('../src/worker-errors.js')
    const failure = workerDomainFailure({
      code,
      message: 'private path',
      detail: { reason, secret: 'private' },
    })
    expect(failure).toEqual({ code: wire, message, data })
    const unreadable = Object.defineProperty({ code, detail: { reason } }, 'message', {
      get() {
        throw new Error('private authoring getter')
      },
    })
    expect(workerDomainFailure(unreadable)).toEqual(failure)
    expect(JSON.stringify(failure)).not.toContain('private')
  },
)

it('keeps startup failures closed while sharing their codes with the public contract', async () => {
  const { workerBootFailureCode } = await import('../src/boot-failure.js')
  for (const code of ['E_SEAM_INIT', 'E_SECRET_UNRESOLVED', 'E_PACKAGE_INTEGRITY'])
    expect(workerBootFailureCode(code)).toBe(code)
  expect(workerBootFailureCode('E_BUDGET')).toBeUndefined()
  expect(workerBootFailureCode('UNKNOWN_DENIED')).toBeUndefined()
})

it('keeps unknown worker failures generic even when exception accessors throw', async () => {
  const { workerDomainFailure } = await import('../src/worker-errors.js')
  const failures = [
    { code: 'E_SCAN_TRUNCATED', message: 'private scan failure', detail: { secret: 'private' } },
    {
      code: 'E_SCAN_TRUNCATED',
      message:
        'E_SCAN_TRUNCATED: scan matched more than 500 rows (pageMax=500 requested=all fromSeq=start toSeq=1234 order=asc) private',
    },
    Object.defineProperty({ code: 'E_SCAN_TRUNCATED' }, 'message', {
      get() {
        throw new Error('private scan getter')
      },
    }),
    Object.defineProperty({ code: 'UNKNOWN_DENIED' }, 'message', {
      get() {
        throw new Error('private log')
      },
    }),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('private descriptor')
        },
      },
    ),
  ]
  for (const error of failures) {
    const failure = workerDomainFailure(error)
    expect(failure.message).toBe('Worker operation failed.')
    expect(JSON.stringify(failure)).not.toContain('private')
  }
})

describe('file errors at the worker seam', () => {
  it('keeps the failing call and file kinds for the daemon audit, never the path', () => {
    const failure = workerDomainFailure(
      Object.assign(
        new Error("EPERM: operation not permitted, rename 'C:\\Users\\me\\proj\\pin.json.1.tmp'"),
        {
          code: 'EPERM',
          syscall: 'rename',
          path: 'C:\\Users\\me\\proj\\pin.json.1.tmp',
          dest: 'C:\\Users\\me\\proj\\pin.json',
        },
      ),
    )
    expect(failure).toEqual({
      code: 'EPERM',
      message: 'Worker operation failed.',
      syscall: 'rename',
      fileKind: 'temp',
      destKind: 'json',
    })
    expect(JSON.stringify(failure)).not.toMatch(/Users|proj/)
  })
})
