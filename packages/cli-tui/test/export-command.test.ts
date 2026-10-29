import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { type ExportRequest, exportSlash } from '../src/export-command.js'
import { tt } from '../src/locale-extended.js'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agh-export-cmd-'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

function harness(write?: (request: ExportRequest) => Promise<void>) {
  const requests: ExportRequest[] = []
  const app = {
    locale: 'en',
    cwd,
    session: { id: 'sess-1' },
    o: {
      ...(write
        ? {
            exportSession: async (r: ExportRequest) => {
              requests.push(r)
              await write(r)
            },
          }
        : {}),
    },
  } as unknown as TuiApp
  return { app, requests }
}

describe('/export', () => {
  it('writes the native format to a timestamped file in the working directory by default', async () => {
    const { app, requests } = harness(async () => {})
    const r = await exportSlash(app, '/export')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.format).toBe('agnes')
    expect(requests[0]?.sessionId).toBe('sess-1')
    expect(requests[0]?.out.startsWith(join(cwd, 'agh-sess-1-'))).toBe(true)
    expect(requests[0]?.out).toMatch(/-\d{8}T\d{6}Z\.jsonl$/)
    expect(r.text).toContain(requests[0]?.out)
  })

  it.each([
    ['/export html', 'html', '.html'],
    ['/export --html', 'html', '.html'],
    ['/export sharegpt', 'sharegpt', '.json'],
    ['/export claude-code', 'claude-code', '.jsonl'],
  ] as const)('%s picks the %s format and its extension', async (line, format, extension) => {
    const { app, requests } = harness(async () => {})
    await exportSlash(app, line)
    expect(requests[0]?.format).toBe(format)
    expect(requests[0]?.out.endsWith(extension)).toBe(true)
  })

  it('takes a path, relative to the working directory, with or without a format', async () => {
    const { app, requests } = harness(async () => {})
    await exportSlash(app, '/export out/my session.jsonl')
    await exportSlash(app, '/export html /tmp/x.html')
    expect(requests.map((r) => [r.format, r.out])).toEqual([
      ['agnes', join(cwd, 'out/my session.jsonl')],
      ['html', '/tmp/x.html'],
    ])
  })

  it.each(['/export --format sharegpt', '/export out.html --html', '/export html --bogus', '/export --json'])(
    '%s is usage, not a file named after the flag',
    async (line) => {
      const { app, requests } = harness(async () => {})
      const r = await exportSlash(app, line)
      expect(requests).toHaveLength(0)
      expect(r.text).toBe(tt('export.usage', 'en'))
    },
  )

  it('expands ~ to the home directory, like /cd', async () => {
    vi.stubEnv('HOME', '/tmp/agh-home')
    const { app, requests } = harness(async () => {})
    await exportSlash(app, '/export ~/x.jsonl')
    vi.unstubAllEnvs()
    expect(requests[0]?.out).toBe('/tmp/agh-home/x.jsonl')
  })

  it('puts the default name inside a directory given as the path', async () => {
    mkdirSync(join(cwd, 'dump'))
    const { app, requests } = harness(async () => {})
    await exportSlash(app, '/export sharegpt dump')
    expect(requests[0]?.out.startsWith(join(cwd, 'dump', 'agh-sess-1-'))).toBe(true)
  })

  it('refuses to replace an existing file and writes nothing', async () => {
    writeFileSync(join(cwd, 'README.md'), 'keep me')
    const { app, requests } = harness(async () => {})
    const r = await exportSlash(app, '/export README.md')
    expect(requests).toHaveLength(0)
    expect(r.text).toBe(tt('export.exists', 'en', { path: join(cwd, 'README.md') }))
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('keep me')
  })

  it('says why when the CLI injected no writer, and shows a failure instead of throwing', async () => {
    expect((await exportSlash(harness().app, '/export')).text).toMatch(/shared local daemon/)
    const failing = harness(async () => {
      throw new Error('history integrity failed')
    })
    expect((await exportSlash(failing.app, '/export')).text).toMatch(
      /Export failed: history integrity failed/,
    )
  })
})
