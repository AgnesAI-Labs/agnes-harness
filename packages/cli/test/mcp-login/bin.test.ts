import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/bin.js'
import type { ParsedArgs } from '../../src/types.js'

const seen = vi.hoisted(() => ({ booted: [] as (string | undefined)[], calls: [] as string[] }))
vi.mock('../../src/boot/default.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/boot/default.js')>()
  const { fakeDaemon } = await import('./fake-daemon.js')
  return {
    ...actual,
    bootDefault: vi.fn(async (p: ParsedArgs) => {
      seen.booted.push(p.profile)
      const daemon = fakeDaemon()
      return {
        client: daemon.client,
        profileName: p.profile ?? 'local-dev',
        close: async () => {
          seen.calls.push(...daemon.calls.map(([name, params]) => `${name} ${String(params.profile)}`))
        },
      }
    }),
  }
})

const homes: string[] = []
afterEach(() => {
  seen.booted.length = 0
  seen.calls.length = 0
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('agh mcp logout through the command line', () => {
  it('is handled before the generic MCP resource commands, on the booted profile', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agh-mcp-login-'))
    homes.push(home)
    const stdout = new PassThrough()
    let text = ''
    stdout.on('data', (chunk) => {
      text += String(chunk)
    })
    const code = await main(['mcp', 'logout', 'docs', '--profile', 'work'], {
      env: { AGH_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr: new PassThrough(),
      cwd: home,
      agnesVersion: '0',
    })
    expect(code).toBe(0)
    expect(text).toBe('Signed out of docs.\n')
    expect(seen.booted).toEqual(['work'])
    expect(seen.calls).toEqual([
      'mcp.servers.get work',
      '_agnes/v1/admin.mcp.oauth.logout work',
      'mcp.servers.oauth.signOut work',
    ])
  })
})
