import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpOAuthStore } from '../src/adapters/mcp-oauth-store.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'mcp-oauth-updater.ts')

describe.runIf(process.getuid !== undefined)('MCP OAuth credential store across processes', () => {
  let parent: string
  let root: string

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-mcp-oauth-race-'))
    chmodSync(parent, 0o700)
    root = join(parent, '.agh')
  })

  afterEach(() => rmSync(parent, { recursive: true, force: true }))

  it('two processes updating the same server never lose a write', async () => {
    const children = ['p1', 'p2'].map((tag) =>
      run(process.execPath, ['--import', 'tsx', fixture, root, 'shared', tag, '20'], {
        cwd: join(here, '..', '..', '..'),
        timeout: 60_000,
      }),
    )
    const results = await Promise.allSettled(children)
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])

    const stored = await createMcpOAuthStore({ root }).read('shared')
    if (stored === null || 'legacy' in stored) throw new Error('no record was stored')
    expect(stored.rev).toBe(40)
    expect(stored.requiredScope).toHaveLength(40)
    expect(new Set(stored.requiredScope).size).toBe(40)
  }, 90_000)
})
