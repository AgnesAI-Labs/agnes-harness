import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLoopbackTransport } from '../../src/adapters/remote-transport.js'
import { openRemoteWorkspace } from '../../src/adapters/remote-workspace.js'

describe('remote workspace lifecycle', () => {
  it('creates a directory carrying the session key and removes it on close', async () => {
    const base = mkdtempSync(join(tmpdir(), 'agnes-rw-'))
    const t = createLoopbackTransport({ root: base })
    const ws = await openRemoteWorkspace(t, {
      sessionKey: 'sess-abc',
      rootTemplate: join(base, '{session}'),
      keepOnClose: false,
    })
    expect(ws.root).toContain('sess-abc')
    expect(existsSync(ws.root)).toBe(true)
    await ws.close()
    expect(existsSync(ws.root)).toBe(false)
  })

  it('keeps the directory when keepOnClose is set', async () => {
    const base = mkdtempSync(join(tmpdir(), 'agnes-rw-'))
    const t = createLoopbackTransport({ root: base })
    const ws = await openRemoteWorkspace(t, {
      sessionKey: 'sess-keep',
      rootTemplate: join(base, '{session}'),
      keepOnClose: true,
    })
    await ws.close()
    expect(existsSync(ws.root)).toBe(true)
  })
})
