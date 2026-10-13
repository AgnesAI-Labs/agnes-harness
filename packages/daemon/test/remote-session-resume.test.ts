import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { RemoteSession } from '../src/supervisor/remote-session.js'

const r1 = { seq: 1 }
const r2 = { seq: 2 }
const r3 = { seq: 3 }

describe('RemoteSession.scan resume', () => {
  it('reads a page the worker returned in parts, each row once, with no re-scan', async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce({ rows: [r1, r2], resume: { fromSeq: 3, limit: 498 } })
      .mockResolvedValueOnce({ rows: [r3] })
    const remote = new RemoteSession('k', 'writer', 1, { alive: true, command } as never, '/test')
    const query = { fromSeq: 1, toSeq: 9, limit: 500 }
    expect(await remote.scan(query)).toEqual([r1, r2, r3])
    expect(command).toHaveBeenCalledTimes(2)
    expect(command.mock.calls[0]).toEqual(['scan', query])
    expect(command.mock.calls[1]).toEqual(['scan', { ...query, fromSeq: 3, limit: 498 }])
    expect(remote.scanResumes).toBe(1)
  })

  it('resumes a descending page below the last row it got', async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce({ rows: [r3, r2], resume: { toSeq: 1, limit: 1 } })
      .mockResolvedValueOnce({ rows: [r1] })
    const remote = new RemoteSession('k', 'writer', 1, { alive: true, command } as never, '/test')
    const query = { fromSeq: 1, toSeq: 3, limit: 3, order: 'desc' }
    expect(await remote.scan(query)).toEqual([r3, r2, r1])
    expect(command.mock.calls[1]).toEqual(['scan', { ...query, toSeq: 1, limit: 1 }])
  })

  it('makes one call when the page fits one frame', async () => {
    const command = vi.fn().mockResolvedValue({ rows: [r1] })
    const remote = new RemoteSession('k', 'writer', 1, { alive: true, command } as never, '/test')
    expect(await remote.scan({ fromSeq: 1, toSeq: 1, limit: 1 })).toEqual([r1])
    expect(command).toHaveBeenCalledTimes(1)
    expect(remote.scanResumes).toBe(0)
  })

  it('reads raw rows in the worker', async () => {
    const page = { seq: 4, base64: 'e30K', nextOffset: null }
    const command = vi.fn().mockResolvedValue(page)
    const remote = new RemoteSession('k', 'writer', 1, { alive: true, command } as never, '/test')
    expect(await remote.exportRaw({ seq: 4, offset: 0 })).toEqual(page)
    expect(command).toHaveBeenCalledWith('exportRaw', { seq: 4, offset: 0 })
  })

  it('no longer splits and re-reads oversized pages', () => {
    expect(
      readFileSync(new URL('../src/supervisor/remote-session.ts', import.meta.url), 'utf8'),
    ).not.toContain('SCAN_PAGE_TOO_LARGE')
  })
})
