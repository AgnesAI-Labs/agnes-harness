import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runMcpLoginCommand } from '../../src/mcp-login/command.js'
import {
  browserReturning,
  type FakeDaemonOptions,
  fakeAuthorizationServer,
  fakeDaemon,
} from './fake-daemon.js'

function stream(tty: boolean) {
  const out = new PassThrough() as PassThrough & { isTTY?: boolean; text(): string }
  if (tty) out.isTTY = true
  let text = ''
  out.on('data', (chunk) => {
    text += String(chunk)
  })
  out.text = () => text
  return out
}

function command(
  action: 'login' | 'logout',
  args: string[],
  options: { tty?: boolean; daemon?: FakeDaemonOptions; open?: (url: string) => void } = {},
) {
  const daemon = fakeDaemon(options.daemon)
  const io = { stdin: stream(!!options.tty), stdout: stream(!!options.tty), stderr: stream(!!options.tty) }
  const booted: (string | undefined)[] = []
  const exit = runMcpLoginCommand({
    action,
    args,
    io,
    boot: async (profile) => {
      booted.push(profile)
      return { client: daemon.client, profileName: profile ?? 'local-dev', close: async () => undefined }
    },
    fetchImpl: fakeAuthorizationServer().fetchImpl,
    openBrowser: options.open ?? browserReturning('code-1').open,
  })
  return { daemon, io, exit, booted }
}

describe('agh mcp login and logout', () => {
  it('non-interactive: waits for the callback only and prints the SSH hint', async () => {
    const t = command('login', ['docs'])
    expect(await t.exit).toBe(0)
    const stdout = t.io.stdout.text()
    expect(stdout).toContain('https://auth.example.test/authorize?')
    expect(stdout).toContain('Signed in to docs.')
    const port = /redirect_uri=http%3A%2F%2Flocalhost%3A(\d+)%2Fcallback/.exec(stdout)?.[1]
    expect(port).toBeDefined()
    const stderr = t.io.stderr.text()
    expect(stderr).toContain(`ssh -L ${port}:localhost:${port}`)
    expect(stderr).toContain('ssh -t')
    expect(stderr).not.toContain('Paste')
  })

  it('interactive: a pasted address on stdin completes the sign-in', async () => {
    const t = command('login', ['docs', '--profile', 'work'], { tty: true, open: () => undefined })
    while (!t.io.stdout.text().includes('authorize?')) await new Promise((resolve) => setTimeout(resolve, 5))
    const url = new URL(
      /https:\/\/auth\.example\.test\/authorize\?\S+/.exec(t.io.stdout.text())?.[0] as string,
    )
    const pasted = `${url.searchParams.get('redirect_uri')}?code=pasted&state=${url.searchParams.get('state')}`
    t.io.stdin.write(`${pasted}\n`)
    expect(await t.exit).toBe(0)
    expect(t.booted).toEqual(['work'])
    expect(t.io.stderr.text()).toContain('paste the address it ends on here')
    expect(t.daemon.params('_agnes/v1/admin.mcp.oauth.complete')).toMatchObject({
      profile: 'work',
      code: 'pasted',
    })
  })

  it('reports a reconnect failure without hiding the saved sign-in', async () => {
    const t = command('login', ['docs'], { daemon: { reconnect: 'failed' } })
    expect(await t.exit).toBe(1)
    expect(t.io.stdout.text()).toContain('Signed in to docs.')
    expect(t.io.stderr.text()).toContain(
      'The sign-in is saved, but reconnecting docs failed: could not connect',
    )
  })

  it('an already valid sign-in says so', async () => {
    const t = command('login', ['docs'], {
      daemon: { summary: { signedIn: true, refreshable: true }, refresh: { signedIn: true } },
    })
    expect(await t.exit).toBe(0)
    expect(t.io.stdout.text()).toBe('Already signed in to docs.\n')
  })

  it('a refusal is one plain sentence', async () => {
    const t = command('login', ['docs'], {
      daemon: {
        completeError: { data: { code: 'SEMANTIC_REJECTED', reason: 'MCP_OAUTH_LOGIN_SUPERSEDED' } },
      },
    })
    expect(await t.exit).toBe(1)
    expect(t.io.stderr.text()).toContain(
      'agh mcp login: "docs" was signed out during sign-in; run the command again\n',
    )
  })

  it('logout signs out', async () => {
    const t = command('logout', ['docs'])
    expect(await t.exit).toBe(0)
    expect(t.io.stdout.text()).toBe('Signed out of docs.\n')
    expect(t.daemon.names()).toEqual([
      'mcp.servers.get',
      '_agnes/v1/admin.mcp.oauth.logout',
      'mcp.servers.oauth.signOut',
    ])
  })

  it.each([[[]], [['docs', 'extra']], [['docs', '--yes']], [['Bad id']]])(
    'refuses arguments %j',
    async (args) => {
      const t = command('login', args)
      await expect(t.exit).rejects.toThrow(/usage: agh mcp login <serverId> \[--profile <name>\]|server id/)
      expect(t.booted).toEqual([])
    },
  )
})
